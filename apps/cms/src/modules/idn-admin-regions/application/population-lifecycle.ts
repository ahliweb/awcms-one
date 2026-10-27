/**
 * Activation of BPS population datasets (awcms-one ADR-0051).
 *
 * Differs from `dataset-lifecycle.ts` in one way that matters: region datasets
 * are served ONE at a time, platform-wide, while population datasets are served
 * one per `(publication_series, coverage_region_code)` — a province's
 * publication and each of its regencies' publications are all active together.
 * Activating a dataset therefore supersedes only the active dataset of the SAME
 * series and covered region, never another region's. The partial unique index
 * `awcms_idn_population_datasets_single_active` (sql/882) enforces that in the
 * database; the code below vacates the slot first, inside the same transaction,
 * because the index would otherwise reject the legitimate swap.
 */
import { utcMicrosecondTextSql } from "../../_shared/keyset-pagination";
import type { DatasetStatus } from "./dataset-lifecycle";

export type PopulationDatasetSummary = {
  id: string;
  datasetCode: string;
  status: DatasetStatus;
  publicationSeries: string;
  coverageRegionCode: string;
  publicationTitle: string;
  publicationYear: number;
  rowCount: number;
  csvSha256: string;
  createdAt: string;
  activatedAt: string | null;
};

export class PopulationLifecycleError extends Error {
  constructor(
    message: string,
    readonly code: "DATASET_NOT_FOUND" | "DATASET_NOT_ACTIVATABLE"
  ) {
    super(message);
    this.name = "PopulationLifecycleError";
  }
}

type Row = {
  id: string;
  dataset_code: string;
  status: DatasetStatus;
  publication_series: string;
  coverage_region_code: string;
  publication_title: string;
  publication_year: number;
  row_count: number;
  csv_sha256: string;
  created_at: string;
  activated_at: string | null;
};

// Timestamps are rendered as TEXT, never re-parsed into a JS Date (microsecond
// precision), for the same reason as dataset-lifecycle.ts.
const COLUMNS = `
  id, dataset_code, status, publication_series, coverage_region_code,
  publication_title, publication_year, row_count, csv_sha256,
  ${utcMicrosecondTextSql("created_at", "Z")} AS created_at,
  ${utcMicrosecondTextSql("activated_at", "Z")} AS activated_at
`;

function toSummary(row: Row): PopulationDatasetSummary {
  return {
    id: row.id,
    datasetCode: row.dataset_code,
    status: row.status,
    publicationSeries: row.publication_series,
    coverageRegionCode: row.coverage_region_code,
    publicationTitle: row.publication_title,
    publicationYear: row.publication_year,
    rowCount: row.row_count,
    csvSha256: row.csv_sha256,
    createdAt: row.created_at,
    activatedAt: row.activated_at
  };
}

/** Every population dataset, newest import first. */
export async function listPopulationDatasets(
  sql: Bun.SQL | Bun.TransactionSQL
): Promise<PopulationDatasetSummary[]> {
  const rows = (await sql.unsafe(`
    SELECT ${COLUMNS} FROM awcms_idn_population_datasets
    ORDER BY created_at DESC, id DESC
  `)) as Row[];
  return rows.map(toSummary);
}

/** The dataset currently served for one series and covered region, or null. */
export async function getActivePopulationDataset(
  sql: Bun.SQL | Bun.TransactionSQL,
  publicationSeries: string,
  coverageRegionCode: string
): Promise<PopulationDatasetSummary | null> {
  const rows = (await sql.unsafe(
    `SELECT ${COLUMNS} FROM awcms_idn_population_datasets
     WHERE status = 'active' AND publication_series = $1 AND coverage_region_code = $2`,
    [publicationSeries, coverageRegionCode]
  )) as Row[];
  return rows[0] ? toSummary(rows[0]) : null;
}

async function getById(
  sql: Bun.SQL | Bun.TransactionSQL,
  datasetId: string
): Promise<PopulationDatasetSummary> {
  const rows = (await sql.unsafe(
    `SELECT ${COLUMNS} FROM awcms_idn_population_datasets WHERE id = $1`,
    [datasetId]
  )) as Row[];
  const row = rows[0];
  if (!row) {
    throw new PopulationLifecycleError(
      "Dataset not found.",
      "DATASET_NOT_FOUND"
    );
  }
  return toSummary(row);
}

/**
 * Activates one dataset by id. Already-active is `changed: false`, not an error
 * (activation is idempotent). Only a `validated` or `superseded` dataset can be
 * activated; a `rejected` one never can.
 */
export async function activatePopulationDataset(
  tx: Bun.TransactionSQL,
  datasetId: string,
  options: { activatedBy?: string | null } = {}
): Promise<{
  dataset: PopulationDatasetSummary;
  changed: boolean;
  supersededId: string | null;
}> {
  // FOR UPDATE: the read that decides the transition must hold the row.
  const target = (await tx`
    SELECT id, status, publication_series, coverage_region_code
    FROM awcms_idn_population_datasets
    WHERE id = ${datasetId}
    FOR UPDATE
  `) as {
    id: string;
    status: DatasetStatus;
    publication_series: string;
    coverage_region_code: string;
  }[];
  const current = target[0];

  if (!current) {
    throw new PopulationLifecycleError(
      "Dataset not found.",
      "DATASET_NOT_FOUND"
    );
  }
  if (current.status === "active") {
    return {
      dataset: await getById(tx, datasetId),
      changed: false,
      supersededId: null
    };
  }
  if (current.status !== "validated" && current.status !== "superseded") {
    throw new PopulationLifecycleError(
      `Dataset is ${current.status}; only a validated or superseded dataset can be activated.`,
      "DATASET_NOT_ACTIVATABLE"
    );
  }

  const superseded = (await tx`
    UPDATE awcms_idn_population_datasets
    SET status = 'superseded'
    WHERE status = 'active'
      AND publication_series = ${current.publication_series}
      AND coverage_region_code = ${current.coverage_region_code}
    RETURNING id
  `) as { id: string }[];

  await tx`
    UPDATE awcms_idn_population_datasets
    SET status = 'active',
        activated_at = now(),
        activated_by = ${options.activatedBy ?? null}
    WHERE id = ${datasetId}
  `;

  return {
    dataset: await getById(tx, datasetId),
    changed: true,
    supersededId: superseded[0]?.id ?? null
  };
}
