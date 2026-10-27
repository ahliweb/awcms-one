/**
 * Import pipeline for BPS population statistics (awcms-one ADR-0051). Runs as
 * the `awcms_worker` role from `bun run idn-population:import`, never from a
 * request: the source is a repo file pair (manifest JSON + extracted CSV), not an
 * upload.
 *
 * Same shape as `dataset-import.ts`: `plan…` reads, checks and validates and
 * touches no database write; `commit…` takes that exact plan and writes it in one
 * transaction. The dry run and the real run are one code path.
 *
 * ## Provenance is checked, not trusted
 *
 * The manifest records the sha256 of the CSV. If the bytes on disk differ, the
 * dataset's recorded origin would be fiction, so the plan REFUSES (it does not
 * write a `rejected` row: a manifest that disagrees with its own file is an
 * operator/extraction mistake, not a data-quality finding about the publication).
 *
 * ## Validation failures are recorded
 *
 * A CSV that parses but fails validation is recorded as its own `rejected`
 * dataset row carrying the problems, with zero statistics rows — so the failure
 * is visible in the database, not only in one shell's output.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parsePopulationCsv } from "../domain/population-csv";
import {
  parsePopulationManifest,
  type PopulationDatasetManifest
} from "../domain/population-manifest";
import {
  validatePopulationRecords,
  type PopulationRow,
  type PopulationValidationReport
} from "../domain/population-validation";

/** Where the dataset pairs live, relative to `apps/cms`. */
export const IDN_POPULATION_DATASETS_DIR = "data/idn-population/datasets";

const INSERT_BATCH_SIZE = 5000;
/** Sentinel for SQL NULL inside `tx.array(...)` — see dataset-import.ts for why. */
const NULL_SENTINEL = "";
/** Validation errors kept in `validation_summary` and shown by the CLI. */
const ERROR_SAMPLE_LIMIT = 50;

export type PopulationImportPlan = {
  manifest: PopulationDatasetManifest;
  csvPath: string;
  csvSha256: string;
  rows: PopulationRow[];
  /** Blocking validation problems. Non-empty: record a rejection, write no statistics. */
  errors: string[];
  report: PopulationValidationReport;
  regionDatasetId: string;
};

/** What lands in `awcms_idn_population_datasets.validation_summary`. */
export type PopulationValidationSummary = PopulationValidationReport & {
  errorCount: number;
  errors: string[];
  parsedAt: string;
};

export type PopulationImportResult = {
  datasetId: string;
  datasetCode: string;
  rowCount: number;
  status: "validated";
};

export type PopulationRejectionResult = {
  datasetId: string;
  datasetCode: string;
  status: "rejected";
  inserted: boolean;
};

/** The manifest could not be used at all (missing, malformed, or disagreeing with its CSV). Nothing is recorded. */
export class PopulationImportError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = []
  ) {
    super(message);
    this.name = "PopulationImportError";
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Dataset codes that have a `<code>.json` + `<code>.csv` pair under `datasetsDir`, sorted. */
export async function listPendingDatasetCodes(
  rootDir: string = process.cwd()
): Promise<string[]> {
  const entries = await readdir(
    path.join(rootDir, IDN_POPULATION_DATASETS_DIR)
  );
  const json = new Set(
    entries.filter((name) => name.endsWith(".json")).map((n) => n.slice(0, -5))
  );
  return entries
    .filter((name) => name.endsWith(".csv"))
    .map((name) => name.slice(0, -4))
    .filter((code) => json.has(code))
    .sort();
}

/** The active region dataset's id and a code -> level map of its regions. */
export async function loadActiveRegionLevels(
  sql: Bun.SQL | Bun.TransactionSQL
): Promise<{ regionDatasetId: string; levels: Map<string, number> }> {
  const active = (await sql`
    SELECT id FROM awcms_idn_region_datasets WHERE status = 'active' LIMIT 1
  `) as { id: string }[];
  const regionDatasetId = active[0]?.id;
  if (!regionDatasetId) {
    throw new PopulationImportError(
      "There is no ACTIVE region dataset to validate region codes against. Import and activate one first (`bun run idn-regions:import`, `bun run idn-regions:activate`)."
    );
  }
  const regions = (await sql`
    SELECT code, level FROM awcms_idn_admin_regions WHERE dataset_id = ${regionDatasetId}
  `) as { code: string; level: number }[];
  return {
    regionDatasetId,
    levels: new Map(
      regions.map((region) => [region.code, Number(region.level)])
    )
  };
}

/** Reads the pair, verifies the checksum, parses and validates. Touches no database. */
export async function planPopulationImport(options: {
  datasetCode: string;
  regionDatasetId: string;
  regionLevels: ReadonlyMap<string, number>;
  rootDir?: string;
}): Promise<PopulationImportPlan> {
  const rootDir = options.rootDir ?? process.cwd();
  const base = path.join(
    rootDir,
    IDN_POPULATION_DATASETS_DIR,
    options.datasetCode
  );

  let manifestText: string;
  let csvBytes: Buffer;
  try {
    manifestText = await readFile(`${base}.json`, "utf8");
    csvBytes = await readFile(`${base}.csv`);
  } catch {
    throw new PopulationImportError(
      `Dataset ${options.datasetCode}: ${IDN_POPULATION_DATASETS_DIR}/${options.datasetCode}.json and .csv must both exist.`
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestText);
  } catch {
    throw new PopulationImportError(
      `Dataset ${options.datasetCode}: the manifest is not valid JSON.`
    );
  }

  const parsedManifest = parsePopulationManifest(decoded);
  if (!parsedManifest.ok) {
    throw new PopulationImportError(
      `Dataset ${options.datasetCode}: the manifest is invalid.`,
      parsedManifest.errors
    );
  }
  const manifest = parsedManifest.manifest;

  const problems: string[] = [];
  if (manifest.datasetCode !== options.datasetCode) {
    problems.push(
      `datasetCode "${manifest.datasetCode}" does not match the file name "${options.datasetCode}".`
    );
  }
  if (
    manifest.csvPath !== null &&
    path.basename(manifest.csvPath) !== `${options.datasetCode}.csv`
  ) {
    problems.push(
      `csvPath "${manifest.csvPath}" does not name ${options.datasetCode}.csv.`
    );
  }
  const csvSha256 = sha256(csvBytes);
  if (csvSha256 !== manifest.csvSha256) {
    problems.push(
      `Checksum mismatch for ${options.datasetCode}.csv: the manifest records ${manifest.csvSha256}, the file on disk is ${csvSha256}.`
    );
  }
  if (problems.length > 0) {
    throw new PopulationImportError(
      `Dataset ${options.datasetCode}: the manifest and its CSV disagree.`,
      problems
    );
  }

  const parsed = parsePopulationCsv(csvBytes.toString("utf8"));
  const validation = validatePopulationRecords(parsed.records, {
    regionLevels: options.regionLevels,
    coverageRegionCode: manifest.coverageRegionCode
  });

  const errors = [...parsed.errors, ...validation.errors];
  if (parsed.errors.length === 0 && parsed.records.length === 0) {
    errors.push("The CSV has a header but no data rows.");
  }

  return {
    manifest,
    csvPath: `${IDN_POPULATION_DATASETS_DIR}/${options.datasetCode}.csv`,
    csvSha256,
    rows: validation.rows,
    errors,
    report: validation.report,
    regionDatasetId: options.regionDatasetId
  };
}

function summaryOf(plan: PopulationImportPlan): PopulationValidationSummary {
  return {
    ...plan.report,
    errorCount: plan.errors.length,
    errors: plan.errors.slice(0, ERROR_SAMPLE_LIMIT),
    parsedAt: new Date().toISOString()
  };
}

/**
 * Writes one plan as a new dataset (`validated`, never `active`) and all its
 * statistics rows, in the caller's transaction. Refuses a plan that failed
 * validation, and a dataset code that is already present (the unique index
 * answers that, and the caller reports it).
 */
export async function commitPopulationImport(
  tx: Bun.TransactionSQL,
  plan: PopulationImportPlan,
  options: { importedBy?: string | null } = {}
): Promise<PopulationImportResult> {
  if (plan.errors.length > 0) {
    throw new PopulationImportError(
      "Refusing to import a dataset that failed validation.",
      plan.errors
    );
  }
  const m = plan.manifest;

  const inserted = (await tx`
    INSERT INTO awcms_idn_population_datasets
      (dataset_code, publication_series, coverage_region_code,
       coverage_region_level, publication_title, publisher_name,
       publisher_domain, publisher_website, attribution, catalogue_number,
       publication_number, issn, publication_year, release_date,
       publication_url, source_file_sha256, source_file_bytes, csv_sha256,
       terms_of_use, region_dataset_id, row_count, status, validation_summary,
       created_by)
    VALUES
      (${m.datasetCode}, ${m.publicationSeries}, ${m.coverageRegionCode},
       ${m.coverageRegionLevel}, ${m.publicationTitle}, ${m.publisherName},
       ${m.publisherDomain}, ${m.publisherWebsite}, ${m.attribution},
       ${m.catalogueNumber}, ${m.publicationNumber}, ${m.issn},
       ${m.publicationYear}, ${m.releaseDate}, ${m.publicationUrl},
       ${m.sourceFileSha256}, ${m.sourceFileBytes}, ${plan.csvSha256},
       ${m.termsOfUse}, ${plan.regionDatasetId}, ${plan.rows.length},
       'validated', ${summaryOf(plan)}, ${options.importedBy ?? null})
    RETURNING id
  `) as { id: string }[];

  const datasetId = inserted[0]?.id;
  if (!datasetId) {
    throw new PopulationImportError("Dataset row insert returned no id.");
  }

  for (let offset = 0; offset < plan.rows.length; offset += INSERT_BATCH_SIZE) {
    const chunk = plan.rows.slice(offset, offset + INSERT_BATCH_SIZE);
    const text = (pick: (row: PopulationRow) => string) =>
      tx.array(chunk.map(pick), "text");

    await tx`
      INSERT INTO awcms_idn_population_stats
        (dataset_id, region_code, region_level, source_region_name, dimension,
         category, sex, value, unit, reference_year, figure_basis, universe,
         source_table, source_page, value_note, category_label,
             source_row_hash)
      SELECT ${datasetId}, t.region_code, t.region_level::smallint,
             t.source_region_name, t.dimension, t.category,
             NULLIF(t.sex, ''), t.value::numeric(14, 2), t.unit,
             t.reference_year::smallint, t.figure_basis, t.universe,
             t.source_table, NULLIF(t.source_page, '')::integer,
             NULLIF(t.value_note, ''), NULLIF(t.category_label, ''),
             t.source_row_hash
      FROM unnest(
        ${text((r) => r.regionCode)},
        ${text((r) => String(r.regionLevel))},
        ${text((r) => r.sourceRegionName)},
        ${text((r) => r.dimension)},
        ${text((r) => r.category)},
        ${text((r) => r.sex ?? NULL_SENTINEL)},
        ${text((r) => r.value)},
        ${text((r) => r.unit)},
        ${text((r) => String(r.referenceYear))},
        ${text((r) => r.figureBasis)},
        ${text((r) => r.universe)},
        ${text((r) => r.sourceTable)},
        ${text((r) => (r.sourcePage === null ? NULL_SENTINEL : String(r.sourcePage)))},
        ${text((r) => r.valueNote ?? NULL_SENTINEL)},
        ${text((r) => r.categoryLabel ?? NULL_SENTINEL)},
        ${text((r) =>
          createHash("sha256")
            .update(
              [
                r.regionCode,
                r.dimension,
                r.category,
                r.sex ?? "",
                r.value,
                r.unit,
                r.referenceYear,
                r.universe
              ].join("|")
            )
            .digest("hex")
        )}
      ) AS t(region_code, region_level, source_region_name, dimension,
             category, sex, value, unit, reference_year, figure_basis, universe,
             source_table, source_page, value_note, category_label,
             source_row_hash)
    `;
  }

  return {
    datasetId,
    datasetCode: m.datasetCode,
    rowCount: plan.rows.length,
    status: "validated"
  };
}

/**
 * Records a FAILED validation as a `rejected` dataset row with the summary and
 * zero statistics rows. Takes the plain pooled client on purpose, exactly like
 * `recordRejectedImport` in dataset-import.ts: the row must commit by itself,
 * never inside a transaction that is about to be abandoned. Re-running the same
 * bad CSV refreshes the summary instead of colliding.
 */
export async function recordRejectedPopulationImport(
  sql: Bun.SQL,
  plan: PopulationImportPlan,
  options: { importedBy?: string | null } = {}
): Promise<PopulationRejectionResult> {
  if (plan.errors.length === 0) {
    throw new Error(
      "recordRejectedPopulationImport called with a plan that passed validation — call commitPopulationImport instead."
    );
  }
  const m = plan.manifest;
  const summary = summaryOf(plan);

  const rows = (await sql`
    INSERT INTO awcms_idn_population_datasets
      (dataset_code, publication_series, coverage_region_code,
       coverage_region_level, publication_title, publisher_name,
       publisher_domain, publisher_website, attribution, catalogue_number,
       publication_number, issn, publication_year, release_date,
       publication_url, source_file_sha256, source_file_bytes, csv_sha256,
       terms_of_use, region_dataset_id, row_count, status, validation_summary,
       created_by)
    VALUES
      (${m.datasetCode}, ${m.publicationSeries}, ${m.coverageRegionCode},
       ${m.coverageRegionLevel}, ${m.publicationTitle}, ${m.publisherName},
       ${m.publisherDomain}, ${m.publisherWebsite}, ${m.attribution},
       ${m.catalogueNumber}, ${m.publicationNumber}, ${m.issn},
       ${m.publicationYear}, ${m.releaseDate}, ${m.publicationUrl},
       ${m.sourceFileSha256}, ${m.sourceFileBytes}, ${plan.csvSha256},
       ${m.termsOfUse}, ${plan.regionDatasetId}, 0, 'rejected', ${summary},
       ${options.importedBy ?? null})
    ON CONFLICT (dataset_code) DO UPDATE
      SET validation_summary = EXCLUDED.validation_summary,
          csv_sha256 = EXCLUDED.csv_sha256,
          created_at = now()
      WHERE awcms_idn_population_datasets.status = 'rejected'
    RETURNING id, dataset_code, (xmax = 0) AS inserted
  `) as { id: string; dataset_code: string; inserted: boolean }[];

  const row = rows[0];
  if (row) {
    return {
      datasetId: row.id,
      datasetCode: row.dataset_code,
      status: "rejected",
      inserted: row.inserted
    };
  }

  // The existing row is not `rejected` (it was imported in an earlier, passing
  // run). Report it untouched rather than overwrite a good dataset.
  const existing = (await sql`
    SELECT id, dataset_code FROM awcms_idn_population_datasets
    WHERE dataset_code = ${m.datasetCode}
  `) as { id: string; dataset_code: string }[];
  const found = existing[0];
  if (!found) {
    throw new PopulationImportError(
      "Failed to record the rejected dataset, and no conflicting row was found either."
    );
  }
  return {
    datasetId: found.id,
    datasetCode: found.dataset_code,
    status: "rejected",
    inserted: false
  };
}

/** Dataset codes already present in the database (any status). */
export async function listImportedDatasetCodes(
  sql: Bun.SQL | Bun.TransactionSQL
): Promise<Set<string>> {
  const rows = (await sql`
    SELECT dataset_code FROM awcms_idn_population_datasets
  `) as { dataset_code: string }[];
  return new Set(rows.map((row) => row.dataset_code));
}
