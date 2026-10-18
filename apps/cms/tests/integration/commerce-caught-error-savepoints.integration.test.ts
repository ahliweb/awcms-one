/**
 * Regression for the "caught error inside a transaction" rule (commerce
 * README, "Savepoints for caught statement errors"): a statement whose error
 * the handler catches runs in a savepoint, so the abort is confined to it and
 * the outer transaction still commits what it already wrote.
 *
 * Without the savepoint the unique violation aborts the transaction and the
 * final COMMIT is answered with ROLLBACK: Bun 1.4.2 silently reported success
 * (every earlier write in the transaction vanished); Bun 1.4.3 throws
 * `ERR_POSTGRES_COMMIT_ROLLED_BACK`. These tests pass on both.
 *
 * Gated on `DATABASE_URL`; skips cleanly without one.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { createExpenseCategory } from "../../src/modules/commerce/application/expense-category-directory";
import { createRegister } from "../../src/modules/commerce/application/register-directory";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const ACTOR = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";

function inTenant<T>(fn: (tx: Bun.TransactionSQL) => Promise<T>): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), TENANT, fn);
}

async function seed(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${TENANT}, 'tenant-sp', 'SP Name', 'SP Legal', 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${TENANT}, 'person', 'Savepoint Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${TENANT}, ${profile[0]!.id}, 'sp-actor@example.test', 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${ACTOR}, ${TENANT}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

suite(
  "commerce: a caught statement error does not poison the transaction",
  () => {
    beforeAll(async () => {
      await setupIntegrationDatabase();
    }, 120000);

    afterAll(async () => {
      await teardownIntegrationDatabase();
    }, 60000);

    beforeEach(async () => {
      await resetDatabase();
      await seed();
    });

    test("a duplicate register code answered in the same transaction keeps the earlier register and the later one", async () => {
      const outcomes = await inTenant(async (tx) => {
        const first = await createRegister(tx, TENANT, ACTOR, {
          code: "KASIR-1",
          name: "First",
          locationLabel: null
        });
        const duplicate = await createRegister(tx, TENANT, ACTOR, {
          code: "kasir-1",
          name: "Dup",
          locationLabel: null
        });
        const after = await createRegister(tx, TENANT, ACTOR, {
          code: "KASIR-2",
          name: "After",
          locationLabel: null
        });
        return [first.kind, duplicate.kind, after.kind];
      });
      expect(outcomes).toEqual(["created", "code_taken", "created"]);

      const rows = (await getAdminSql()`
      SELECT code FROM awcms_commerce_registers
      WHERE tenant_id = ${TENANT} ORDER BY code
    `) as { code: string }[];
      expect(rows.map((row) => row.code)).toEqual(["KASIR-1", "KASIR-2"]);

      // The audit rows of the two successful creates survive as well.
      const audit = (await getAdminSql()`
      SELECT count(*)::int AS n FROM awcms_audit_events
      WHERE tenant_id = ${TENANT} AND action = 'register.create'
    `) as { n: number }[];
      expect(audit[0]!.n).toBe(2);
    });

    test("a duplicate expense category code leaves the earlier category committed", async () => {
      const kinds = await inTenant(async (tx) => {
        const first = await createExpenseCategory(tx, TENANT, ACTOR, {
          code: "RENT",
          name: "Rent"
        });
        const duplicate = await createExpenseCategory(tx, TENANT, ACTOR, {
          code: "rent",
          name: "Rent again"
        });
        return [first.kind, duplicate.kind];
      });
      expect(kinds).toEqual(["created", "code_taken"]);

      const rows = (await getAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_expense_categories
      WHERE tenant_id = ${TENANT}
    `) as { n: number }[];
      expect(rows[0]!.n).toBe(1);
    });

    test("tx.savepoint re-throws the original PostgresError and keeps the transaction usable", async () => {
      await inTenant(async (tx) => {
        await createRegister(tx, TENANT, ACTOR, {
          code: "R1",
          name: "R1",
          locationLabel: null
        });
        let caught: unknown;
        try {
          await tx.savepoint(async (sp) => {
            await sp`
            INSERT INTO awcms_commerce_registers (
              tenant_id, code, name, location_label,
              created_by_tenant_user_id, updated_by_tenant_user_id
            ) VALUES (${TENANT}, 'r1', 'dup', NULL, ${ACTOR}, ${ACTOR})
          `;
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(Bun.SQL.PostgresError);
        expect(String((caught as { errno: unknown }).errno)).toBe("23505");
        // The transaction is not aborted: a further statement runs.
        const rows = (await tx`SELECT 1 AS one`) as { one: number }[];
        expect(rows[0]!.one).toBe(1);
      });
      const rows = (await getAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_registers WHERE tenant_id = ${TENANT}
    `) as { n: number }[];
      expect(rows[0]!.n).toBe(1);
    });
  }
);
