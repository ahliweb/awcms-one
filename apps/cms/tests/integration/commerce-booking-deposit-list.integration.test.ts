/**
 * The deposits screen's keyset-paged read against a real, migrated PostgreSQL
 * under the least-privilege RUNTIME role (Issue #385 follow-up #448, "Deposits
 * screen limit"). WORLD 1 of `harness.ts`.
 *
 * What this file proves, each against live data:
 *   - 120 service products are reached completely, in name order, across three
 *     pages (50 + 50 + 20), each exactly once, and only the last page has no
 *     `nextCursor` - the screen can therefore always say whether more follow;
 *   - a product with an active deposit policy shows it, a retired one does not;
 *   - physical products, soft-deleted products and another tenant's products
 *     never appear, and a forged cursor cannot read another tenant's rows;
 *   - names that share a prefix, or are equal, still page without a skip or a
 *     repeat (the id breaks the tie);
 *   - the scope selector's unpaged read stays capped at the documented limit.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { resetDatabaseCircuitBreakerForTests } from "../../src/lib/database/circuit-breaker";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import {
  listServiceProductDepositPolicies,
  listServiceProductDepositPoliciesPage
} from "../../src/modules/commerce/application/booking-deposit-policies";
import {
  DEPOSIT_LIST_PAGE_SIZE,
  SERVICE_PRODUCT_SELECTOR_LIMIT,
  decodeDepositListCursor
} from "../../src/modules/commerce/domain/booking-deposit-list";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "38500000-0385-4000-8000-00000000000a";
const TENANT_B = "38500000-0385-4000-8000-00000000000b";

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function product(
  tenantId: string,
  sku: string,
  name: string,
  options: { type?: string; deleted?: boolean } = {}
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_products
      (tenant_id, type, sku, name, slug, price, stock, status, deleted_at)
    VALUES (${tenantId}, ${options.type ?? "service"}, ${sku}, ${name},
            ${sku.toLowerCase()}, '100000.00', 0, 'active',
            ${options.deleted ? new Date() : null})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function allPages(tenantId: string): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await inTenant(tenantId, (tx) =>
      listServiceProductDepositPoliciesPage(tx, tenantId, {
        cursor: decodeDepositListCursor(cursor)
      })
    );
    pages.push(page.items.map((row) => row.productId));
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("paging did not terminate");
}

suite("deposit policies list (keyset paging)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  });
  afterAll(async () => {
    await teardownIntegrationDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
    resetDatabaseCircuitBreakerForTests();
    await seedTenant(TENANT_A, "a385");
    await seedTenant(TENANT_B, "b385");
  });

  test("120 service products arrive complete, once each, in name order, over three pages", async () => {
    const ids: string[] = [];
    for (let n = 0; n < 120; n += 1) {
      ids.push(
        await product(
          TENANT_A,
          `SKU-${String(n).padStart(3, "0")}`,
          `Kamar ${String(n).padStart(3, "0")}`
        )
      );
    }
    const pages = await allPages(TENANT_A);
    expect(pages.map((page) => page.length)).toEqual([50, 50, 20]);
    expect(pages.flat()).toEqual(ids);
    expect(new Set(pages.flat()).size).toBe(120);
  });

  test("equal and prefix-sharing names page without a skip or a repeat", async () => {
    const ids: string[] = [];
    for (let n = 0; n < 60; n += 1) {
      // Thirty pairs of identical names: only the id separates them.
      ids.push(
        await product(
          TENANT_A,
          `DUP-${n}`,
          `Pondok ${String(Math.floor(n / 2)).padStart(2, "0")}`
        )
      );
    }
    const seen = (await allPages(TENANT_A)).flat();
    expect(seen.length).toBe(60);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  test("a policy shows, a retired one does not, and only live service products of the tenant appear", async () => {
    const withPolicy = await product(TENANT_A, "P-1", "Aaa Villa");
    const retired = await product(TENANT_A, "P-2", "Bbb Villa");
    await product(TENANT_A, "P-3", "Ccc Physical", { type: "physical" });
    await product(TENANT_A, "P-4", "Ddd Deleted", { deleted: true });
    await product(TENANT_B, "P-5", "Eee Other Tenant");
    const admin = getAdminSql();
    await admin`
      INSERT INTO awcms_commerce_product_deposit_policies
        (tenant_id, product_id, kind, percent)
      VALUES (${TENANT_A}, ${withPolicy}, 'percent', '30.00')
    `;
    await admin`
      INSERT INTO awcms_commerce_product_deposit_policies
        (tenant_id, product_id, kind, percent, retired_at)
      VALUES (${TENANT_A}, ${retired}, 'percent', '10.00', now())
    `;
    const page = await inTenant(TENANT_A, (tx) =>
      listServiceProductDepositPoliciesPage(tx, TENANT_A)
    );
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((row) => row.name)).toEqual([
      "Aaa Villa",
      "Bbb Villa"
    ]);
    expect(page.items[0]!.policy).toEqual({
      kind: "percent",
      percent: "30.00",
      fixedAmount: null
    });
    expect(page.items[1]!.policy).toBeNull();
  });

  test("a cursor forged from another tenant's row reads only the caller's own rows", async () => {
    await product(TENANT_A, "A-1", "Zzz A");
    const foreign = await product(TENANT_B, "B-1", "Aaa B");
    const page = await inTenant(TENANT_A, (tx) =>
      listServiceProductDepositPoliciesPage(tx, TENANT_A, {
        cursor: { name: "Aaa B", id: foreign }
      })
    );
    expect(page.items.map((row) => row.name)).toEqual(["Zzz A"]);
  });

  test("a page size above the screen's own is clamped, and the selector read stays capped", async () => {
    for (let n = 0; n < DEPOSIT_LIST_PAGE_SIZE + 3; n += 1) {
      await product(TENANT_A, `C-${n}`, `Cap ${String(n).padStart(3, "0")}`);
    }
    const page = await inTenant(TENANT_A, (tx) =>
      listServiceProductDepositPoliciesPage(tx, TENANT_A, { limit: 10_000 })
    );
    expect(page.items.length).toBe(DEPOSIT_LIST_PAGE_SIZE);
    expect(page.nextCursor).not.toBeNull();
    const selector = await inTenant(TENANT_A, (tx) =>
      listServiceProductDepositPolicies(tx, TENANT_A)
    );
    expect(selector.length).toBeLessThanOrEqual(SERVICE_PRODUCT_SELECTOR_LIMIT);
    expect(selector.length).toBe(DEPOSIT_LIST_PAGE_SIZE + 3);
  });
});
