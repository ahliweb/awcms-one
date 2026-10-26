/**
 * Integration tests for BPS population statistics (awcms-one ADR-0051,
 * migration sql/882) against a real PostgreSQL under the ephemeral-database
 * harness. They prove what a typecheck cannot:
 *
 *   1. Both tables are GLOBAL (no tenant_id, RLS not forced) and the grants are
 *      exactly the least-privilege set the migration states, exercised through
 *      the real `awcms_app` and `awcms_worker` roles.
 *   2. Import lands a dataset `validated` with its rows; a failing CSV lands a
 *      `rejected` row and no statistics; a checksum mismatch records nothing.
 *   3. Activation supersedes only the active dataset of the SAME series and
 *      covered region, and the single-active rule is enforced by the DATABASE.
 *   4. The unique key treats two NULL sexes as equal (NULLS NOT DISTINCT), and
 *      the CHECK constraints keep jiwa integral and rupiah on income/expenditure.
 *
 * Skipped unless a real database is configured (see tests/integration/harness.ts).
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  assertRejected,
  getAdminSql,
  getAppRoleSql,
  getWorkerRoleSql,
  appRoleActivated,
  integrationEnabled,
  setupIntegrationDatabase,
  teardownIntegrationDatabase,
  workerRoleActivated
} from "./harness";
import {
  commitDatasetImport,
  deriveDatasetCode,
  type DatasetImportPlan
} from "../../src/modules/idn-admin-regions/application/dataset-import";
import { activateDataset } from "../../src/modules/idn-admin-regions/application/dataset-lifecycle";
import {
  commitPopulationImport,
  loadActiveRegionLevels,
  planPopulationImport,
  PopulationImportError,
  recordRejectedPopulationImport
} from "../../src/modules/idn-admin-regions/application/population-import";
import {
  activatePopulationDataset,
  getActivePopulationDataset,
  PopulationLifecycleError
} from "../../src/modules/idn-admin-regions/application/population-lifecycle";
import { normalizeRegionRows } from "../../src/modules/idn-admin-regions/domain/region-normalization";

const suite = integrationEnabled ? describe : describe.skip;

const FIXTURE_ROOT = path.join(
  import.meta.dir,
  "..",
  "fixtures",
  "idn-population"
);
const DATASETS_DIR = "data/idn-population/datasets";

const REGION_ROWS = [
  { code: "62", name: "Provinsi Uji", lineNumber: 1 },
  { code: "62.01", name: "Kabupaten Uji Satu", lineNumber: 2 },
  { code: "62.71", name: "Kota Uji Dua", lineNumber: 3 }
];

function asTx<T>(
  sql: Bun.SQL,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return fn(sql as unknown as Bun.TransactionSQL);
}

/** Imports + activates a tiny region dataset as the admin, returning the lookup. */
async function seedActiveRegionDataset(): Promise<void> {
  const sql = getAdminSql();
  const { regions } = normalizeRegionRows(REGION_ROWS);
  const plan: DatasetImportPlan = {
    datasetCode: deriveDatasetCode("popfixture0000", "popfix00"),
    sourceFile: "fixture",
    sourceFileSha256: "popfix00",
    sourceCommitSha: "popfixture0000",
    decreeReference: "test",
    rowCount: regions.length,
    countsByType: { province: 1, regency: 2 },
    errors: [],
    regions
  };
  const imported = await asTx(sql, (tx) => commitDatasetImport(tx, plan));
  await asTx(sql, (tx) => activateDataset(tx, imported.datasetId));
}

/** Copies a fixture pair to a temp root under a new code, rewriting the manifest. */
async function stagePair(options: {
  from: "fixture-population-ok" | "fixture-population-bad";
  code: string;
  manifest?: Record<string, unknown>;
  csv?: string;
  /** Leave the recorded csv checksum stale. */
  staleChecksum?: boolean;
}): Promise<string> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "idn-population-test-"));
  await mkdir(path.join(rootDir, DATASETS_DIR), { recursive: true });
  const source = path.join(FIXTURE_ROOT, DATASETS_DIR, options.from);
  const csv = options.csv ?? (await readFile(`${source}.csv`, "utf8"));
  const manifest = JSON.parse(await readFile(`${source}.json`, "utf8"));
  Object.assign(manifest, {
    datasetCode: options.code,
    csvPath: `${DATASETS_DIR}/${options.code}.csv`,
    csvSha256: createHash("sha256").update(csv).digest("hex"),
    ...options.manifest
  });
  if (options.staleChecksum) manifest.csvSha256 = "f".repeat(64);
  await writeFile(path.join(rootDir, DATASETS_DIR, `${options.code}.csv`), csv);
  await writeFile(
    path.join(rootDir, DATASETS_DIR, `${options.code}.json`),
    JSON.stringify(manifest)
  );
  return rootDir;
}

async function plan(code: string, rootDir: string) {
  const worker = getWorkerRoleSql();
  const { regionDatasetId, levels } = await loadActiveRegionLevels(worker);
  return planPopulationImport({
    datasetCode: code,
    regionDatasetId,
    regionLevels: levels,
    rootDir
  });
}

/** Plans and commits through the worker role, as the CLI does. */
async function importAs(code: string, rootDir: string) {
  const planned = await plan(code, rootDir);
  expect(planned.errors).toEqual([]);
  return getWorkerRoleSql().begin((tx) =>
    commitPopulationImport(tx as Bun.TransactionSQL, planned)
  );
}

suite("idn population statistics (real PostgreSQL)", () => {
  const roots: string[] = [];

  beforeAll(async () => {
    await setupIntegrationDatabase();
  });

  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await teardownIntegrationDatabase();
  });

  beforeEach(async () => {
    const sql = getAdminSql();
    await sql.unsafe("DELETE FROM awcms_idn_population_stats");
    await sql.unsafe("DELETE FROM awcms_idn_population_datasets");
    await sql.unsafe("DELETE FROM awcms_idn_admin_regions");
    await sql.unsafe("DELETE FROM awcms_idn_region_datasets");
    await seedActiveRegionDataset();
  });

  async function stage(options: Parameters<typeof stagePair>[0]) {
    const root = await stagePair(options);
    roots.push(root);
    return root;
  }

  test("both tables are GLOBAL: no tenant_id column, no forced RLS", async () => {
    const sql = getAdminSql();
    const tables = [
      "awcms_idn_population_datasets",
      "awcms_idn_population_stats"
    ];

    const columns = (await sql.unsafe(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenant_id'
         AND table_name = ANY($1)`,
      [tables]
    )) as { table_name: string }[];
    expect(columns).toEqual([]);

    const rls = (await sql.unsafe(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)`,
      [tables]
    )) as { relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    expect(rls).toHaveLength(2);
    for (const row of rls) {
      expect(row.relrowsecurity).toBe(false);
      expect(row.relforcerowsecurity).toBe(false);
    }
  });

  test("grants: app is read-only, worker inserts (and activates datasets), nobody deletes", async () => {
    const sql = getAdminSql();
    const grants = (await sql.unsafe(`
      SELECT grantee, table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE table_name IN ('awcms_idn_population_datasets', 'awcms_idn_population_stats')
        AND grantee IN ('awcms_app', 'awcms_worker', 'awcms_setup')
    `)) as { grantee: string; table_name: string; privilege_type: string }[];

    const privileges = (role: string, table: string) =>
      grants
        .filter((g) => g.grantee === role && g.table_name === table)
        .map((g) => g.privilege_type)
        .sort();

    expect(privileges("awcms_app", "awcms_idn_population_datasets")).toEqual([
      "SELECT"
    ]);
    expect(privileges("awcms_app", "awcms_idn_population_stats")).toEqual([
      "SELECT"
    ]);
    expect(privileges("awcms_worker", "awcms_idn_population_datasets")).toEqual(
      ["INSERT", "SELECT", "UPDATE"]
    );
    expect(privileges("awcms_worker", "awcms_idn_population_stats")).toEqual([
      "INSERT",
      "SELECT"
    ]);
    expect(grants.some((g) => g.grantee === "awcms_setup")).toBe(false);
    expect(grants.some((g) => g.privilege_type === "DELETE")).toBe(false);
  });

  test("the app role cannot write; the worker cannot delete or edit statistics", async () => {
    if (!appRoleActivated || !workerRoleActivated) return;
    const root = await stage({
      from: "fixture-population-ok",
      code: "grants-probe"
    });
    await importAs("grants-probe", root);

    const app = getAppRoleSql();
    const worker = getWorkerRoleSql();

    expect(
      (
        await app.unsafe(
          "SELECT count(*)::int AS n FROM awcms_idn_population_stats"
        )
      )[0].n
    ).toBeGreaterThan(0);
    for (const statement of [
      "INSERT INTO awcms_idn_population_datasets (dataset_code) VALUES ('x')",
      "UPDATE awcms_idn_population_datasets SET status = 'active'",
      "UPDATE awcms_idn_population_stats SET unit = 'jiwa'",
      "DELETE FROM awcms_idn_population_stats"
    ]) {
      const error = await assertRejected(
        app.unsafe(statement),
        `app: ${statement}`
      );
      expect(error.message).toMatch(/permission denied/);
    }
    for (const statement of [
      "DELETE FROM awcms_idn_population_stats",
      "DELETE FROM awcms_idn_population_datasets",
      "UPDATE awcms_idn_population_stats SET unit = 'jiwa'"
    ]) {
      const error = await assertRejected(
        worker.unsafe(statement),
        `worker: ${statement}`
      );
      expect(error.message).toMatch(/permission denied/);
    }
  });

  test("import lands a validated dataset with its rows and a validation summary", async () => {
    const root = await stage({
      from: "fixture-population-ok",
      code: "import-ok"
    });
    const result = await importAs("import-ok", root);
    expect(result.status).toBe("validated");
    expect(result.rowCount).toBe(21);

    const sql = getAdminSql();
    const dataset = (
      await sql.unsafe(
        `SELECT d.*, r.status AS region_status
         FROM awcms_idn_population_datasets d
         JOIN awcms_idn_region_datasets r ON r.id = d.region_dataset_id
         WHERE d.dataset_code = 'import-ok'`
      )
    )[0];
    expect(dataset.status).toBe("validated");
    expect(dataset.row_count).toBe(21);
    expect(dataset.region_status).toBe("active");
    expect(dataset.publisher_website).toBe("https://kalteng.bps.go.id");
    expect(dataset.validation_summary.checksRun.sex_sum).toBe(3);
    expect(dataset.validation_summary.checksRun.age_group_sum).toBe(1);
    expect(dataset.validation_summary.checksRun.religion_sum).toBe(1);
    expect(dataset.validation_summary.warningCount).toBe(0);
    expect(dataset.validation_summary.checksRun.children_sum).toBeGreaterThan(
      0
    );

    const stats = (await sql.unsafe(
      `SELECT dimension, category, sex, value::text AS value, unit, source_page
       FROM awcms_idn_population_stats
       WHERE dataset_id = $1 AND region_code = '62'
       ORDER BY dimension, category`,
      [dataset.id]
    )) as {
      dimension: string;
      category: string;
      sex: string | null;
      value: string;
      unit: string;
      source_page: number;
    }[];
    expect(stats.find((s) => s.dimension === "income")).toMatchObject({
      value: "3000000.00",
      unit: "rupiah",
      sex: null,
      source_page: 60
    });
    expect(stats).toHaveLength(15);
    const labels = (await sql.unsafe(
      `SELECT category, category_label FROM awcms_idn_population_stats
       WHERE dataset_id = $1 AND category_label IS NOT NULL ORDER BY category`,
      [dataset.id]
    )) as { category: string; category_label: string }[];
    expect(labels).toEqual([
      { category: "65+", category_label: "65 tahun ke atas, lebih" },
      { category: "islam", category_label: "Islam" }
    ]);
  });

  test("a failing CSV is recorded as rejected with no statistics, and a re-run refreshes it", async () => {
    const root = await stage({
      from: "fixture-population-bad",
      code: "import-bad"
    });
    const planned = await plan("import-bad", root);
    expect(planned.errors.join()).toMatch(/sex_sum failed/);

    const first = await recordRejectedPopulationImport(
      getWorkerRoleSql(),
      planned
    );
    expect(first).toMatchObject({ status: "rejected", inserted: true });
    const second = await recordRejectedPopulationImport(
      getWorkerRoleSql(),
      planned
    );
    expect(second).toMatchObject({ status: "rejected", inserted: false });

    const sql = getAdminSql();
    const rows = (await sql.unsafe(
      `SELECT status, row_count, validation_summary FROM awcms_idn_population_datasets`
    )) as {
      status: string;
      row_count: number;
      validation_summary: { errors: string[] };
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("rejected");
    expect(rows[0]!.row_count).toBe(0);
    expect(rows[0]!.validation_summary.errors.join()).toMatch(/sex_sum failed/);
    expect(
      (
        await sql.unsafe(
          "SELECT count(*)::int AS n FROM awcms_idn_population_stats"
        )
      )[0].n
    ).toBe(0);

    // A rejected dataset can never be activated.
    const error = await getWorkerRoleSql()
      .begin((tx) =>
        activatePopulationDataset(tx as Bun.TransactionSQL, first.datasetId)
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PopulationLifecycleError);
    expect((error as PopulationLifecycleError).code).toBe(
      "DATASET_NOT_ACTIVATABLE"
    );
  });

  test("a manifest that disagrees with its CSV is refused and records nothing", async () => {
    const root = await stage({
      from: "fixture-population-ok",
      code: "stale-sum",
      staleChecksum: true
    });
    const error = await plan("stale-sum", root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PopulationImportError);
    expect((error as PopulationImportError).problems.join()).toMatch(
      /Checksum mismatch/
    );

    const sql = getAdminSql();
    expect(
      (
        await sql.unsafe(
          "SELECT count(*)::int AS n FROM awcms_idn_population_datasets"
        )
      )[0].n
    ).toBe(0);
  });

  test("region codes are validated against the ACTIVE region dataset", async () => {
    const csv = (
      await readFile(
        path.join(FIXTURE_ROOT, DATASETS_DIR, "fixture-population-ok.csv"),
        "utf8"
      )
    ).replace(/^62\.71,/gm, "62.99,");
    const root = await stage({
      from: "fixture-population-ok",
      code: "unknown-region",
      csv
    });
    const planned = await plan("unknown-region", root);
    expect(planned.errors.join()).toMatch(
      /absent from the active region dataset: 62\.99/
    );

    // With no active region dataset at all, loading the lookup is refused.
    await getAdminSql().unsafe(
      "UPDATE awcms_idn_region_datasets SET status = 'superseded'"
    );
    const error = await loadActiveRegionLevels(getWorkerRoleSql()).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(PopulationImportError);
  });

  test("importing a dataset code twice collides on the unique code", async () => {
    const root = await stage({ from: "fixture-population-ok", code: "twice" });
    await importAs("twice", root);
    const error = await assertRejected(
      importAs("twice", root),
      "second import"
    );
    expect(error.message).toMatch(
      /awcms_idn_population_datasets_dataset_code_key/
    );
  });

  test("activation supersedes only the same series and region; the index is the guard", async () => {
    const worker = getWorkerRoleSql();
    const activate = (id: string) =>
      worker.begin((tx) =>
        activatePopulationDataset(tx as Bun.TransactionSQL, id)
      );

    const rootA = await stage({
      from: "fixture-population-ok",
      code: "prov-a"
    });
    const rootB = await stage({
      from: "fixture-population-ok",
      code: "prov-b"
    });
    const a = await importAs("prov-a", rootA);
    const b = await importAs("prov-b", rootB);

    const first = await activate(a.datasetId);
    expect(first).toMatchObject({ changed: true, supersededId: null });
    expect((await activate(a.datasetId)).changed).toBe(false); // idempotent

    // A dataset for a DIFFERENT series/region stays active side by side.
    const csvDistrict =
      (
        await readFile(
          path.join(FIXTURE_ROOT, DATASETS_DIR, "fixture-population-ok.csv"),
          "utf8"
        )
      )
        .split("\n")
        .filter((l, i) => i === 0 || l.startsWith("62.71,"))
        .join("\n") + "\n";
    const rootC = await stage({
      from: "fixture-population-ok",
      code: "regency-c",
      csv: csvDistrict,
      manifest: {
        publicationSeries: "kabupaten_kota_dalam_angka",
        coverageRegionCode: "62.71",
        coverageRegionLevel: 2
      }
    });
    const c = await importAs("regency-c", rootC);
    expect((await activate(c.datasetId)).supersededId).toBeNull();

    // Activating B supersedes A (same series + coverage) and leaves C alone.
    const swap = await activate(b.datasetId);
    expect(swap).toMatchObject({ changed: true, supersededId: a.datasetId });

    const statuses = Object.fromEntries(
      (
        (await getAdminSql().unsafe(
          "SELECT dataset_code, status FROM awcms_idn_population_datasets"
        )) as { dataset_code: string; status: string }[]
      ).map((r) => [r.dataset_code, r.status])
    );
    expect(statuses).toEqual({
      "prov-a": "superseded",
      "prov-b": "active",
      "regency-c": "active"
    });
    expect(
      (await getActivePopulationDataset(worker, "provinsi_dalam_angka", "62"))
        ?.datasetCode
    ).toBe("prov-b");

    // The database refuses a second active dataset for the same slot, whatever the code does.
    const error = await assertRejected(
      getAdminSql().unsafe(
        "UPDATE awcms_idn_population_datasets SET status = 'active' WHERE dataset_code = 'prov-a'"
      ),
      "second active dataset"
    );
    expect(error.message).toMatch(
      /awcms_idn_population_datasets_single_active/
    );

    // A superseded dataset can be re-activated (rollback by activation).
    const back = await activate(a.datasetId);
    expect(back).toMatchObject({ changed: true, supersededId: b.datasetId });
  });

  test("the unique key treats NULL sexes as equal; CHECKs guard unit and dimension", async () => {
    const root = await stage({ from: "fixture-population-ok", code: "checks" });
    const { datasetId } = await importAs("checks", root);
    const sql = getAdminSql();

    const insert = (overrides: Record<string, string>) => {
      const row: Record<string, string> = {
        region_code: "'62'",
        region_level: "1",
        dimension: "'total'",
        category: "'total'",
        sex: "NULL",
        value: "1",
        unit: "'jiwa'",
        reference_year: "2025",
        universe: "'total_population'",
        source_table: "'Tabel 3.1.1'",
        figure_basis: "'projection'",
        ...overrides
      };
      return sql.unsafe(
        `INSERT INTO awcms_idn_population_stats
           (dataset_id, region_code, region_level, source_region_name, dimension,
            category, sex, value, unit, reference_year, figure_basis, universe,
            source_table, source_row_hash)
         VALUES ('${datasetId}', ${row.region_code}, ${row.region_level}, 'x',
                 ${row.dimension}, ${row.category}, ${row.sex}, ${row.value},
                 ${row.unit}, ${row.reference_year}, ${row.figure_basis}, ${row.universe},
                 ${row.source_table}, 'h')`
      );
    };

    // Same key as the fixture's province total (sex NULL) -> collides.
    expect((await assertRejected(insert({}), "duplicate key")).message).toMatch(
      /awcms_idn_population_stats_key/
    );
    // A fractional head count.
    expect(
      (
        await assertRejected(
          insert({ category: "'x'", dimension: "'occupation'", value: "1.5" }),
          "fractional jiwa"
        )
      ).message
    ).toMatch(/jiwa_integral_check/);
    // rupiah on a population dimension.
    expect(
      (
        await assertRejected(
          insert({
            category: "'y'",
            dimension: "'occupation'",
            unit: "'rupiah'"
          }),
          "rupiah on occupation"
        )
      ).message
    ).toMatch(/rupiah_dimension_check/);
    // sex on a total.
    expect(
      (
        await assertRejected(
          insert({ category: "'z'", sex: "'perempuan'" }),
          "sex on total"
        )
      ).message
    ).toMatch(/total_sex_check/);
    // The same table may print the same figure under another basis.
    await insert({ figure_basis: "'registration'" });
    // The same figure in ANOTHER table is allowed: each table keeps its own total.
    await insert({ source_table: "'Tabel 9.9.9'" });
    // A different reference year is a different figure, and fractional ribu_jiwa is fine.
    await insert({ reference_year: "2024", value: "1.5", unit: "'ribu_jiwa'" });
  });
});
