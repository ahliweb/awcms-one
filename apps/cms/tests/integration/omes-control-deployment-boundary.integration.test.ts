/**
 * awcms-one issue #212 — the DEPLOYMENT/MIGRATION boundary awcms-one draws
 * around the upstream `omes_control` module synchronized by issue #210
 * (upstream `sql/154`-`sql/158`, ADR-0122 / `ahliweb/omes#196`/`#198`).
 *
 * WHAT THIS FILE IS NOT. It does not re-test `omes_control`'s own unit or
 * application semantics — `tests/integration/omes-control.integration.test.ts`
 * (upstream, synchronized whole) already covers tenant isolation under RLS,
 * default-deny RBAC, safe-vs-destructive operation submission, and idempotent
 * replay for the owner/operator API. It does not re-derive the generic
 * `FORCE ROW LEVEL SECURITY` posture already pinned for the base 22 tables by
 * `db-role-separation.integration.test.ts`, and it does not reimplement
 * `checkWorkerSetupRoleGrants` (`security-readiness-worker-setup-grants.test.ts`
 * already proves that checker fails in both the under- and over-grant
 * directions using policy injection). And it adds NO OMES execution/runtime
 * behaviour — issue #146 moved that ownership to `ahliweb/omes` on purpose;
 * `omes_control` here is a tenant-scoped CONTROL PLANE record store plus an
 * owner/operator API, never a shell/SSH executor (see
 * `omes-control-execution-boundary.test.ts` for the static half of that
 * claim).
 *
 * WHAT THIS FILE IS. awcms-one adds a distinct deployment shape around the
 * synchronized module that nothing upstream tests:
 *
 *   - a flat, lexically-ordered `apps/cms/sql/*.sql` sequence in which
 *     upstream owns `001`-`899` and this repo's own `commerce` module
 *     reserves `901`-`999` (ADR-0015) — `154`-`158` landing must not collide
 *     with that reservation, and the two ranges must apply, in order, onto
 *     ONE clean database with no gap and no duplicate;
 *   - `compose.production.yaml`'s THREE distinct database identities
 *     (`awcms_setup`/`awcms_app`/`awcms_worker`) and `docker/postgres-init/`'s
 *     local bootstrap of them — a topology this repo's own compose files
 *     document, not upstream's;
 *   - that `sql/156`'s narrowing of `awcms_worker` on the eight NEW
 *     `omes_control` tables actually holds on a real, migrated database, with
 *     a NEGATIVE test proving the assertion catches the exact over-grant
 *     `sql/156` was written to revoke.
 *
 * Gated on `DATABASE_URL`, same convention as every other file under
 * `tests/integration/` (see harness.ts's own "GATING" section) — this runs in
 * `check-cms`'s DB-backed `bun test tests/integration/` step, never in the
 * root, DB-free `bun test`.
 */
import { readdirSync } from "node:fs";
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
  getAdminSql,
  getOwnerSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";

const TENANT_A = "0f000000-0000-4000-8000-0000000000a1";
const TENANT_B = "0f000000-0000-4000-8000-0000000000b1";

/**
 * The eight tables `sql/154` created — spelled out literally, on the same
 * principle `db-role-separation.integration.test.ts` documents for its own
 * `FORCED_RLS_TABLES`: a list derived from the same migration it is meant to
 * check could only ever agree with itself. Dropping a `FORCE`/narrowing line
 * from a future `omes_control` migration must fail HERE, against a name this
 * file chose independently.
 */
const OMES_CONTROL_TABLES = [
  "awcms_omes_servers",
  "awcms_omes_enrollments",
  "awcms_omes_deployments",
  "awcms_omes_operation_requests",
  "awcms_omes_jobs",
  "awcms_omes_health_snapshots",
  "awcms_omes_backup_snapshots",
  "awcms_omes_audit_projections"
];

const SQL_DIR = path.resolve(import.meta.dir, "..", "..", "sql");
const COMPOSE_PRODUCTION_PATH = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "compose.production.yaml"
);

const MIGRATION_FILE_PATTERN = /^(\d{3})_awcms_([a-z0-9_]+)\.sql$/;

function migrationFileNames(): string[] {
  return readdirSync(SQL_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

const suite = integrationEnabled ? describe : describe.skip;

suite(
  "awcms-one deployment boundary around the synchronized omes_control module (Issue #212, blocked-on #210)",
  () => {
    beforeAll(async () => {
      await setupIntegrationDatabase();
    }, 120000);

    afterAll(async () => {
      await teardownIntegrationDatabase();
    }, 60000);

    beforeEach(async () => {
      await resetDatabase();
    });

    describe("clean-database forward-only migration sequence: upstream 154-158 alongside commerce 901-999", () => {
      test("154-158 and the full commerce 901-934 set both exist on disk, with no numeric-prefix collision anywhere in sql/", () => {
        const names = migrationFileNames();
        const prefixes = new Map<string, string[]>();

        for (const name of names) {
          const match = MIGRATION_FILE_PATTERN.exec(name);
          expect(match).not.toBeNull();
          const prefix = match![1]!;
          const bucket = prefixes.get(prefix) ?? [];
          bucket.push(name);
          prefixes.set(prefix, bucket);
        }

        // A collision would be TWO files sharing one 3-digit prefix — exactly
        // the failure mode ADR-0015 exists to prevent between upstream's
        // range and commerce's reserved 901-999.
        const collisions = [...prefixes.entries()].filter(
          ([, files]) => files.length > 1
        );
        expect(collisions).toEqual([]);

        const omesFiles = ["154", "155", "156", "157", "158"].map(
          (prefix) => prefixes.get(prefix)?.[0]
        );
        expect(omesFiles.every((name) => name?.includes("omes_control"))).toBe(
          true
        );

        const commercePrefixes = [...prefixes.keys()]
          .filter((p) => Number(p) >= 900)
          .map(Number)
          .sort((a, b) => a - b);
        expect(commercePrefixes.length).toBeGreaterThanOrEqual(34); // 901-934
        expect(Math.min(...commercePrefixes)).toBe(901);
      });

      test("a clean database applied every 154-158 and 901-934 migration exactly once, with distinct checksums, and no gap left mid-sequence", async () => {
        const onDisk = migrationFileNames();

        const applied = (await getOwnerSql()`
          SELECT migration_name, checksum FROM awcms_schema_migrations
          ORDER BY migration_name ASC
        `) as { migration_name: string; checksum: string }[];

        // setupIntegrationDatabase() already ran `bun scripts/db-migrate.ts`
        // to completion in beforeAll (a non-zero exit throws there) — this is
        // the assertion that the LEDGER agrees file-for-file, not just that
        // the process exited 0.
        expect(applied.map((row) => row.migration_name)).toEqual(onDisk);

        const checksums = new Set(applied.map((row) => row.checksum));
        expect(checksums.size).toBe(applied.length);

        const omesApplied = applied.filter((row) =>
          row.migration_name.includes("omes_control")
        );
        expect(omesApplied.length).toBeGreaterThanOrEqual(5);

        const commerceApplied = applied.filter((row) =>
          /^9\d\d_awcms_commerce/.test(row.migration_name)
        );
        expect(commerceApplied.length).toBeGreaterThanOrEqual(34);
      });
    });

    describe("compose.production.yaml's three distinct database identities", () => {
      test("awcms_setup, awcms_app, and awcms_worker are three DIFFERENT roles on the migrated cluster — never the same identity wearing three names", async () => {
        const rows = (await getOwnerSql()`
          SELECT rolname, oid::text AS oid
          FROM pg_roles
          WHERE rolname IN ('awcms_setup', 'awcms_app', 'awcms_worker')
          ORDER BY rolname
        `) as { rolname: string; oid: string }[];

        expect(rows.map((row) => row.rolname)).toEqual([
          "awcms_app",
          "awcms_setup",
          "awcms_worker"
        ]);

        const oids = new Set(rows.map((row) => row.oid));
        expect(oids.size).toBe(3);
      });

      test("compose.production.yaml documents three SEPARATE DSNs (DATABASE_URL / WORKER_DATABASE_URL / SETUP_DATABASE_URL) bound to the migrate/cms/jobs services respectively — the topology issue #212 is about, not upstream's own concern", async () => {
        const text = await Bun.file(COMPOSE_PRODUCTION_PATH).text();

        expect(text).toMatch(/DATABASE_URL:\s*\$\{SETUP_DATABASE_URL:\?/);
        expect(text).toMatch(/DATABASE_URL:\s*\$\{DATABASE_URL:\?/);
        expect(text).toMatch(/DATABASE_URL:\s*\$\{WORKER_DATABASE_URL:\?/);
      });
    });

    describe("OMES-control tenant-scoped tables: RLS ENABLE + FORCE on all eight", () => {
      test("every one of the eight sql/154 tables has RLS both ENABLED and FORCED", async () => {
        const rows = (await getOwnerSql()`
          SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'awcms\\_omes\\_%'
        `) as {
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }[];

        const byName = new Map(rows.map((row) => [row.relname, row]));

        const missing = OMES_CONTROL_TABLES.filter((name) => !byName.has(name));
        expect(missing).toEqual([]);

        const notForced = OMES_CONTROL_TABLES.filter((name) => {
          const row = byName.get(name);
          return !row?.relrowsecurity || !row?.relforcerowsecurity;
        });
        expect(notForced).toEqual([]);
      });
    });

    describe("cross-tenant access to omes_control data fails closed", () => {
      async function seedTwoTenantsWithServers(): Promise<void> {
        const admin = getAdminSql();

        await admin`
          INSERT INTO awcms_tenants (id, tenant_code, tenant_name)
          VALUES (${TENANT_A}, 'omes-boundary-tenant-a', 'OMES Boundary Tenant A'),
                 (${TENANT_B}, 'omes-boundary-tenant-b', 'OMES Boundary Tenant B')
        `;

        await admin`
          INSERT INTO awcms_omes_servers (tenant_id, server_id, hostname, status)
          VALUES (${TENANT_A}, 'srv-boundary-a', 'a.boundary.example.test', 'offline'),
                 (${TENANT_B}, 'srv-boundary-b', 'b.boundary.example.test', 'offline')
        `;
      }

      test("tenant A's context reads zero rows of tenant B's servers — no explicit filter, RLS alone", async () => {
        await seedTwoTenantsWithServers();

        const asTenantA = await withTenantOrThrow(
          getOwnerSql(),
          TENANT_A,
          async (tx) => {
            return (await tx`
              SELECT hostname FROM awcms_omes_servers ORDER BY hostname
            `) as { hostname: string }[];
          }
        );

        expect(asTenantA.map((row) => row.hostname)).toEqual([
          "a.boundary.example.test"
        ]);

        const targeted = await withTenantOrThrow(
          getOwnerSql(),
          TENANT_A,
          async (tx) => {
            return (await tx`
              SELECT hostname FROM awcms_omes_servers WHERE tenant_id = ${TENANT_B}
            `) as { hostname: string }[];
          }
        );
        expect(targeted).toEqual([]);
      });

      test("an INSERT smuggling tenant B's id from tenant A's context is rejected outright", async () => {
        await seedTwoTenantsWithServers();

        let rejected = false;
        try {
          await withTenantOrThrow(getOwnerSql(), TENANT_A, async (tx) => {
            await tx`
              INSERT INTO awcms_omes_servers (tenant_id, server_id, hostname, status)
              VALUES (${TENANT_B}, 'srv-smuggled', 'smuggled.example.test', 'offline')
            `;
          });
        } catch (error) {
          rejected = true;
          expect((error as Error).message).toMatch(/row-level security/i);
        }
        expect(rejected).toBe(true);

        const rows = (await getAdminSql()`
          SELECT 1 FROM awcms_omes_servers WHERE server_id = 'srv-smuggled'
        `) as unknown[];
        expect(rows).toHaveLength(0);
      });

      test("cross-tenant UPDATE/DELETE on omes_control data affect zero rows", async () => {
        await seedTwoTenantsWithServers();

        await withTenantOrThrow(getOwnerSql(), TENANT_A, async (tx) => {
          const updated = await tx`
            UPDATE awcms_omes_servers SET status = 'decommissioned'
            WHERE tenant_id = ${TENANT_B}
          `;
          expect(updated.count).toBe(0);

          const deleted = await tx`
            DELETE FROM awcms_omes_servers WHERE tenant_id = ${TENANT_B}
          `;
          expect(deleted.count).toBe(0);
        });

        const rows = (await getAdminSql()`
          SELECT status FROM awcms_omes_servers WHERE tenant_id = ${TENANT_B}
        `) as { status: string }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("offline");
      });
    });

    describe("awcms_worker least privilege on omes_control tables (sql/156's narrowing) — including the required NEGATIVE test", () => {
      async function workerPrivileges(table: string): Promise<{
        select: boolean;
        insert: boolean;
        update: boolean;
        del: boolean;
      }> {
        const rows = (await getAdminSql()`
          SELECT
            has_table_privilege('awcms_worker', ${table}, 'SELECT') AS select,
            has_table_privilege('awcms_worker', ${table}, 'INSERT') AS insert,
            has_table_privilege('awcms_worker', ${table}, 'UPDATE') AS update,
            has_table_privilege('awcms_worker', ${table}, 'DELETE') AS del
        `) as {
          select: boolean;
          insert: boolean;
          update: boolean;
          del: boolean;
        }[];

        return rows[0]!;
      }

      /**
       * The exact assertion `sql/156` exists to make true forever. Thrown as
       * an Error (rather than using `expect` internally) so the negative test
       * below can deliberately provoke and inspect the failure without this
       * helper's own assertions aborting the test file.
       */
      async function assertWorkerHoldsExactlySelectAndDelete(
        table: string
      ): Promise<void> {
        const priv = await workerPrivileges(table);

        if (!priv.select || !priv.del) {
          throw new Error(
            `awcms_worker is UNDER-granted on ${table}: expected SELECT+DELETE, got ` +
              `select=${priv.select} delete=${priv.del}`
          );
        }

        if (priv.insert || priv.update) {
          throw new Error(
            `awcms_worker is OVER-granted on ${table}: it holds ` +
              `${[priv.insert && "INSERT", priv.update && "UPDATE"]
                .filter(Boolean)
                .join(" and ")} — sql/156 revoked exactly this`
          );
        }
      }

      test("awcms_worker holds SELECT+DELETE, and NEITHER INSERT NOR UPDATE, on all eight tables", async () => {
        for (const table of OMES_CONTROL_TABLES) {
          await assertWorkerHoldsExactlySelectAndDelete(table);
        }
      });

      test("NEGATIVE: reintroducing sql/156's revoked INSERT/UPDATE on awcms_worker is caught by the assertion above, with the exact over-grant message — then the posture is restored and the assertion passes again", async () => {
        const table = "awcms_omes_servers";
        const admin = getAdminSql();

        // Baseline: sql/156's posture holds (this is what CI runs every time).
        await expect(
          assertWorkerHoldsExactlySelectAndDelete(table)
        ).resolves.toBeUndefined();

        // Deliberately reintroduce EXACTLY the over-grant sql/156 revoked —
        // sql/154's original `GRANT SELECT, INSERT, UPDATE, DELETE ... TO
        // awcms_app, awcms_worker`, isolated to awcms_worker.
        await admin.unsafe(`GRANT INSERT, UPDATE ON ${table} TO awcms_worker`);

        let caught: Error | undefined;
        try {
          await assertWorkerHoldsExactlySelectAndDelete(table);
        } catch (error) {
          caught = error as Error;
        } finally {
          // Restore sql/156's posture regardless of outcome — this suite must
          // leave the database exactly as every other test in this file
          // expects to find it.
          await admin.unsafe(
            `REVOKE INSERT, UPDATE ON ${table} FROM awcms_worker`
          );
        }

        // Honestly verified failure, for the RIGHT reason: an over-grant
        // finding naming both revoked verbs, not an unrelated error.
        expect(caught).toBeInstanceOf(Error);
        expect(caught!.message).toMatch(/OVER-granted/);
        expect(caught!.message).toContain(table);
        expect(caught!.message).toMatch(/INSERT/);
        expect(caught!.message).toMatch(/UPDATE/);

        // Restored: the guard passes again, exactly as it did before the
        // deliberate regrant above.
        await expect(
          assertWorkerHoldsExactlySelectAndDelete(table)
        ).resolves.toBeUndefined();
      });
    });

    describe("tenant-facing roles remain default-deny for omes_control permissions", () => {
      test("no role/permission catalog row grants omes_control to a tenant role unless a seed explicitly assigned it — the catalog entries exist, but no role_permissions row exists for a freshly migrated, unseeded tenant", async () => {
        const admin = getAdminSql();

        await admin`
          INSERT INTO awcms_tenants (id, tenant_code, tenant_name)
          VALUES (${TENANT_A}, 'omes-boundary-default-deny', 'OMES Boundary Default Deny')
        `;

        const catalog = (await admin`
          SELECT count(*)::int AS count FROM awcms_permissions
          WHERE module_key = 'omes_control'
        `) as { count: number }[];
        expect(catalog[0]!.count).toBeGreaterThan(0);

        // A brand-new tenant has no roles at all yet (tenant bootstrap seeds
        // them separately) — so, definitionally, no role_permissions row can
        // reference an omes_control permission for it. This is the
        // deployment-time half of "default deny": the permission CATALOG
        // ships seeded (sql/155), but nothing in the migration sequence itself
        // grants a single tenant role access to it.
        const grants = (await admin`
          SELECT count(*)::int AS count
          FROM awcms_role_permissions rp
          JOIN awcms_permissions p ON p.id = rp.permission_id
          WHERE rp.tenant_id = ${TENANT_A} AND p.module_key = 'omes_control'
        `) as { count: number }[];
        expect(grants[0]!.count).toBe(0);
      });
    });

    describe("existing commerce RLS/authorization coverage stays green alongside omes_control", () => {
      test("a commerce table (awcms_commerce_products) is still FORCE'd and tenant-isolated after the 154-158 sync — the two module families do not interfere", async () => {
        const rows = (await getOwnerSql()`
          SELECT relrowsecurity, relforcerowsecurity
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'awcms_commerce_products'
        `) as { relrowsecurity: boolean; relforcerowsecurity: boolean }[];

        expect(rows).toHaveLength(1);
        expect(rows[0]!.relrowsecurity).toBe(true);
        expect(rows[0]!.relforcerowsecurity).toBe(true);

        const admin = getAdminSql();
        await admin`
          INSERT INTO awcms_tenants (id, tenant_code, tenant_name)
          VALUES (${TENANT_A}, 'omes-boundary-commerce-a', 'OMES Boundary Commerce A'),
                 (${TENANT_B}, 'omes-boundary-commerce-b', 'OMES Boundary Commerce B')
        `;
        await admin`
          INSERT INTO awcms_commerce_products (tenant_id, sku, name, slug, price)
          VALUES (${TENANT_A}, 'SKU-OMES-BOUNDARY-A', 'A product', 'a-product-omes-boundary', 1000),
                 (${TENANT_B}, 'SKU-OMES-BOUNDARY-B', 'B product', 'b-product-omes-boundary', 2000)
        `;

        const asTenantA = await withTenantOrThrow(
          getOwnerSql(),
          TENANT_A,
          async (tx) => {
            return (await tx`
              SELECT slug FROM awcms_commerce_products ORDER BY slug
            `) as { slug: string }[];
          }
        );
        expect(asTenantA.map((row) => row.slug)).toEqual([
          "a-product-omes-boundary"
        ]);
      });
    });
  }
);
