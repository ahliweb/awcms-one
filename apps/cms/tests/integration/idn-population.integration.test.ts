/**
 * Integration tests for the Kepmendagri population and area figures
 * (awcms-one ADR-0053, migrations sql/882 + sql/883) against a real PostgreSQL
 * under the ephemeral-database harness. They prove what a typecheck cannot:
 *
 *   1. Both tables are GLOBAL (no tenant_id, RLS not forced) and the grants are
 *      exactly the least-privilege set, exercised through the real `awcms_app`
 *      and `awcms_worker` roles.
 *   2. sql/883 deletes every BPS row of a database that imported them, and its
 *      CHECKs admit the decree source and nothing BPS-shaped.
 *   3. The REAL vendored files import end to end against the REAL level-1/2
 *      regions; re-importing identical bytes is a no-op.
 *   4. A checksum mismatch records nothing; a validation failure records a
 *      `rejected` row with no figures; a `rejected` row is promoted once the
 *      same bytes pass against a fixed region dataset.
 *   5. Activation supersedes the previous dataset, and the single-active rule is
 *      enforced by the DATABASE.
 *
 * Skipped unless a real database is configured (see tests/integration/harness.ts).
 */
import { readFile, rm } from "node:fs/promises";
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
  loadActiveRegionDataset,
  planPopulationImport,
  PopulationAlreadyImportedError,
  PopulationImportError,
  readPopulationSources,
  recordRejectedPopulationImport
} from "../../src/modules/idn-admin-regions/application/population-import";
import {
  activatePopulationDataset,
  getActivePopulationDataset,
  PopulationLifecycleError
} from "../../src/modules/idn-admin-regions/application/population-lifecycle";
import { POPULATION_DECREE_REFERENCE } from "../../src/modules/idn-admin-regions/domain/population-source";
import { normalizeRegionRows } from "../../src/modules/idn-admin-regions/domain/region-normalization";
import {
  parseWilayahDump,
  type WilayahDumpRow
} from "../../src/modules/idn-admin-regions/domain/wilayah-dump-parser";
import {
  FIXTURE_REGION_ROWS,
  readFixture,
  stageSources,
  type StageOptions
} from "../fixtures/idn-population/stage-sources";

const suite = integrationEnabled ? describe : describe.skip;

const CMS_ROOT = path.join(import.meta.dir, "..", "..");

function asTx<T>(
  sql: Bun.SQL,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return fn(sql as unknown as Bun.TransactionSQL);
}

let seedCounter = 0;

/** Imports + activates a region dataset of the given rows as the admin. */
async function seedActiveRegionDataset(
  rows: WilayahDumpRow[],
  decreeReference: string = POPULATION_DECREE_REFERENCE
): Promise<string> {
  const sql = getAdminSql();
  const { regions } = normalizeRegionRows(rows);
  seedCounter += 1;
  const marker = `popfix${String(seedCounter).padStart(2, "0")}`;
  const plan: DatasetImportPlan = {
    datasetCode: deriveDatasetCode(`${marker}00000000`, marker),
    sourceFile: "fixture",
    sourceFileSha256: marker,
    sourceCommitSha: `${marker}00000000`,
    decreeReference,
    rowCount: regions.length,
    countsByType: {},
    errors: [],
    regions
  };
  const imported = await asTx(sql, (tx) => commitDatasetImport(tx, plan));
  await asTx(sql, (tx) => activateDataset(tx, imported.datasetId));
  return imported.datasetId;
}

/** Level-1/2 rows of the REAL vendored region dump (552 regions). */
async function realProvinceAndRegencyRows(): Promise<WilayahDumpRow[]> {
  const dump = parseWilayahDump(
    await readFile(
      path.join(
        CMS_ROOT,
        "data/idn-admin-regions/upstream/cahyadsn-wilayah/db/wilayah.sql"
      ),
      "utf8"
    )
  );
  return dump.rows.filter((row) => row.code.split(".").length <= 2);
}

async function planFrom(rootDir: string) {
  const worker = getWorkerRoleSql();
  return planPopulationImport(
    await readPopulationSources(rootDir),
    await loadActiveRegionDataset(worker)
  );
}

/** Plans and commits through the worker role, as the CLI does. */
async function importFrom(rootDir: string) {
  const plan = await planFrom(rootDir);
  expect(plan.errors).toEqual([]);
  return getWorkerRoleSql().begin((tx) =>
    commitPopulationImport(tx as Bun.TransactionSQL, plan)
  );
}

async function count(sql: Bun.SQL, table: string): Promise<number> {
  return (
    (await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`)) as {
      n: number;
    }[]
  )[0]!.n;
}

suite(
  "idn population figures from the Kepmendagri decree (real PostgreSQL)",
  () => {
    const roots: string[] = [];

    beforeAll(async () => {
      await setupIntegrationDatabase();
    });

    afterAll(async () => {
      for (const root of roots)
        await rm(root, { recursive: true, force: true });
      await teardownIntegrationDatabase();
    });

    beforeEach(async () => {
      const sql = getAdminSql();
      await sql.unsafe("DELETE FROM awcms_idn_population_stats");
      await sql.unsafe("DELETE FROM awcms_idn_population_datasets");
      await sql.unsafe("DELETE FROM awcms_idn_admin_regions");
      await sql.unsafe("DELETE FROM awcms_idn_region_datasets");
    });

    async function stage(options: StageOptions = {}) {
      const root = await stageSources(options);
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
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname = ANY($1) AND relnamespace = 'public'::regnamespace`,
        [tables]
      )) as { relrowsecurity: boolean; relforcerowsecurity: boolean }[];
      expect(rls).toHaveLength(2);
      for (const row of rls) {
        expect(row.relrowsecurity).toBe(false);
        expect(row.relforcerowsecurity).toBe(false);
      }
    });

    test("grants: app is read-only, worker inserts (and activates datasets), nobody deletes", async () => {
      const grants = (await getAdminSql().unsafe(`
      SELECT grantee, table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name IN ('awcms_idn_population_datasets', 'awcms_idn_population_stats')
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
      expect(
        privileges("awcms_worker", "awcms_idn_population_datasets")
      ).toEqual(["INSERT", "SELECT", "UPDATE"]);
      expect(privileges("awcms_worker", "awcms_idn_population_stats")).toEqual([
        "INSERT",
        "SELECT"
      ]);
      expect(grants.some((g) => g.grantee === "awcms_setup")).toBe(false);
      expect(grants.some((g) => g.privilege_type === "DELETE")).toBe(false);
    });

    test("sql/883 deletes the BPS rows of a database that imported them, and then admits only the decree", async () => {
      // Replays sql/882, a BPS import, then sql/883 inside a throwaway schema
      // that shadows `public` for the two population tables only, so the real
      // tables are untouched. Everything is rolled back.
      await seedActiveRegionDataset(FIXTURE_REGION_ROWS);
      const migration882 = await readFile(
        path.join(CMS_ROOT, "sql/882_awcms_idn_population_stats.sql"),
        "utf8"
      );
      const migration883 = await readFile(
        path.join(
          CMS_ROOT,
          "sql/883_awcms_idn_population_kepmendagri_source.sql"
        ),
        "utf8"
      );
      const rollback = new Error("rollback");
      const observed: Record<string, unknown> = {};

      const outcome = await getAdminSql()
        .begin(async (tx) => {
          await tx.unsafe("CREATE SCHEMA kmd_replay");
          await tx.unsafe("SET LOCAL search_path TO kmd_replay, public");
          await tx.unsafe(migration882);
          const dataset = (await tx.unsafe(`
          INSERT INTO awcms_idn_population_datasets
            (dataset_code, publication_series, coverage_region_code,
             coverage_region_level, publication_title, publisher_name,
             publisher_domain, publisher_website, attribution, publication_year,
             publication_url, source_file_sha256, source_file_bytes, csv_sha256,
             terms_of_use, region_dataset_id, row_count, status)
          SELECT 'bps-6200-dalam-angka-2026', 'provinsi_dalam_angka', '62', 1,
                 'Provinsi Uji Dalam Angka 2026', 'BPS Provinsi Uji', '6200',
                 'https://uji.bps.go.id', 'https://uji.bps.go.id', 2026,
                 'https://uji.bps.go.id/p', repeat('a', 64), 10, repeat('b', 64),
                 'terms', id, 1, 'active'
          FROM awcms_idn_region_datasets WHERE status = 'active'
          RETURNING id
        `)) as { id: string }[];
          await tx.unsafe(
            `INSERT INTO awcms_idn_population_stats
             (dataset_id, region_code, region_level, source_region_name,
              dimension, category, value, unit, reference_year, figure_basis,
              universe, source_table, source_row_hash)
           VALUES ($1, '62', 1, 'Provinsi Uji', 'religion', 'islam', 2.84,
                   'ribu_jiwa', 2025, 'registration', 'total_population',
                   'Tabel 3.1.4', 'h')`,
            [dataset[0]!.id]
          );
          observed.before = await count(
            tx as unknown as Bun.SQL,
            "awcms_idn_population_stats"
          );

          await tx.unsafe(migration883);

          observed.datasets = await count(
            tx as unknown as Bun.SQL,
            "awcms_idn_population_datasets"
          );
          observed.stats = await count(
            tx as unknown as Bun.SQL,
            "awcms_idn_population_stats"
          );
          observed.valueType = (
            (await tx.unsafe(`
            SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
            WHERE attrelid = 'kmd_replay.awcms_idn_population_stats'::regclass
              AND attname = 'value'
          `)) as { t: string }[]
          )[0]!.t;
          await tx.unsafe("SAVEPOINT bps_probe");
          observed.bpsInsert = await tx
            .unsafe(
              `
            INSERT INTO awcms_idn_population_datasets
              (dataset_code, source_type, publication_series, coverage_region_code,
               coverage_region_level, publication_title, publisher_name,
               attribution, publication_year, publication_url, source_files,
               terms_of_use, region_dataset_id, row_count, status)
            SELECT 'bps-again', 'bps_publication', 'kepmendagri_kode_data_wilayah', '62',
                   1, 't', 'p', 'a', 2026, 'https://x', '[{}]', 't', id, 0,
                   'validated'
            FROM awcms_idn_region_datasets WHERE status = 'active'
          `
            )
            .then(
              () => "accepted",
              (error: Error) => error.message
            );
          await tx.unsafe("ROLLBACK TO SAVEPOINT bps_probe");
          throw rollback;
        })
        .catch((error: unknown) => error);

      expect(outcome).toBe(rollback);
      expect(observed.before).toBe(1);
      expect(observed.datasets).toBe(0);
      expect(observed.stats).toBe(0);
      expect(observed.valueType).toBe("numeric(14,3)");
      expect(String(observed.bpsInsert)).toMatch(
        /awcms_idn_population_datasets_source_type_check/
      );
      // The replay schema is gone with the rollback.
      expect(
        (
          (await getAdminSql().unsafe(
            "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'kmd_replay'"
          )) as { n: number }[]
        )[0]!.n
      ).toBe(0);
    });

    test("the REAL vendored files import end to end: 2,208 figures, 5 repaired codes, provenance per file", async () => {
      await seedActiveRegionDataset(await realProvinceAndRegencyRows());
      const result = await importFrom(CMS_ROOT);
      expect(result).toMatchObject({
        datasetCode: "kepmendagri-300.2.2-2138-2025-b0b6b9dc-3ffd506e",
        rowCount: 2208,
        status: "validated",
        promotedFromRejected: false
      });

      const sql = getAdminSql();
      const dataset = (
        (await sql.unsafe(
          `SELECT d.*, jsonb_typeof(d.source_files) AS files_type,
                r.status AS region_status
         FROM awcms_idn_population_datasets d
         JOIN awcms_idn_region_datasets r ON r.id = d.region_dataset_id
         WHERE d.id = $1`,
          [result.datasetId]
        )) as Record<string, unknown>[]
      )[0]!;
      expect(dataset).toMatchObject({
        source_type: "kepmendagri_decree",
        publication_series: "kepmendagri_kode_data_wilayah",
        coverage_region_code: "ID",
        coverage_region_level: 0,
        publisher_domain: null,
        publisher_website: null,
        csv_sha256: null,
        files_type: "array",
        region_status: "active",
        publication_url:
          "https://github.com/cahyadsn/wilayah/tree/cae306278e5be616c83ba2d8096b00767f45b5fe/db"
      });
      const files = dataset.source_files as {
        role: string;
        path: string;
        sha256: string;
        origin: string;
      }[];
      expect(files.map((f) => [f.role, f.path, f.sha256])).toEqual([
        [
          "population",
          "upstream/cahyadsn-wilayah/db/wilayah_penduduk.sql",
          "b0b6b9dc70fa6a4fdb9e05bf00ec549ed8f6cf0bb82f6407281dfac674b10447"
        ],
        [
          "area",
          "upstream/cahyadsn-wilayah/db/wilayah_luas.sql",
          "3ffd506eaabaa2bfa101fb24c5e40582cf9548be38adba53a561d0ed7478c043"
        ]
      ]);
      expect(files[1]!.origin).toMatch(/Badan Informasi Geospasial.*B-16\.10/);
      expect(String(dataset.terms_of_use)).toMatch(/not an official/);
      const summary = dataset.validation_summary as {
        codeRepairs: unknown[];
        warningCount: number;
        errorCount: number;
      };
      expect(summary.codeRepairs).toHaveLength(5);
      expect(summary.errorCount).toBe(0);

      const byDimension = (await sql.unsafe(
        `SELECT dimension, unit, figure_basis, count(*)::int AS n
       FROM awcms_idn_population_stats WHERE dataset_id = $1
       GROUP BY 1, 2, 3 ORDER BY 1`,
        [result.datasetId]
      )) as {
        dimension: string;
        unit: string;
        figure_basis: string;
        n: number;
      }[];
      expect(byDimension).toEqual([
        {
          dimension: "area",
          unit: "km2",
          figure_basis: "geospatial_calculation",
          n: 552
        },
        { dimension: "sex", unit: "jiwa", figure_basis: "decree", n: 1104 },
        { dimension: "total", unit: "jiwa", figure_basis: "decree", n: 552 }
      ]);
      const samples = (await sql.unsafe(
        `SELECT region_code, dimension, category, value::text AS value
       FROM awcms_idn_population_stats
       WHERE dataset_id = $1 AND region_code IN ('11.10', '31', '62')
         AND category IN ('total', 'perempuan')
       ORDER BY region_code, dimension, category`,
        [result.datasetId]
      )) as {
        region_code: string;
        dimension: string;
        category: string;
        value: string;
      }[];
      // numeric(14,3) renders persons with three zero decimals; the value is the
      // printed whole number, unchanged.
      expect(
        samples.map(
          (s) => `${s.region_code} ${s.dimension}/${s.category}=${s.value}`
        )
      ).toEqual([
        "11.10 area/total=1851.615",
        "11.10 sex/perempuan=69604.000",
        "11.10 total/total=140461.000",
        "31 area/total=661.530",
        "31 sex/perempuan=5500881.000",
        "31 total/total=11038216.000",
        "62 area/total=153430.363",
        "62 sex/perempuan=1365377.000",
        "62 total/total=2825290.000"
      ]);
      // No national row was stored.
      expect(
        (
          (await sql.unsafe(
            "SELECT count(*)::int AS n FROM awcms_idn_population_stats WHERE region_code = '0'"
          )) as { n: number }[]
        )[0]!.n
      ).toBe(0);

      // Re-importing identical bytes is a no-op: refused by code, nothing doubled.
      const again = await importFrom(CMS_ROOT).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(PopulationAlreadyImportedError);
      expect((again as PopulationAlreadyImportedError).status).toBe(
        "validated"
      );
      expect(await count(sql, "awcms_idn_population_datasets")).toBe(1);
      expect(await count(sql, "awcms_idn_population_stats")).toBe(2208);
    });

    test("the app role cannot write; the worker cannot delete or edit figures", async () => {
      if (!appRoleActivated || !workerRoleActivated) return;
      await seedActiveRegionDataset(FIXTURE_REGION_ROWS);
      await importFrom(await stage());

      const app = getAppRoleSql();
      const worker = getWorkerRoleSql();
      expect(await count(app, "awcms_idn_population_stats")).toBe(16);
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

    test("a file that disagrees with its checksum is refused and records nothing", async () => {
      await seedActiveRegionDataset(FIXTURE_REGION_ROWS);
      const error = await planFrom(await stage({ tamper: "population" })).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(PopulationImportError);
      expect((error as PopulationImportError).problems.join()).toMatch(
        /Checksum mismatch for upstream\/cahyadsn-wilayah\/db\/wilayah_penduduk\.sql/
      );
      expect(await count(getAdminSql(), "awcms_idn_population_datasets")).toBe(
        0
      );
    });

    test("a sum mismatch is recorded as rejected with no figures; a re-run refreshes it; it cannot be activated", async () => {
      await seedActiveRegionDataset(FIXTURE_REGION_ROWS);
      const population = (await readFixture("wilayah_penduduk.sql")).replace(
        "'260','240','500'",
        "'260','241','500'"
      );
      const plan = await planFrom(await stage({ population }));
      expect(plan.errors.join()).toMatch(/sex_sum failed for 62\.71/);

      const worker = getWorkerRoleSql();
      const first = await recordRejectedPopulationImport(worker, plan);
      expect(first).toMatchObject({ status: "rejected", inserted: true });
      const second = await recordRejectedPopulationImport(worker, plan);
      expect(second).toMatchObject({ status: "rejected", inserted: false });

      const sql = getAdminSql();
      const rows = (await sql.unsafe(
        "SELECT status, row_count, validation_summary FROM awcms_idn_population_datasets"
      )) as {
        status: string;
        row_count: number;
        validation_summary: { errors: string[] };
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "rejected", row_count: 0 });
      expect(rows[0]!.validation_summary.errors.join()).toMatch(
        /sex_sum failed/
      );
      expect(await count(sql, "awcms_idn_population_stats")).toBe(0);

      const error = await worker
        .begin((tx) =>
          activatePopulationDataset(tx as Bun.TransactionSQL, first.datasetId)
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PopulationLifecycleError);
      expect((error as PopulationLifecycleError).code).toBe(
        "DATASET_NOT_ACTIVATABLE"
      );
    });

    test("an unknown kode is refused; once the region dataset has it, the same bytes are promoted from rejected", async () => {
      // The region dataset lacks 62.71: the files name a region it does not have.
      await seedActiveRegionDataset(
        FIXTURE_REGION_ROWS.filter((row) => row.code !== "62.71")
      );
      const root = await stage();
      const plan = await planFrom(root);
      expect(plan.errors.join("\n")).toMatch(
        /kode "62\.71" \("Kota Uji Dua"\) is not a province or regency\/city of the active region dataset/
      );
      const rejected = await recordRejectedPopulationImport(
        getWorkerRoleSql(),
        plan
      );

      // A complete region dataset is activated; the identical bytes now pass.
      await seedActiveRegionDataset(FIXTURE_REGION_ROWS);
      const promoted = await importFrom(root);
      expect(promoted).toMatchObject({
        datasetId: rejected.datasetId,
        datasetCode: rejected.datasetCode,
        promotedFromRejected: true,
        rowCount: 16
      });
      const row = (
        (await getAdminSql().unsafe(
          "SELECT status, row_count, validation_summary FROM awcms_idn_population_datasets"
        )) as {
          status: string;
          row_count: number;
          validation_summary: { previousRejection: { errors: string[] } };
        }[]
      )[0]!;
      expect(row).toMatchObject({ status: "validated", row_count: 16 });
      expect(row.validation_summary.previousRejection.errors.join()).toMatch(
        /62\.71/
      );
    });

    test("a region dataset under another decree is refused", async () => {
      await seedActiveRegionDataset(
        FIXTURE_REGION_ROWS,
        "Kepmendagri No 100.1.1-6117 Tahun 2022"
      );
      const plan = await planFrom(await stage());
      expect(plan.errors.join()).toMatch(
        /Their codes are only comparable under the same decree/
      );
    });

    test("activation supersedes the previous decree dataset; the index is the guard", async () => {
      await seedActiveRegionDataset(FIXTURE_REGION_ROWS);
      const worker = getWorkerRoleSql();
      const activate = (id: string) =>
        worker.begin((tx) =>
          activatePopulationDataset(tx as Bun.TransactionSQL, id)
        );

      const a = await importFrom(await stage());
      // Different bytes (a corrected figure) -> a different dataset code.
      const corrected = (await readFixture("wilayah_luas.sql"))
        .replace("100.5", "100.6")
        .replace("153.564", "153.664");
      const b = await importFrom(await stage({ area: corrected }));
      expect(b.datasetCode).not.toBe(a.datasetCode);

      expect(await activate(a.datasetId)).toMatchObject({
        changed: true,
        supersededId: null
      });
      expect((await activate(a.datasetId)).changed).toBe(false);
      expect(await activate(b.datasetId)).toMatchObject({
        changed: true,
        supersededId: a.datasetId
      });
      expect(
        (
          await getActivePopulationDataset(
            worker,
            "kepmendagri_kode_data_wilayah",
            "ID"
          )
        )?.id
      ).toBe(b.datasetId);

      const error = await assertRejected(
        getAdminSql().unsafe(
          `UPDATE awcms_idn_population_datasets SET status = 'active' WHERE id = '${a.datasetId}'`
        ),
        "second active dataset"
      );
      expect(error.message).toMatch(
        /awcms_idn_population_datasets_single_active/
      );

      // A superseded dataset can be re-activated (rollback by activation).
      expect(await activate(a.datasetId)).toMatchObject({
        changed: true,
        supersededId: b.datasetId
      });
    });

    test("CHECKs keep units, bases and vocabularies paired; three km2 decimals are stored exactly", async () => {
      await seedActiveRegionDataset(FIXTURE_REGION_ROWS);
      const { datasetId } = await importFrom(await stage());
      const sql = getAdminSql();
      const insert = (overrides: Record<string, string>) => {
        const row: Record<string, string> = {
          region_code: "'62.01'",
          dimension: "'area'",
          category: "'total'",
          value: "0.001",
          unit: "'km2'",
          reference_year: "2023",
          figure_basis: "'geospatial_calculation'",
          universe: "'region_area'",
          ...overrides
        };
        return sql.unsafe(
          `INSERT INTO awcms_idn_population_stats
           (dataset_id, region_code, region_level, source_region_name, dimension,
            category, value, unit, reference_year, figure_basis, universe,
            source_table, source_row_hash)
         VALUES ('${datasetId}', ${row.region_code}, 2, 'x', ${row.dimension},
                 ${row.category}, ${row.value}, ${row.unit}, ${row.reference_year},
                 ${row.figure_basis}, ${row.universe}, 'db/wilayah_luas.sql', 'h')`
        );
      };

      await insert({});
      expect(
        (
          (await sql.unsafe(
            `SELECT value::text AS v FROM awcms_idn_population_stats
           WHERE dataset_id = '${datasetId}' AND reference_year = 2023`
          )) as { v: string }[]
        )[0]!.v
      ).toBe("0.001");

      const refused: [Record<string, string>, RegExp][] = [
        [{ value: "0" }, /area_positive_check/],
        [
          { unit: "'jiwa'", reference_year: "2022" },
          /measure_check|jiwa_integral_check/
        ],
        [
          { dimension: "'religion'", reference_year: "2021" },
          /dimension_check/
        ],
        // Both the closed unit list and the measure pairing refuse it; PostgreSQL
        // names whichever it evaluates first.
        [
          { unit: "'ribu_jiwa'", reference_year: "2020" },
          /unit_check|measure_check/
        ],
        [
          {
            dimension: "'sex'",
            category: "'total'",
            unit: "'jiwa'",
            value: "1",
            figure_basis: "'decree'",
            universe: "'total_population'",
            reference_year: "2019"
          },
          /category_check/
        ],
        [{ figure_basis: "'census'", reference_year: "2018" }, /basis_check/]
      ];
      for (const [overrides, pattern] of refused) {
        const error = await assertRejected(
          insert(overrides),
          JSON.stringify(overrides)
        );
        expect(error.message).toMatch(pattern);
      }
    });
  }
);
