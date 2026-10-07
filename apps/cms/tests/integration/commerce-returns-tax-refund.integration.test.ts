/**
 * Refunding the tax on returned units (Issue #323, ADR-0033 tax addendum)
 * against a REAL migrated Postgres through `tests/integration/harness.ts`.
 * Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * Covers what only a database can prove:
 *   - flat mode: the order's tax is prorated per unit with the same
 *     decomposition as goods/discount; the parts of successive returns add up
 *     to the order's tax to the cent, `refund_total` carries the tax, the
 *     refund legs and the payment-ledger reversals add up to it, and the
 *     order's whole total is back once every unit is returned;
 *   - engine mode (exclusive pricing): `tax_refund` equals the reversal
 *     snapshot's tax total exactly, and the money refunded equals goods + the
 *     ledger's reversed tax; a same-key replay reverses and refunds nothing
 *     twice; a refused refund leaves no reversal snapshot behind;
 *   - engine mode, inclusive pricing: nothing is added (the tax is inside the
 *     goods value already refunded) while the ledger still reverses it;
 *   - the returns report reconciles: returned value == refunded total;
 *   - the database refuses a return whose tax exceeds the order's, and a
 *     `refund_total` that omits the tax term.
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
import { createPosOrder } from "../../src/modules/commerce/application/pos-directory";
import {
  fetchReturnsReport,
  summariseReturns
} from "../../src/modules/commerce/application/operational-report-directory";
import { createReturn } from "../../src/modules/commerce/application/return-directory";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { runTaxCutoverForTenant } from "../../src/modules/commerce/application/tax-cutover";
import { commerceModule } from "../../src/modules/commerce/module";
import { POS_RETURNS_DAILY_PROJECTION_KEY } from "../../src/modules/commerce/domain/operational-report-keys";
import type { CreatePosOrderInput } from "../../src/modules/commerce/domain/pos-order-validation";
import type {
  CreateReturnInput,
  CreateReturnRefundInput
} from "../../src/modules/commerce/domain/returns";
import { SALES_REPORT_TIME_ZONE } from "../../src/modules/commerce/domain/sales-report-deltas";
import { businessDateInTimeZone } from "../../src/modules/commerce/domain/tax-adapter";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { runIncrementalUpdateForTenant } from "../../src/modules/reporting/application/projection-incremental-worker";
import {
  continueRebuildPasses,
  triggerOrResumeRebuild
} from "../../src/modules/reporting/application/projection-rebuild";
import { reconcileProjection } from "../../src/modules/reporting/application/projection-reconciliation";
import {
  createDraftVersion,
  publishRuleVersion
} from "../../src/modules/tax/application/tax-rule-version-directory";
import { listSnapshots } from "../../src/modules/tax/application/tax-snapshot-directory";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a323";
const STAFF = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c323";
const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;

const DESCRIPTOR = commerceModule.reportingProjections!.find(
  (d) => d.key === POS_RETURNS_DAILY_PROJECTION_KEY
)!;

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
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

async function seedStaff(tenantId: string): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Tax Refund Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`tax-refund-${tenantId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${STAFF}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function configureStore(tenantId: string, percent: number) {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Pajak",
    shipping: { selfPickup: true },
    payment: {
      manualQris: { active: true, mediaObjectId: null },
      tax: { active: true, percent }
    }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, STAFF, validated.value)
  );
  await inTenant(tenantId, (tx) =>
    updateModuleSettings(
      tx,
      tenantId,
      "commerce",
      {
        features: {
          pos: true,
          inbox: false,
          campaigns: false,
          gateway: false,
          courier: false,
          register: false,
          documents: false,
          loyalty: false,
          storedValue: false,
          returns: true
        }
      },
      STAFF
    )
  );
}

async function seedProduct(
  tenantId: string,
  sku: string,
  price: string
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_products
      (tenant_id, sku, name, slug, price, stock, status)
    VALUES (${tenantId}, ${sku}, ${sku}, ${sku.toLowerCase()}, ${price}, 100, 'active')
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

let keySeq = 0;
const key = (): string =>
  `00000000-0000-4000-8000-${String(++keySeq).padStart(12, "0")}`;

function posInput(productId: string, quantity: number): CreatePosOrderInput {
  return {
    idempotencyKey: key(),
    customer: { name: null, phone: null },
    lines: [{ productId, variantId: null, quantity }],
    payment: { method: "cash", amountTendered: "1000000.00" },
    tenders: null,
    allowDue: false,
    notes: null,
    registerId: null
  } as CreatePosOrderInput;
}

async function sell(
  productId: string,
  quantity: number,
  now: Date = NOW
): Promise<{ orderId: string; itemId: string }> {
  const sale = await inTenant(TENANT_A, (tx) =>
    createPosOrder(
      tx,
      TENANT_A,
      STAFF,
      mediaLibraryPortAdapter,
      posInput(productId, quantity),
      now
    )
  );
  if (sale.kind !== "created")
    throw new Error(`sale not created: ${sale.kind}`);
  const orders = (await getAdminSql()`
    SELECT id FROM awcms_commerce_orders WHERE order_code = ${sale.order.orderCode}
  `) as { id: string }[];
  const orderId = orders[0]!.id;
  const items = (await getAdminSql()`
    SELECT id FROM awcms_commerce_order_items WHERE order_id = ${orderId}
  `) as { id: string }[];
  return { orderId, itemId: items[0]!.id };
}

function returnInput(
  itemId: string,
  quantity: number,
  refund: CreateReturnRefundInput | null = {
    destination: "original_tender",
    shippingRefund: null,
    registerSessionId: null,
    storeCreditAccountId: null
  },
  idempotencyKey: string = key()
): CreateReturnInput {
  return {
    idempotencyKey,
    kind: "return",
    lines: [
      {
        orderItemId: itemId,
        quantity,
        reason: "defective",
        disposition: "restock",
        note: null
      }
    ],
    note: null,
    refund,
    exchangeOrderId: null
  };
}

async function doReturn(orderId: string, input: CreateReturnInput) {
  return inTenant(TENANT_A, (tx) =>
    createReturn(tx, TENANT_A, STAFF, orderId, input, NOW)
  );
}

type ReturnRow = {
  id: string;
  goods_gross: string;
  discount_share: string;
  shipping_refund: string;
  tax_refund: string;
  refund_total: string;
};

async function returnsOf(orderId: string): Promise<ReturnRow[]> {
  return (await getAdminSql()`
    SELECT id, goods_gross::text, discount_share::text, shipping_refund::text,
           tax_refund::text, refund_total::text
    FROM awcms_commerce_returns WHERE order_id = ${orderId}
    ORDER BY created_at, id
  `) as ReturnRow[];
}

const cents = (value: string): bigint => {
  const negative = value.startsWith("-");
  const [whole, frac = ""] = (negative ? value.slice(1) : value).split(".");
  const total = BigInt(whole!) * 100n + BigInt((frac + "00").slice(0, 2));
  return negative ? -total : total;
};

async function sumLegs(orderId: string): Promise<bigint> {
  const rows = (await getAdminSql()`
    SELECT COALESCE(SUM(amount), 0)::text AS total FROM awcms_commerce_refunds
    WHERE order_id = ${orderId} AND status = 'succeeded'
  `) as { total: string }[];
  return cents(rows[0]!.total);
}

async function sumLedgerReversals(orderId: string): Promise<bigint> {
  const rows = (await getAdminSql()`
    SELECT COALESCE(SUM(amount), 0)::text AS total
    FROM awcms_commerce_payment_allocations
    WHERE order_id = ${orderId} AND kind = 'reversal' AND status = 'succeeded'
  `) as { total: string }[];
  return cents(rows[0]!.total);
}

async function reversalSnapshots() {
  return inTenant(
    TENANT_A,
    async (tx) =>
      (await listSnapshots(tx, TENANT_A, { kind: "reversal" })).snapshots
  );
}

suite("returns refund the tax on returned units (Issue #323)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-tax-refund");
    await seedStaff(TENANT_A);
    await configureStore(TENANT_A, 11);
  }, 30000);

  test("flat mode: tax is prorated per unit to the cent, refunded in full across returns, and the ledger and legs agree", async () => {
    // 3 x 333.33 = 999.99; tax 11 % = 110.00 (109.9989, half-up).
    const product = await seedProduct(TENANT_A, "FLAT-R", "333.33");
    const { orderId, itemId } = await sell(product, 3);
    const order = (await getAdminSql()`
      SELECT tax::text, total::text FROM awcms_commerce_orders WHERE id = ${orderId}
    `) as { tax: string; total: string }[];
    expect(order[0]!.tax).toBe("110.00");
    expect(order[0]!.total).toBe("1109.99");

    for (const quantity of [1, 1, 1]) {
      const outcome = await doReturn(orderId, returnInput(itemId, quantity));
      expect(outcome.kind).toBe("created");
    }
    const returns = await returnsOf(orderId);
    // The first units carry the leftover cent: 36.67 + 36.67 + 36.66.
    expect(returns.map((r) => r.tax_refund)).toEqual([
      "36.67",
      "36.67",
      "36.66"
    ]);
    for (const r of returns) {
      expect(cents(r.refund_total)).toBe(
        cents(r.goods_gross) -
          cents(r.discount_share) +
          cents(r.shipping_refund) +
          cents(r.tax_refund)
      );
    }
    const taxTotal = returns.reduce((sum, r) => sum + cents(r.tax_refund), 0n);
    const refundTotal = returns.reduce(
      (sum, r) => sum + cents(r.refund_total),
      0n
    );
    expect(taxTotal).toBe(11000n);
    // Everything came back: goods + tax = the order's total, to the cent.
    expect(refundTotal).toBe(110999n);
    expect(await sumLegs(orderId)).toBe(refundTotal);
    expect(await sumLedgerReversals(orderId)).toBe(refundTotal);
    // A flat order has no snapshot: nothing in the tax ledger.
    expect(await reversalSnapshots()).toHaveLength(0);

    // Nothing is left to return.
    const again = await doReturn(orderId, returnInput(itemId, 1));
    expect(again.kind).toBe("quantity_exceeded");
  });

  test("engine mode: tax_refund equals the reversal snapshot exactly, money and ledger agree, a replay does nothing twice, the report reconciles", async () => {
    const product = await seedProduct(TENANT_A, "ENG-R", "10000.00");
    await inTenant(TENANT_A, (tx) =>
      runTaxCutoverForTenant(tx, TENANT_A, { commit: true })
    );
    const { orderId, itemId } = await sell(product, 4); // tax 4,400.00

    const firstKey = key();
    const first = await doReturn(
      orderId,
      returnInput(itemId, 1, undefined, firstKey)
    );
    expect(first.kind).toBe("created");
    const second = await doReturn(orderId, returnInput(itemId, 3));
    expect(second.kind).toBe("created");

    const returns = await returnsOf(orderId);
    expect(returns.map((r) => r.tax_refund)).toEqual(["1100.00", "3300.00"]);
    expect(returns.map((r) => r.refund_total)).toEqual([
      "11100.00",
      "33300.00"
    ]);

    // The tax ledger and the money agree to the cent.
    const reversals = await reversalSnapshots();
    expect(reversals).toHaveLength(2);
    const reversedTax = reversals.reduce(
      (sum, snapshot) => sum + cents(snapshot.taxTotal),
      0n
    );
    expect(-reversedTax).toBe(
      returns.reduce((sum, r) => sum + cents(r.tax_refund), 0n)
    );
    for (const r of returns) {
      const snapshot = reversals.find(
        (s) => s.documentId === `return:${r.id}`
      )!;
      expect(cents(snapshot.taxTotal)).toBe(-cents(r.tax_refund));
    }

    const refundTotal = returns.reduce(
      (sum, r) => sum + cents(r.refund_total),
      0n
    );
    expect(await sumLegs(orderId)).toBe(refundTotal);
    expect(await sumLedgerReversals(orderId)).toBe(refundTotal);

    // Idempotent replay: the same key reverses and refunds nothing again.
    const replay = await doReturn(
      orderId,
      returnInput(itemId, 1, undefined, firstKey)
    );
    expect(replay.kind).toBe("replayed");
    expect(await reversalSnapshots()).toHaveLength(2);
    expect(await returnsOf(orderId)).toHaveLength(2);
    expect(await sumLegs(orderId)).toBe(refundTotal);

    // The returns report reconciles: value returned == money refunded.
    const outcome = await runIncrementalUpdateForTenant(
      getRuntimeSql(),
      DESCRIPTOR,
      TENANT_A
    );
    expect(outcome.failed).toBe(false);
    // The incremental pass and a rebuild must agree; the rebuild is the proof.
    const { run } = await inTenant(TENANT_A, (tx) =>
      triggerOrResumeRebuild(tx, TENANT_A, DESCRIPTOR, {
        requestedBy: null,
        reason: "integration test"
      })
    );
    const rebuilt = await continueRebuildPasses(
      getRuntimeSql(),
      TENANT_A,
      DESCRIPTOR,
      run.id
    );
    expect(rebuilt.status).toBe("completed");
    const day = (offset: number) =>
      businessDateInTimeZone(
        new Date(Date.now() + offset * DAY),
        SALES_REPORT_TIME_ZONE
      );
    const report = await inTenant(TENANT_A, (tx) =>
      fetchReturnsReport(tx, TENANT_A, { from: day(-1), to: day(1) })
    );
    expect(report.returnCount).toBe(2);
    expect(report.returnedValue).toBe("44400.00");
    expect(report.refundedTotal).toBe("44400.00");
    expect(summariseReturns(report.items).returnedValue).toBe("44400.00");
    const reconcile = await inTenant(TENANT_A, (tx) =>
      reconcileProjection(tx, TENANT_A, DESCRIPTOR, null)
    );
    expect(reconcile.mismatch).toBe(false);
  });

  test("a refused refund leaves no tax reversal behind (the engine-mode savepoint rolls back)", async () => {
    const product = await seedProduct(TENANT_A, "ENG-X", "10000.00");
    await inTenant(TENANT_A, (tx) =>
      runTaxCutoverForTenant(tx, TENANT_A, { commit: true })
    );
    const { orderId, itemId } = await sell(product, 2);

    // Stored value is disabled for this tenant: the refund is refused.
    const outcome = await doReturn(
      orderId,
      returnInput(itemId, 1, {
        destination: "store_credit",
        shippingRefund: null,
        registerSessionId: null,
        storeCreditAccountId: null
      })
    );
    expect(outcome.kind).toBe("refund_refused");
    expect(await reversalSnapshots()).toHaveLength(0);
    expect(await returnsOf(orderId)).toHaveLength(0);
  });

  test("engine mode, inclusive pricing: no tax is added to the refund (it is inside the goods value) while the ledger still reverses it", async () => {
    const product = await seedProduct(TENANT_A, "INC-R", "10000.00");
    await inTenant(TENANT_A, (tx) =>
      runTaxCutoverForTenant(tx, TENANT_A, { commit: true })
    );
    const taxDate = businessDateInTimeZone(
      new Date(Date.now() + DAY),
      SALES_REPORT_TIME_ZONE
    );
    await inTenant(TENANT_A, async (tx) => {
      const draft = await createDraftVersion(tx, TENANT_A, STAFF, {
        profileCode: "store-default",
        name: "Inclusive",
        jurisdictionCode: "store",
        countryCode: null,
        regionCode: null,
        currencyCode: "IDR",
        pricingMode: "inclusive",
        roundingMode: "half_up",
        roundingScale: 2,
        roundingLevel: "document",
        effectiveFrom: taxDate,
        notes: null,
        definition: {
          categories: [],
          rules: [
            {
              categoryCode: null,
              treatment: "taxable",
              components: [
                { code: "tax", name: "Tax", rate: "11", basis: "net" }
              ]
            }
          ]
        }
      });
      const published = await publishRuleVersion(tx, TENANT_A, STAFF, draft.id);
      expect(published.kind).toBe("published");
    });

    const { orderId, itemId } = await sell(
      product,
      2,
      new Date(Date.now() + DAY)
    );
    const order = (await getAdminSql()`
      SELECT tax::text, total::text FROM awcms_commerce_orders WHERE id = ${orderId}
    `) as { tax: string; total: string }[];
    // Inclusive: the total is the prices, the tax is extracted from them.
    expect(order[0]!.total).toBe("20000.00");
    expect(cents(order[0]!.tax)).toBeGreaterThan(0n);

    const outcome = await doReturn(orderId, returnInput(itemId, 1));
    expect(outcome.kind).toBe("created");
    const [row] = await returnsOf(orderId);
    expect(row!.tax_refund).toBe("0.00");
    expect(row!.refund_total).toBe("10000.00");
    const reversals = await reversalSnapshots();
    expect(reversals).toHaveLength(1);
    expect(cents(reversals[0]!.taxTotal)).toBeLessThan(0n);
    expect(await sumLegs(orderId)).toBe(1000000n);
  });

  test("the database refuses tax refunded beyond the order's tax and a refund_total without its tax term", async () => {
    const product = await seedProduct(TENANT_A, "GUARD-R", "10000.00");
    const { orderId } = await sell(product, 1); // tax 1,100.00
    const insert = async (tax: string, total: string, source: string) => {
      await getAdminSql()`
        INSERT INTO awcms_commerce_returns
          (tenant_id, order_id, goods_gross, discount_share, shipping_refund,
           tax_refund, refund_total, source_key, actor_tenant_user_id)
        VALUES (${TENANT_A}, ${orderId}, 0, 0, 0, ${tax}, ${total}, ${source}, ${STAFF})
      `;
    };

    // refund_total must carry the tax term.
    await expect(insert("5.00", "0.00", "guard:1")).rejects.toThrow();
    // Tax beyond the order's own.
    await expect(insert("1100.01", "1100.01", "guard:2")).rejects.toThrow(
      /tax refunded/
    );
    // Exactly the order's tax is fine (a goods-less return is a test shape).
    await insert("1100.00", "1100.00", "guard:3");
    await expect(insert("0.01", "0.01", "guard:4")).rejects.toThrow(
      /tax refunded/
    );
  });
});
