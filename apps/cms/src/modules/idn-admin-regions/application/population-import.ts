/**
 * Import pipeline for the Kepmendagri population and area figures (awcms-one
 * ADR-0053, superseding ADR-0051's BPS pipeline). Runs as the `awcms_worker`
 * role from `bun run idn-population:import`, never from a request: the source is
 * two vendored repo files, read offline, not an upload or a download.
 *
 * Same shape as `dataset-import.ts`: `plan…` reads, verifies and validates and
 * touches no database write; `commit…` takes that exact plan and writes it in one
 * transaction. The dry run and the real run are one code path.
 *
 * ## Provenance is checked, not trusted — before a figure is read
 *
 * `data/idn-admin-regions/manifest.json` and `checksums.sha256` record the
 * sha256 and size of both files. The plan recomputes them from the bytes on
 * disk and REFUSES on any disagreement, and it refuses when a file's header no
 * longer cites the decree (or, for the area file, BIG's letter) the dataset row
 * would claim. A refusal records nothing: a file that disagrees with its own
 * record is an operator/vendoring mistake, not a data-quality finding.
 *
 * ## Validation failures are recorded
 *
 * Files that verify but fail validation are recorded as a `rejected` dataset
 * row carrying the problems, with zero statistics rows, so the failure is
 * visible in the database and not only in one shell's output.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseValueDump } from "../domain/population-dump-parser";
import {
  AREA_DUMP_EXPECTATION,
  AREA_FILE_PATH,
  AREA_LETTER_NUMBER,
  AREA_REFERENCE_YEAR,
  AREA_SOURCE_REFERENCE,
  AREA_SOURCE_TABLE,
  derivePopulationDatasetCode,
  foldWhitespace,
  headerCites,
  POPULATION_ATTRIBUTION,
  POPULATION_CHECKSUMS_PATH,
  POPULATION_COVERAGE_REGION_CODE,
  POPULATION_COVERAGE_REGION_LEVEL,
  POPULATION_DATA_DIR,
  POPULATION_DECREE_REFERENCE,
  POPULATION_DUMP_EXPECTATION,
  POPULATION_FILE_PATH,
  POPULATION_IMPORTED_BY,
  POPULATION_PUBLICATION_SERIES,
  POPULATION_PUBLICATION_TITLE,
  POPULATION_PUBLICATION_YEAR,
  POPULATION_PUBLISHER_NAME,
  POPULATION_REFERENCE_YEAR,
  POPULATION_SOURCE_TABLE,
  POPULATION_SOURCE_TYPE,
  POPULATION_TERMS_OF_USE,
  populationPublicationUrl,
  readAreaRows,
  readPopulationRows
} from "../domain/population-source";
import {
  buildPopulationFigures,
  type PopulationFigure,
  type PopulationValidationReport,
  type RegionFact
} from "../domain/population-validation";
import { IDN_ADMIN_REGIONS_SOURCE_REPOSITORY } from "../domain/source-provenance";

const INSERT_BATCH_SIZE = 5000;
/** Validation errors kept in `validation_summary` and shown by the CLI. */
const ERROR_SAMPLE_LIMIT = 50;

/** The provenance of one source file, as stored in `source_files`. */
export type PopulationSourceFile = {
  role: "population" | "area";
  path: string;
  sha256: string;
  bytes: number;
  upstreamRepository: string;
  upstreamCommit: string;
  upstreamLastEdit: string | null;
  /** Who the figures this file supplied belong to. */
  origin: string;
  /** The decree the file's region codes follow. */
  codesFollow: string;
  /** The dimensions this file supplied. */
  figures: string[];
};

/** Both files, verified, with their text. */
export type VerifiedPopulationSources = {
  upstreamCommit: string;
  files: { population: PopulationSourceFile; area: PopulationSourceFile };
  text: { population: string; area: string };
};

/** The active region dataset the codes are validated against. */
export type ActiveRegionDataset = {
  regionDatasetId: string;
  datasetCode: string;
  /** `source_reference` of the region dataset (the decree its file cites), or null. */
  decreeReference: string | null;
  /** Level-1/2 regions only. */
  regions: Map<string, RegionFact>;
};

export type PopulationImportPlan = {
  datasetCode: string;
  sources: PopulationSourceFile[];
  upstreamCommit: string;
  rows: PopulationFigure[];
  /** Blocking problems. Non-empty: record a rejection, write no statistics. */
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
  /** True when a `rejected` row of the same code was promoted rather than a new row inserted. */
  promotedFromRejected: boolean;
};

export type PopulationRejectionResult = {
  datasetId: string;
  datasetCode: string;
  status: "rejected";
  inserted: boolean;
};

/** The files could not be used at all (missing, or disagreeing with their record). Nothing is recorded. */
export class PopulationImportError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = []
  ) {
    super(message);
    this.name = "PopulationImportError";
  }
}

/** The same bytes are already imported (and not as a rejection). Re-importing is a no-op. */
export class PopulationAlreadyImportedError extends Error {
  constructor(
    readonly datasetCode: string,
    readonly status: string
  ) {
    super(
      `dataset ${datasetCode} is already imported (status ${status}) — nothing to do (re-importing identical bytes is a no-op by design).`
    );
    this.name = "PopulationAlreadyImportedError";
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type ManifestEntry = {
  path?: unknown;
  sha256?: unknown;
  bytes?: unknown;
  importedBy?: unknown;
  decreeReference?: unknown;
  upstreamLastEdit?: unknown;
};

/**
 * Reads both files and verifies them against `manifest.json` AND
 * `checksums.sha256` (sha256 and size), checks the manifest marks them as read
 * by this importer, and checks each header still cites the decree (and, for
 * the area file, BIG's letter). Every problem is collected; any problem refuses.
 */
export async function readPopulationSources(
  rootDir: string = process.cwd()
): Promise<VerifiedPopulationSources> {
  const dataDir = path.join(rootDir, POPULATION_DATA_DIR);
  const problems: string[] = [];

  let manifest: {
    upstream?: { repository?: unknown; commit?: unknown };
    files?: ManifestEntry[];
  };
  let checksumsText: string;
  try {
    manifest = JSON.parse(
      await readFile(path.join(dataDir, "manifest.json"), "utf8")
    );
    checksumsText = await readFile(
      path.join(dataDir, POPULATION_CHECKSUMS_PATH),
      "utf8"
    );
  } catch {
    throw new PopulationImportError(
      `${POPULATION_DATA_DIR}/manifest.json and ${POPULATION_DATA_DIR}/${POPULATION_CHECKSUMS_PATH} must both exist and the manifest must be valid JSON.`
    );
  }

  const upstreamCommit =
    typeof manifest.upstream?.commit === "string"
      ? manifest.upstream.commit
      : "";
  if (!/^[0-9a-f]{40}$/.test(upstreamCommit)) {
    problems.push("manifest.json upstream.commit must be a 40-hex commit sha.");
  }
  if (manifest.upstream?.repository !== IDN_ADMIN_REGIONS_SOURCE_REPOSITORY) {
    problems.push(
      `manifest.json upstream.repository must be ${IDN_ADMIN_REGIONS_SOURCE_REPOSITORY}.`
    );
  }

  const checksumDir = path.posix.dirname(POPULATION_CHECKSUMS_PATH);
  const recorded = new Map(
    checksumsText
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [digest, file] = line.trim().split(/\s+/);
        return [`${checksumDir}/${file ?? ""}`, digest ?? ""];
      })
  );

  async function verify(
    filePath: string,
    role: "population" | "area"
  ): Promise<{ file: PopulationSourceFile; text: string } | null> {
    const entry = (manifest.files ?? []).find((f) => f.path === filePath);
    if (!entry) {
      problems.push(`manifest.json has no entry for ${filePath}.`);
      return null;
    }
    if (entry.importedBy !== POPULATION_IMPORTED_BY) {
      problems.push(
        `manifest.json must record importedBy "${POPULATION_IMPORTED_BY}" for ${filePath}.`
      );
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(dataDir, filePath));
    } catch {
      problems.push(`${POPULATION_DATA_DIR}/${filePath} does not exist.`);
      return null;
    }
    const digest = sha256(bytes);
    if (digest !== entry.sha256) {
      problems.push(
        `Checksum mismatch for ${filePath}: manifest.json records ${String(entry.sha256)}, the file on disk is ${digest}.`
      );
    }
    if (recorded.get(filePath) !== digest) {
      problems.push(
        `Checksum mismatch for ${filePath}: checksums.sha256 records ${recorded.get(filePath) ?? "nothing"}, the file on disk is ${digest}.`
      );
    }
    if (entry.bytes !== bytes.byteLength) {
      problems.push(
        `Size mismatch for ${filePath}: manifest.json records ${String(entry.bytes)} bytes, the file on disk is ${bytes.byteLength}.`
      );
    }
    const text = bytes.toString("utf8");
    if (!headerCites(text, POPULATION_DECREE_REFERENCE)) {
      problems.push(
        `${filePath}: its header no longer cites "${POPULATION_DECREE_REFERENCE}".`
      );
    }
    if (
      typeof entry.decreeReference !== "string" ||
      foldWhitespace(entry.decreeReference) !==
        foldWhitespace(POPULATION_DECREE_REFERENCE)
    ) {
      problems.push(
        `manifest.json must record decreeReference "${POPULATION_DECREE_REFERENCE}" for ${filePath}.`
      );
    }
    if (role === "area" && !headerCites(text, AREA_LETTER_NUMBER)) {
      problems.push(
        `${filePath}: its header no longer cites BIG's letter ${AREA_LETTER_NUMBER}.`
      );
    }

    return {
      file: {
        role,
        path: filePath,
        sha256: digest,
        bytes: bytes.byteLength,
        upstreamRepository: IDN_ADMIN_REGIONS_SOURCE_REPOSITORY,
        upstreamCommit,
        upstreamLastEdit:
          typeof entry.upstreamLastEdit === "string"
            ? entry.upstreamLastEdit
            : null,
        origin:
          role === "population"
            ? POPULATION_DECREE_REFERENCE
            : AREA_SOURCE_REFERENCE,
        codesFollow: POPULATION_DECREE_REFERENCE,
        figures: role === "population" ? ["total", "sex"] : ["area"]
      },
      text
    };
  }

  const population = await verify(POPULATION_FILE_PATH, "population");
  const area = await verify(AREA_FILE_PATH, "area");

  if (problems.length > 0 || !population || !area) {
    throw new PopulationImportError(
      "The vendored population/area files disagree with their provenance record; nothing was read or recorded.",
      problems
    );
  }

  return {
    upstreamCommit,
    files: { population: population.file, area: area.file },
    text: { population: population.text, area: area.text }
  };
}

/** The active region dataset: its id, decree and level-1/2 regions. */
export async function loadActiveRegionDataset(
  sql: Bun.SQL | Bun.TransactionSQL
): Promise<ActiveRegionDataset> {
  const active = (await sql`
    SELECT id, dataset_code, source_reference
    FROM awcms_idn_region_datasets WHERE status = 'active' LIMIT 1
  `) as { id: string; dataset_code: string; source_reference: string | null }[];
  const dataset = active[0];
  if (!dataset) {
    throw new PopulationImportError(
      "There is no ACTIVE region dataset to validate region codes against. Import and activate one first (`bun run idn-regions:import`, `bun run idn-regions:activate`)."
    );
  }
  const regions = (await sql`
    SELECT code, level, official_name FROM awcms_idn_admin_regions
    WHERE dataset_id = ${dataset.id} AND level <= 2
  `) as { code: string; level: number; official_name: string }[];
  return {
    regionDatasetId: dataset.id,
    datasetCode: dataset.dataset_code,
    decreeReference: dataset.source_reference,
    regions: new Map(
      regions.map((region) => [
        region.code,
        { level: Number(region.level), name: region.official_name }
      ])
    )
  };
}

/** Parses, maps and validates verified sources against a region dataset. Touches no database. */
export function planPopulationImport(
  sources: VerifiedPopulationSources,
  regionDataset: ActiveRegionDataset
): PopulationImportPlan {
  const errors: string[] = [];

  if (
    regionDataset.decreeReference === null ||
    foldWhitespace(regionDataset.decreeReference) !==
      foldWhitespace(POPULATION_DECREE_REFERENCE)
  ) {
    errors.push(
      `The active region dataset ${regionDataset.datasetCode} cites ${regionDataset.decreeReference === null ? "no decree" : `"${regionDataset.decreeReference}"`}; the population and area files cite "${POPULATION_DECREE_REFERENCE}". Their codes are only comparable under the same decree.`
    );
  }

  const populationDump = parseValueDump(
    sources.text.population,
    POPULATION_DUMP_EXPECTATION
  );
  const areaDump = parseValueDump(sources.text.area, AREA_DUMP_EXPECTATION);
  for (const [table, dump] of [
    [POPULATION_SOURCE_TABLE, populationDump],
    [AREA_SOURCE_TABLE, areaDump]
  ] as const) {
    for (const problem of dump.unparsed) {
      errors.push(
        `${table} line ${problem.lineNumber}: ${problem.reason}${problem.content ? `: ${problem.content.slice(0, 120)}` : ""}`
      );
    }
    if (dump.tuples.length === 0 && dump.unparsed.length === 0) {
      errors.push(`${table} has no data rows.`);
    }
  }

  const populationRows = readPopulationRows(populationDump);
  const areaRows = readAreaRows(areaDump);
  errors.push(
    ...populationRows.errors.map((e) => `${POPULATION_SOURCE_TABLE} ${e}`),
    ...areaRows.errors.map((e) => `${AREA_SOURCE_TABLE} ${e}`)
  );

  const validation = buildPopulationFigures({
    population: {
      rows: populationRows.rows,
      sourceTable: POPULATION_SOURCE_TABLE,
      referenceYear: POPULATION_REFERENCE_YEAR
    },
    area: {
      rows: areaRows.rows,
      sourceTable: AREA_SOURCE_TABLE,
      referenceYear: AREA_REFERENCE_YEAR
    },
    regions: regionDataset.regions
  });
  errors.push(...validation.errors);

  return {
    datasetCode: derivePopulationDatasetCode(
      sources.files.population.sha256,
      sources.files.area.sha256
    ),
    sources: [sources.files.population, sources.files.area],
    upstreamCommit: sources.upstreamCommit,
    rows: validation.rows,
    errors,
    report: validation.report,
    regionDatasetId: regionDataset.regionDatasetId
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

function rowHash(row: PopulationFigure): string {
  return createHash("sha256")
    .update(
      [
        row.sourceTable,
        row.regionCode,
        row.dimension,
        row.category,
        row.value,
        row.unit,
        row.referenceYear,
        row.universe
      ].join("|")
    )
    .digest("hex");
}

/**
 * Writes one plan as a dataset (`validated`, never `active`) and all its
 * figures, in the caller's transaction. Refuses a plan that failed validation.
 *
 * A dataset code that already exists is refused with
 * {@link PopulationAlreadyImportedError} — identical bytes are a no-op — with
 * one exception: a `rejected` row of the same code (the same bytes failed
 * against an earlier region dataset) is PROMOTED to `validated`, keeping the
 * earlier rejection inside `validation_summary.previousRejection`. The worker
 * holds no DELETE, so without this an operator could never import those bytes
 * once the region dataset was fixed.
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

  const written = (await tx`
    INSERT INTO awcms_idn_population_datasets
      (dataset_code, source_type, publication_series, coverage_region_code,
       coverage_region_level, publication_title, publisher_name,
       publisher_website, attribution, publication_year, publication_url,
       source_files, terms_of_use, region_dataset_id, row_count, status,
       validation_summary, created_by)
    VALUES
      (${plan.datasetCode}, ${POPULATION_SOURCE_TYPE},
       ${POPULATION_PUBLICATION_SERIES}, ${POPULATION_COVERAGE_REGION_CODE},
       ${POPULATION_COVERAGE_REGION_LEVEL}, ${POPULATION_PUBLICATION_TITLE},
       ${POPULATION_PUBLISHER_NAME}, NULL, ${POPULATION_ATTRIBUTION},
       ${POPULATION_PUBLICATION_YEAR},
       ${populationPublicationUrl(plan.upstreamCommit)},
       ${plan.sources}::jsonb, ${POPULATION_TERMS_OF_USE},
       ${plan.regionDatasetId}, ${plan.rows.length}, 'validated',
       ${summaryOf(plan)}::jsonb, ${options.importedBy ?? null})
    ON CONFLICT (dataset_code) DO UPDATE
      SET source_files = EXCLUDED.source_files,
          region_dataset_id = EXCLUDED.region_dataset_id,
          row_count = EXCLUDED.row_count,
          status = 'validated',
          validation_summary = EXCLUDED.validation_summary
            || jsonb_build_object(
                 'previousRejection',
                 awcms_idn_population_datasets.validation_summary
               ),
          created_at = now(),
          created_by = EXCLUDED.created_by
      WHERE awcms_idn_population_datasets.status = 'rejected'
    RETURNING id, (xmax = 0) AS inserted
  `) as { id: string; inserted: boolean }[];

  const row = written[0];
  if (!row) {
    const existing = (await tx`
      SELECT status FROM awcms_idn_population_datasets
      WHERE dataset_code = ${plan.datasetCode}
    `) as { status: string }[];
    throw new PopulationAlreadyImportedError(
      plan.datasetCode,
      existing[0]?.status ?? "unknown"
    );
  }

  for (let offset = 0; offset < plan.rows.length; offset += INSERT_BATCH_SIZE) {
    const chunk = plan.rows.slice(offset, offset + INSERT_BATCH_SIZE);
    const text = (pick: (figure: PopulationFigure) => string) =>
      tx.array(chunk.map(pick), "text");

    await tx`
      INSERT INTO awcms_idn_population_stats
        (dataset_id, region_code, region_level, source_region_name, dimension,
         category, sex, value, unit, reference_year, figure_basis, universe,
         source_table, source_row_hash)
      SELECT ${row.id}, t.region_code, t.region_level::smallint,
             t.source_region_name, t.dimension, t.category, NULL,
             t.value::numeric(14, 3), t.unit, t.reference_year::smallint,
             t.figure_basis, t.universe, t.source_table, t.source_row_hash
      FROM unnest(
        ${text((r) => r.regionCode)},
        ${text((r) => String(r.regionLevel))},
        ${text((r) => r.sourceRegionName)},
        ${text((r) => r.dimension)},
        ${text((r) => r.category)},
        ${text((r) => r.value)},
        ${text((r) => r.unit)},
        ${text((r) => String(r.referenceYear))},
        ${text((r) => r.figureBasis)},
        ${text((r) => r.universe)},
        ${text((r) => r.sourceTable)},
        ${text(rowHash)}
      ) AS t(region_code, region_level, source_region_name, dimension,
             category, value, unit, reference_year, figure_basis, universe,
             source_table, source_row_hash)
    `;
  }

  return {
    datasetId: row.id,
    datasetCode: plan.datasetCode,
    rowCount: plan.rows.length,
    status: "validated",
    promotedFromRejected: !row.inserted
  };
}

/**
 * Records a FAILED validation as a `rejected` dataset row with the summary and
 * zero statistics rows. Takes the plain pooled client on purpose, exactly like
 * `recordRejectedImport` in dataset-import.ts: the row must commit by itself,
 * never inside a transaction that is about to be abandoned. Re-running the same
 * bad files refreshes the summary instead of colliding.
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

  const rows = (await sql`
    INSERT INTO awcms_idn_population_datasets
      (dataset_code, source_type, publication_series, coverage_region_code,
       coverage_region_level, publication_title, publisher_name,
       publisher_website, attribution, publication_year, publication_url,
       source_files, terms_of_use, region_dataset_id, row_count, status,
       validation_summary, created_by)
    VALUES
      (${plan.datasetCode}, ${POPULATION_SOURCE_TYPE},
       ${POPULATION_PUBLICATION_SERIES}, ${POPULATION_COVERAGE_REGION_CODE},
       ${POPULATION_COVERAGE_REGION_LEVEL}, ${POPULATION_PUBLICATION_TITLE},
       ${POPULATION_PUBLISHER_NAME}, NULL, ${POPULATION_ATTRIBUTION},
       ${POPULATION_PUBLICATION_YEAR},
       ${populationPublicationUrl(plan.upstreamCommit)},
       ${plan.sources}::jsonb, ${POPULATION_TERMS_OF_USE},
       ${plan.regionDatasetId}, 0, 'rejected', ${summaryOf(plan)}::jsonb,
       ${options.importedBy ?? null})
    ON CONFLICT (dataset_code) DO UPDATE
      SET validation_summary = EXCLUDED.validation_summary,
          region_dataset_id = EXCLUDED.region_dataset_id,
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
    WHERE dataset_code = ${plan.datasetCode}
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

/** The status of a dataset code already present in the database, or null. */
export async function findPopulationDatasetStatus(
  sql: Bun.SQL | Bun.TransactionSQL,
  datasetCode: string
): Promise<string | null> {
  const rows = (await sql`
    SELECT status FROM awcms_idn_population_datasets
    WHERE dataset_code = ${datasetCode}
  `) as { status: string }[];
  return rows[0]?.status ?? null;
}
