/**
 * `commerce` sales-report projections against a REAL migrated PostgreSQL
 * (Issue #117, epic #33 C8, contract #106 / ADR-0017 D7) — through
 * `tests/integration/harness.ts`, under the least-privilege runtime role and
 * FORCE RLS, the way `reporting-projections.integration.test.ts` drives the
 * engine's own probe projection. Gated on `DATABASE_URL`; skips cleanly
 * without one.
 *
 * The issue's own acceptance list, each a property only a database proves:
 *
 *   - `paid` -> a row in each of the three tables, with the order's figures;
 *   - `cancelled` after `paid` -> the figures are subtracted back out, on
 *     the SAME day row, and a never-paid cancellation changes nothing;
 *   - a full rebuild (reset + re-derivation through the same delta functions)
 *     lands on exactly the live, incrementally-maintained rows;
 *   - reconciliation reports no mismatch — control totals recomputed from
 *     the event stream equal the sums over the tables;
 *   - the three read functions the routes/screen use return the projected
 *     rows, and RLS keeps tenant B from seeing tenant A's figures.
 *
 * Fixtures are seeded with raw SQL over the RLS-bypassing admin connection
 * rather than through `order-directory.ts`: this test is about the
 * projections, not the order writer (and #113 is editing that file in
 * parallel). Every event gets a distinct, explicit `created_at` well in the
 * past — both for the cursor-tie limitation the incremental worker's header
 * documents and for its `now() - lag` upper bound (`cursor-boundary.ts`).
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
import { commerceModule } from "../../src/modules/commerce/module";
import {
  listSalesByCategory,
  listSalesByProduct,
  listSalesDaily
} from "../../src/modules/commerce/application/sales-report-directory";
import {
  SALES_BY_CATEGORY_PROJECTION_KEY,
  SALES_BY_PRODUCT_PROJECTION_KEY,
  SALES_DAILY_PROJECTION_KEY
} from "../../src/modules/commerce/domain/sales-report-keys";
import { resolveSalesReportDay } from "../../src/modules/commerce/domain/sales-report-deltas";
import type { ProjectionDescriptor } from "../../src/modules/_shared/module-contract";
import { runIncrementalUpdateForTenant } from "../../src/modules/reporting/application/projection-incremental-worker";
import {
  continueRebuildPasses,
  triggerOrResumeRebuild
} from "../../src/modules/reporting/application/projection-rebuild";
import { reconcileProjection } from "../../src/modules/reporting/application/projection-reconciliation";
import { getProjectionMetrics } from "../../src/modules/reporting/application/projection-metric-store";
import { generateProjectionExport } from "../../src/modules/reporting/application/export-generation";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "11111111-1111-4111-8111-111111111117";
const TENANT_B = "22222222-2222-4222-8222-222222222217";

const CATEGORY_KOPI = "cccccccc-cccc-4ccc-8ccc-ccccccccc117";
const PRODUCT_KOPI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa117";
const PRODUCT_GULA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb117";
const CUSTOMER = "dddddddd-dddd-4ddd-8ddd-ddddddddd117";

/** Anchor well in the past: the incremental worker only reads rows older than `now() - lag` (60 s by default). */
const T0 = Date.now() - 6 * 60 * 60 * 1000;
const PAID_AT = new Date(T0 + 2 * 60_000);
const PAID_DAY = resolveSalesReportDay(PAID_AT);

const DESCRIPTORS = commerceModule.reportingProjections!;
const DAILY = DESCRIPTORS.find((d) => d.key === SALES_DAILY_PROJECTION_KEY)!;
const BY_PRODUCT = DESCRIPTORS.find(
  (d) => d.key === SALES_BY_PRODUCT_PROJECTION_KEY
)!;
const BY_CATEGORY = DESCRIPTORS.find(
  (d) => d.key === SALES_BY_CATEGORY_PROJECTION_KEY
)!;

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedCatalog(tenantId: string): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_commerce_categories (id, tenant_id, name, slug)
    VALUES (${CATEGORY_KOPI}, ${tenantId}, 'Kopi', 'kopi')
  `;
  await admin`
    INSERT INTO awcms_commerce_products (id, tenant_id, category_id, sku, name, slug, price)
    VALUES
      (${PRODUCT_KOPI}, ${tenantId}, ${CATEGORY_KOPI}, 'SKU-KOPI', 'Kopi Arabika 250g', 'kopi-arabika-250g', 50000.00),
      (${PRODUCT_GULA}, ${tenantId}, NULL, 'SKU-GULA', 'Gula Aren', 'gula-aren', 25000.00)
  `;
  await admin`
    INSERT INTO awcms_commerce_customers (id, tenant_id, name, phone)
    VALUES (${CUSTOMER}, ${tenantId}, 'Budi', '+6281234567117')
  `;
}

type SeededOrder = { id: string; code: string };

/** An order with two lines (3 x Kopi = 150 000, 1 x Gula = 25 000): subtotal 175 000, discounts 5 000 + 10 000, shipping 20 000, total 180 000. */
async function seedOrder(
  tenantId: string,
  code: string,
  options: { paid: boolean; eventOffsetMs: number }
): Promise<SeededOrder> {
  const admin = getAdminSql();
  const [order] = (await admin`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method, payment_status,
       shipping_method, shipping_cost, subtotal, discount, voucher_discount, total, paid_at)
    VALUES (${tenantId}, ${code}, ${CUSTOMER},
      ${options.paid ? "paid" : "pending_payment"}, 'manual_bank',
      ${options.paid ? "paid" : "unpaid"}, 'courier', 20000.00, 175000.00,
      5000.00, 10000.00, 180000.00, ${options.paid ? PAID_AT : null})
    RETURNING id
  `) as { id: string }[];
  const orderId = order!.id;

  await admin`
    INSERT INTO awcms_commerce_order_items
      (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
    VALUES
      (${tenantId}, ${orderId}, ${PRODUCT_KOPI}, 'Kopi Arabika 250g', 50000.00, 3, 150000.00),
      (${tenantId}, ${orderId}, ${PRODUCT_GULA}, 'Gula Aren', 25000.00, 1, 25000.00)
  `;

  await seedEvent(
    tenantId,
    orderId,
    null,
    "pending_payment",
    options.eventOffsetMs
  );
  if (options.paid) {
    await seedEvent(
      tenantId,
      orderId,
      "pending_payment",
      "paid",
      options.eventOffsetMs + 60_000
    );
  }

  return { id: orderId, code };
}

async function seedEvent(
  tenantId: string,
  orderId: string,
  fromStatus: string | null,
  toStatus: string,
  offsetMs: number
): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_commerce_order_events
      (tenant_id, order_id, from_status, to_status, actor, created_at)
    VALUES (${tenantId}, ${orderId}, ${fromStatus}, ${toStatus}, 'admin', ${new Date(T0 + offsetMs)})
  `;
}

async function refreshAll(tenantId: string): Promise<void> {
  for (const descriptor of [DAILY, BY_PRODUCT, BY_CATEGORY]) {
    const outcome = await runIncrementalUpdateForTenant(
      getRuntimeSql(),
      descriptor,
      tenantId
    );
    expect(outcome.failed).toBe(false);
    expect(outcome.skippedRebuildInProgress).toBe(false);
  }
}

type TableSnapshot = {
  daily: Awaited<ReturnType<typeof listSalesDaily>>;
  byProduct: Awaited<ReturnType<typeof listSalesByProduct>>;
  byCategory: Awaited<ReturnType<typeof listSalesByCategory>>;
};

async function readTables(tenantId: string): Promise<TableSnapshot> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, async (tx) => {
    const range = { from: "2000-01-01", to: "2999-12-31" };
    return {
      daily: await listSalesDaily(tx, tenantId, range),
      byProduct: await listSalesByProduct(tx, tenantId, range, 50),
      byCategory: await listSalesByCategory(tx, tenantId, range)
    };
  });
}

/** Raw table rows via the admin channel — `updated_at` excluded — to compare rebuild against live byte-for-byte. */
async function rawRows(tenantId: string) {
  const admin = getAdminSql();
  return {
    daily: await admin`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, orders_paid, gross::text, discount::text, shipping::text, net::text
      FROM awcms_commerce_sales_daily WHERE tenant_id = ${tenantId} ORDER BY day`,
    byProduct: await admin`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, product_id, product_name, qty, gross::text
      FROM awcms_commerce_sales_by_product WHERE tenant_id = ${tenantId} ORDER BY day, product_id`,
    byCategory: await admin`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, category_id, category_name, qty, gross::text
      FROM awcms_commerce_sales_by_category WHERE tenant_id = ${tenantId} ORDER BY day, category_id`
  };
}

async function rebuild(
  tenantId: string,
  descriptor: ProjectionDescriptor
): Promise<void> {
  const { run } = await withTenantOrThrow(getRuntimeSql(), tenantId, (tx) =>
    triggerOrResumeRebuild(tx, tenantId, descriptor, {
      requestedBy: null,
      reason: "integration test"
    })
  );
  const result = await continueRebuildPasses(
    getRuntimeSql(),
    tenantId,
    descriptor,
    run.id
  );
  expect(result.status).toBe("completed");
}

async function reconcile(tenantId: string, descriptor: ProjectionDescriptor) {
  return withTenantOrThrow(getRuntimeSql(), tenantId, (tx) =>
    reconcileProjection(tx, tenantId, descriptor, null)
  );
}

suite("commerce sales-report projections (Issue #117)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  });

  afterAll(async () => {
    await teardownIntegrationDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "sales-a");
    await seedTenant(TENANT_B, "sales-b");
    await seedCatalog(TENANT_A);
  });

  test("paid -> one row per table with the order's figures; a never-paid cancellation adds nothing", async () => {
    await seedOrder(TENANT_A, "SLS-0001", { paid: true, eventOffsetMs: 0 });
    const never = await seedOrder(TENANT_A, "SLS-0002", {
      paid: false,
      eventOffsetMs: 5 * 60_000
    });
    await seedEvent(
      TENANT_A,
      never.id,
      "pending_payment",
      "cancelled",
      6 * 60_000
    );

    await refreshAll(TENANT_A);

    const { daily, byProduct, byCategory } = await readTables(TENANT_A);
    expect(daily).toEqual([
      {
        day: PAID_DAY,
        ordersPaid: 1,
        gross: "175000.00",
        discount: "15000.00",
        shipping: "20000.00",
        net: "180000.00"
      }
    ]);
    expect(byProduct).toEqual([
      {
        productId: PRODUCT_KOPI,
        productName: "Kopi Arabika 250g",
        qty: 3,
        gross: "150000.00"
      },
      {
        productId: PRODUCT_GULA,
        productName: "Gula Aren",
        qty: 1,
        gross: "25000.00"
      }
    ]);
    expect(byCategory).toEqual([
      {
        categoryId: CATEGORY_KOPI,
        categoryName: "Kopi",
        qty: 3,
        gross: "150000.00"
      },
      {
        categoryId: null,
        categoryName: "Uncategorised",
        qty: 1,
        gross: "25000.00"
      }
    ]);

    // The scalar counter the engine keeps beside the tables: exactly one
    // paid event consumed, by each of the three descriptors.
    for (const key of [
      SALES_DAILY_PROJECTION_KEY,
      SALES_BY_PRODUCT_PROJECTION_KEY,
      SALES_BY_CATEGORY_PROJECTION_KEY
    ]) {
      const metrics = await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        getProjectionMetrics(tx, TENANT_A, key)
      );
      expect(metrics.paid_events).toBe(1);
    }
  });

  test("cancel after paid subtracts the figures back out on the same day row; a second refresh is a no-op", async () => {
    const order = await seedOrder(TENANT_A, "SLS-0003", {
      paid: true,
      eventOffsetMs: 0
    });
    await refreshAll(TENANT_A);

    // Cancelled a "day" later by wall clock — still attributed to paid_at's day.
    await seedEvent(TENANT_A, order.id, "paid", "cancelled", 3 * 60 * 60_000);
    await refreshAll(TENANT_A);

    const after = await readTables(TENANT_A);
    expect(after.daily).toEqual([
      {
        day: PAID_DAY,
        ordersPaid: 0,
        gross: "0.00",
        discount: "0.00",
        shipping: "0.00",
        net: "0.00"
      }
    ]);
    expect(after.byProduct.map((row) => [row.qty, row.gross])).toEqual([
      [0, "0.00"],
      [0, "0.00"]
    ]);
    expect(after.byCategory.map((row) => [row.qty, row.gross])).toEqual([
      [0, "0.00"],
      [0, "0.00"]
    ]);

    const again = await runIncrementalUpdateForTenant(
      getRuntimeSql(),
      DAILY,
      TENANT_A
    );
    expect(again.rowsProcessed).toBe(0);
    expect((await readTables(TENANT_A)).daily).toEqual(after.daily);
  });

  test("a full rebuild lands on exactly the live rows, and reconciliation reports no mismatch", async () => {
    await seedOrder(TENANT_A, "SLS-0004", { paid: true, eventOffsetMs: 0 });
    const reversed = await seedOrder(TENANT_A, "SLS-0005", {
      paid: true,
      eventOffsetMs: 10 * 60_000
    });
    await seedEvent(TENANT_A, reversed.id, "paid", "processing", 12 * 60_000);
    await seedEvent(
      TENANT_A,
      reversed.id,
      "processing",
      "cancelled",
      13 * 60_000
    );
    await seedOrder(TENANT_A, "SLS-0006", {
      paid: false,
      eventOffsetMs: 20 * 60_000
    });

    await refreshAll(TENANT_A);
    const live = await rawRows(TENANT_A);

    // Sanity: two paid, one reversed -> net one order's figures.
    expect(live.daily).toEqual([
      {
        day: PAID_DAY,
        orders_paid: 1,
        gross: "175000.00",
        discount: "15000.00",
        shipping: "20000.00",
        net: "180000.00"
      }
    ]);

    for (const descriptor of [DAILY, BY_PRODUCT, BY_CATEGORY]) {
      await rebuild(TENANT_A, descriptor);
    }
    const rebuilt = await rawRows(TENANT_A);
    expect(rebuilt).toEqual(live);

    for (const descriptor of [DAILY, BY_PRODUCT, BY_CATEGORY]) {
      const run = await reconcile(TENANT_A, descriptor);
      expect(run.mismatch).toBe(false);
      expect(run.details.length).toBeGreaterThan(1);
      expect(run.details.every((detail) => !detail.mismatch)).toBe(true);
    }
  });

  test("reconciliation DOES flag drift when a table is tampered with", async () => {
    await seedOrder(TENANT_A, "SLS-0007", { paid: true, eventOffsetMs: 0 });
    await refreshAll(TENANT_A);

    await getAdminSql()`
      UPDATE awcms_commerce_sales_daily SET gross = gross + 1 WHERE tenant_id = ${TENANT_A}
    `;

    const run = await reconcile(TENANT_A, DAILY);
    expect(run.mismatch).toBe(true);
    expect(
      run.details.find((detail) => detail.metricKey === "sales_gross_cents")
        ?.mismatch
    ).toBe(true);
  });

  test("a scheduled/manual export of a sales projection writes the dimensional rows as CSV", async () => {
    await seedOrder(TENANT_A, "SLS-0008", { paid: true, eventOffsetMs: 0 });
    await refreshAll(TENANT_A);

    const rootPath = `${process.cwd()}/var/test-reporting-exports-${process.pid}`;
    const run = await generateProjectionExport(
      getRuntimeSql(),
      {
        tenantId: TENANT_A,
        descriptor: BY_PRODUCT,
        format: "csv",
        scheduledExportId: null,
        requestedBy: null
      },
      { ...process.env, REPORTING_EXPORT_ROOT_PATH: rootPath }
    );

    expect(run.status).toBe("completed");
    expect(run.rowCount).toBe(2);
    const content = await Bun.file(run.storagePath!).text();
    const lines = content.split("\n");
    expect(lines[0]).toBe("day,product_id,product_name,qty,gross");
    expect(lines).toHaveLength(3);
    expect(
      lines.some((line) => line.includes("Kopi Arabika 250g,3,150000.00"))
    ).toBe(true);

    await Bun.$`rm -rf ${rootPath}`.quiet();
  });

  test("RLS: tenant B reads none of tenant A's figures", async () => {
    await seedOrder(TENANT_A, "SLS-0009", { paid: true, eventOffsetMs: 0 });
    await refreshAll(TENANT_A);

    const forB = await readTables(TENANT_B);
    expect(forB.daily).toEqual([]);
    expect(forB.byProduct).toEqual([]);
    expect(forB.byCategory).toEqual([]);

    const leaked = await withTenantOrThrow(
      getRuntimeSql(),
      TENANT_B,
      async (tx) =>
        (await tx`SELECT count(*)::int AS count FROM awcms_commerce_sales_daily`) as {
          count: number;
        }[]
    );
    expect(leaked[0]!.count).toBe(0);
  });
});
