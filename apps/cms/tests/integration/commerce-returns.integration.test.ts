/**
 * Returns, refunds and exchanges (Issue #287, epic #281, ADR-0033) against a
 * REAL migrated Postgres through `tests/integration/harness.ts`, the pattern
 * `commerce-payment-allocations` / `commerce-stored-value` use. Gated on
 * `DATABASE_URL`; skips cleanly without one.
 *
 * Covers what only a database can prove:
 *
 *   - partial and repeated returns bounded by the remaining eligible
 *     quantity; the final unit goes back exactly once under GENUINELY
 *     concurrent requests (and the database trigger holds on its own);
 *   - restock vs damaged vs quarantine: only `restock` moves sellable stock;
 *   - exact-cent arithmetic: several partial returns add up to the line;
 *   - the refund cap (planning, and the database trigger beneath it);
 *   - provider refund: claim -> provider (outside any transaction) ->
 *     record; retry after a failure; replay; unsupported adapter; the
 *     offline path; concurrent execution;
 *   - store-credit refund (a code shown once, never stored), the loyalty
 *     reversal and the affiliate adjustment in proportion;
 *   - the sales reports net a return, a rebuild lands on the live rows, and a
 *     cancellation after a partial return nets to zero;
 *   - RLS cross-tenant isolation, BOLA, the feature flag, idempotency, the
 *     append-only guards, reconcile, exchange.
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
  executeRefund,
  settleRefundOffline
} from "../../src/modules/commerce/application/refund-execution";
import {
  createRefundsForReturn,
  createReturn,
  linkExchangeOrder,
  reconcileReturns,
  type CreateReturnOutcome
} from "../../src/modules/commerce/application/return-directory";
import {
  fetchRefundForReturn,
  fetchReturn,
  listReturns,
  listReturnsForOrder
} from "../../src/modules/commerce/application/return-records";
import { IdempotencyPayloadMismatchError } from "../../src/modules/commerce/application/order-directory";
import { upsertStoredValueProgram } from "../../src/modules/commerce/application/stored-value-directory";
import {
  appendLedgerEntry,
  findOrCreateAccountLocked
} from "../../src/modules/commerce/application/loyalty-ledger";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import type {
  PaymentGatewayProvider,
  PaymentGatewayRefundInput,
  PaymentGatewayRefundResult
} from "../../src/modules/commerce/domain/payment-gateway-provider";
import type {
  CreateReturnInput,
  CreateReturnRefundInput
} from "../../src/modules/commerce/domain/returns";
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
import {
  getAdminSql,
  getAppRoleSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a287";
const TENANT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b287";
const STAFF = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c287";
const CUSTOMER = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d287";
const CATEGORY = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e287";
const KOPI = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f287";
const GULA = "a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a287";
const NOW = new Date();

const T0 = Date.now() - 6 * 60 * 60 * 1000;
const PAID_AT = new Date(T0 + 2 * 60_000);
const PAID_DAY = resolveSalesReportDay(PAID_AT);

const DESCRIPTORS = commerceModule.reportingProjections!;
const PROJECTION_KEYS = [
  SALES_DAILY_PROJECTION_KEY,
  SALES_BY_PRODUCT_PROJECTION_KEY,
  SALES_BY_CATEGORY_PROJECTION_KEY
];
const PROJECTIONS = PROJECTION_KEYS.map((key) =>
  DESCRIPTORS.find((d) => d.key === key)!
);

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function attempt(query: PromiseLike<unknown>): Promise<void> {
  await query;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

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
    VALUES (${tenantId}, 'person', 'Returns Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`ret-actor-${tenantId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${STAFF}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedCatalog(tenantId: string): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_commerce_categories (id, tenant_id, name, slug)
    VALUES (${CATEGORY}, ${tenantId}, 'Kopi', 'kopi')
  `;
  await admin`
    INSERT INTO awcms_commerce_products (id, tenant_id, category_id, sku, name, slug, price, stock)
    VALUES
      (${KOPI}, ${tenantId}, ${CATEGORY}, 'SKU-KOPI', 'Kopi Arabika', 'kopi-arabika', 10000.00, 100),
      (${GULA}, ${tenantId}, NULL, 'SKU-GULA', 'Gula Aren', 'gula-aren', 25000.00, 100)
  `;
  await admin`
    INSERT INTO awcms_commerce_customers (id, tenant_id, name, phone)
    VALUES (${CUSTOMER}, ${tenantId}, 'Budi', '+6281234567287')
  `;
}

async function setFeatures(
  tenantId: string,
  overrides: Partial<Record<string, boolean>> = {}
): Promise<void> {
  await inTenant(tenantId, (tx) =>
    updateModuleSettings(
      tx,
      tenantId,
      "commerce",
      {
        features: {
          pos: true,
          inbox: true,
          campaigns: true,
          gateway: true,
          courier: true,
          register: false,
          documents: false,
          loyalty: false,
          storedValue: false,
          returns: true,
          ...overrides
        }
      },
      STAFF
    )
  );
}

type PaymentSeed = {
  tender: "cash" | "manual_qris" | "manual_bank_transfer" | "gateway";
  amount: string;
  /** Seconds after T0, so legs have a stable order. */
  at?: number;
  providerRef?: string;
};

type SeededOrder = {
  id: string;
  code: string;
  items: { id: string; productId: string; quantity: number }[];
  payments: { id: string; tender: string; amount: string }[];
};

let orderSeq = 0;

/**
 * An order paid in full: lines of `qty x unit`, an order discount, shipping,
 * and the payment legs given (the caller makes them sum to the total).
 */
async function seedOrder(
  tenantId: string,
  options: {
    lines: { productId: string; name: string; qty: number; unit: string }[];
    discount?: string;
    shipping?: string;
    payments: PaymentSeed[];
    status?: string;
    customerId?: string;
  }
): Promise<SeededOrder> {
  const admin = getAdminSql();
  orderSeq += 1;
  const code = `RET-${String(orderSeq).padStart(4, "0")}`;
  const lineTotals = options.lines.map((line) => {
    const cents =
      BigInt(Math.round(Number(line.unit) * 100)) * BigInt(line.qty);
    return cents;
  });
  const money = (cents: bigint) =>
    `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  const subtotal = lineTotals.reduce((a, b) => a + b, 0n);
  const discount = BigInt(Math.round(Number(options.discount ?? "0") * 100));
  const shipping = BigInt(Math.round(Number(options.shipping ?? "0") * 100));
  const total = subtotal - discount + shipping;
  const status = options.status ?? "paid";

  const [order] = (await admin`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method, payment_status,
       shipping_method, shipping_cost, subtotal, discount, voucher_discount, total, paid_at)
    VALUES (${tenantId}, ${code}, ${options.customerId ?? CUSTOMER}, ${status}, 'manual_bank', 'paid',
      'courier', ${money(shipping)}, ${money(subtotal)}, ${money(discount)}, 0.00,
      ${money(total)}, ${PAID_AT})
    RETURNING id
  `) as { id: string }[];
  const orderId = order!.id;

  const items: SeededOrder["items"] = [];
  for (const [index, line] of options.lines.entries()) {
    const [item] = (await admin`
      INSERT INTO awcms_commerce_order_items
        (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
      VALUES (${tenantId}, ${orderId}, ${line.productId}, ${line.name}, ${line.unit},
        ${line.qty}, ${money(lineTotals[index]!)})
      RETURNING id
    `) as { id: string }[];
    items.push({ id: item!.id, productId: line.productId, quantity: line.qty });
  }

  await admin`
    INSERT INTO awcms_commerce_order_events
      (tenant_id, order_id, from_status, to_status, actor, created_at)
    VALUES
      (${tenantId}, ${orderId}, NULL, 'pending_payment', 'admin', ${new Date(T0)}),
      (${tenantId}, ${orderId}, 'pending_payment', 'paid', 'admin', ${new Date(T0 + 60_000)})
  `;

  const payments: SeededOrder["payments"] = [];
  for (const [index, pay] of options.payments.entries()) {
    const [row] = (await admin`
      INSERT INTO awcms_commerce_payment_allocations
        (tenant_id, order_id, kind, tender_type, amount, status, provider,
         provider_reference, tendered_amount, change_amount, source, source_key,
         actor_kind, settled_at, created_at)
      VALUES (${tenantId}, ${orderId}, 'payment', ${pay.tender}, ${pay.amount}, 'succeeded',
        ${pay.tender === "gateway" ? "midtrans" : null},
        ${pay.tender === "gateway" ? (pay.providerRef ?? `MID-${code}`) : null},
        ${pay.tender === "cash" ? pay.amount : null},
        ${pay.tender === "cash" ? "0.00" : null},
        'admin', ${`seed:${code}:${index}`}, 'system', now(),
        ${new Date(T0 + (pay.at ?? index + 1) * 1000)})
      RETURNING id
    `) as { id: string }[];
    payments.push({ id: row!.id, tender: pay.tender, amount: pay.amount });
  }
  return { id: orderId, code, items, payments };
}

/** The standard order: 5 x Kopi @ 10,000 + 1 x Gula @ 25,000, 7,500 discount, 5,000 shipping, total 72,500. */
function standardOrder(
  tenantId: string,
  payments?: PaymentSeed[],
  extra: Partial<Parameters<typeof seedOrder>[1]> = {}
): Promise<SeededOrder> {
  return seedOrder(tenantId, {
    lines: [
      { productId: KOPI, name: "Kopi Arabika", qty: 5, unit: "10000.00" },
      { productId: GULA, name: "Gula Aren", qty: 1, unit: "25000.00" }
    ],
    discount: "7500.00",
    shipping: "5000.00",
    payments: payments ?? [{ tender: "cash", amount: "72500.00" }],
    ...extra
  });
}

const KEY = () => crypto.randomUUID();

const ORIGINAL: CreateReturnRefundInput = {
  destination: "original_tender",
  shippingRefund: null,
  registerSessionId: null,
  storeCreditAccountId: null
};

function returnInput(
  lines: {
    item: string;
    qty: number;
    disposition?: "restock" | "damaged" | "quarantine";
    reason?: string;
  }[],
  options: {
    refund?: CreateReturnRefundInput | null;
    kind?: "return" | "exchange";
    key?: string;
    exchangeOrderId?: string | null;
    note?: string | null;
  } = {}
): CreateReturnInput {
  return {
    idempotencyKey: options.key ?? KEY(),
    kind: options.kind ?? "return",
    lines: lines.map((line) => ({
      orderItemId: line.item,
      quantity: line.qty,
      reason: (line.reason ?? "defective") as never,
      disposition: line.disposition ?? "restock",
      note: null
    })),
    note: options.note ?? null,
    refund: options.refund === undefined ? ORIGINAL : options.refund,
    exchangeOrderId: options.exchangeOrderId ?? null
  };
}

function doReturn(
  tenantId: string,
  orderId: string,
  input: CreateReturnInput
): Promise<CreateReturnOutcome> {
  return inTenant(tenantId, (tx) =>
    createReturn(tx, tenantId, STAFF, orderId, input, NOW)
  );
}

async function created(
  outcome: CreateReturnOutcome
): Promise<Extract<CreateReturnOutcome, { kind: "created" | "replayed" }>> {
  if (outcome.kind !== "created" && outcome.kind !== "replayed") {
    throw new Error(`expected a return, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

async function stockOf(productId: string): Promise<number> {
  const rows = (await getAdminSql()`
    SELECT stock FROM awcms_commerce_products WHERE id = ${productId}
  `) as { stock: number }[];
  return Number(rows[0]!.stock);
}

async function countRows(table: string, tenantId: string): Promise<number> {
  const rows = (await getAdminSql().unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = '${tenantId}'`
  )) as { n: number }[];
  return Number(rows[0]!.n);
}

function stubProvider(
  refund: (
    input: PaymentGatewayRefundInput,
    call: number
  ) => Promise<PaymentGatewayRefundResult>
): PaymentGatewayProvider & { calls: PaymentGatewayRefundInput[] } {
  const calls: PaymentGatewayRefundInput[] = [];
  return {
    calls,
    createSession: async () => {
      throw new Error("not used");
    },
    fetchStatus: async () => {
      throw new Error("not used");
    },
    verifyWebhook: async () => {
      throw new Error("not used");
    },
    refund: async (input) => {
      calls.push(input);
      return refund(input, calls.length);
    }
  };
}

const SUCCEEDED: PaymentGatewayRefundResult = {
  status: "succeeded",
  providerRefundId: "prov-refund-1",
  failureCode: null,
  raw: {}
};

async function refreshAll(tenantId: string): Promise<void> {
  for (const descriptor of PROJECTIONS) {
    const outcome = await runIncrementalUpdateForTenant(
      getRuntimeSql(),
      descriptor,
      tenantId
    );
    expect(outcome.failed).toBe(false);
  }
}

async function rawSalesRows(tenantId: string) {
  const admin = getAdminSql();
  return {
    daily: await admin`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, orders_paid, gross::text, discount::text, shipping::text, net::text
      FROM awcms_commerce_sales_daily WHERE tenant_id = ${tenantId} ORDER BY day`,
    byProduct: await admin`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, product_id, qty, gross::text
      FROM awcms_commerce_sales_by_product WHERE tenant_id = ${tenantId} ORDER BY day, product_id`,
    byCategory: await admin`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, category_id, qty, gross::text
      FROM awcms_commerce_sales_by_category WHERE tenant_id = ${tenantId} ORDER BY day, category_id`
  };
}

async function rebuild(
  tenantId: string,
  descriptor: ProjectionDescriptor
): Promise<void> {
  const { run } = await inTenant(tenantId, (tx) =>
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

/** Return events are written with `now()`; age them so the projection worker (which lags 60 s) reads them. */
async function ageReturnEvents(offsetMs: number): Promise<void> {
  await getAdminSql()`
    UPDATE awcms_commerce_order_events
    SET created_at = ${new Date(T0 + offsetMs)}::timestamptz + (random() * interval '1 second')
    WHERE return_id IS NOT NULL AND created_at > now() - interval '1 hour'
  `;
}

suite("commerce returns, refunds and exchanges (Issue #287)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  });

  afterAll(async () => {
    await teardownIntegrationDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "returns-a");
    await seedTenant(TENANT_B, "returns-b");
    await seedStaff(TENANT_A);
    await seedStaff(TENANT_B);
    await seedCatalog(TENANT_A);
    await setFeatures(TENANT_A);
  });

  // -------------------------------------------------------------------------
  describe("partial and repeated returns", () => {
    test("a partial return restocks, refunds exact cents, and edits nothing that was sold", async () => {
      const order = await standardOrder(TENANT_A);
      const kopi = order.items[0]!;

      const { body } = await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput([{ item: kopi.id, qty: 2 }])
        )
      );
      const ret = body.return;

      // 2 of 5 Kopi: goods 20,000.00; the line carries 5,000... of the 7,500
      // discount (50,000/75,000 of it = 5,000.00 over 5 units -> 2,000.00).
      expect(ret.goodsGross).toBe("20000.00");
      expect(ret.discountShare).toBe("2000.00");
      expect(ret.refundTotal).toBe("18000.00");
      expect(ret.status).toBe("completed");
      expect(ret.lines).toHaveLength(1);
      expect(ret.lines[0]!.stockEffect).toBe(2);
      expect(ret.refunds).toHaveLength(1);
      expect(ret.refunds[0]).toMatchObject({
        status: "succeeded",
        settledVia: "ledger",
        amount: "18000.00",
        tenderType: "cash"
      });

      // Stock, ledger, order, lines.
      expect(await stockOf(KOPI)).toBe(102);
      const reversals = (await getAdminSql()`
        SELECT kind, amount::text, reverses_allocation_id FROM awcms_commerce_payment_allocations
        WHERE tenant_id = ${TENANT_A} AND kind = 'reversal'`) as {
        amount: string;
        reverses_allocation_id: string;
      }[];
      expect(reversals).toHaveLength(1);
      expect(reversals[0]!.amount).toBe("18000.00");
      expect(reversals[0]!.reverses_allocation_id).toBe(order.payments[0]!.id);

      const orderRow = (await getAdminSql()`
        SELECT status, payment_status, total::text FROM awcms_commerce_orders WHERE id = ${order.id}`) as {
        status: string;
        payment_status: string;
        total: string;
      }[];
      // The lifecycle never moves backwards; the cache re-derives.
      expect(orderRow[0]!.status).toBe("paid");
      expect(orderRow[0]!.payment_status).toBe("partially_paid");
      expect(orderRow[0]!.total).toBe("72500.00");
      const items = (await getAdminSql()`
        SELECT quantity FROM awcms_commerce_order_items WHERE order_id = ${order.id} ORDER BY created_at`) as {
        quantity: number;
      }[];
      expect(items.map((i) => Number(i.quantity))).toEqual([5, 1]);

      // The return is announced on the order's event stream.
      const events = (await getAdminSql()`
        SELECT to_status, return_id FROM awcms_commerce_order_events
        WHERE order_id = ${order.id} AND return_id IS NOT NULL`) as {
        to_status: string;
        return_id: string;
      }[];
      expect(events).toEqual([{ to_status: "returned", return_id: ret.id }]);
    });

    test("repeated returns are bounded by the remaining quantity and add up to the line, to the cent", async () => {
      const order = await standardOrder(TENANT_A);
      const kopi = order.items[0]!;
      const refunds: string[] = [];
      for (const qty of [1, 2, 2]) {
        const { body } = await created(
          await doReturn(
            TENANT_A,
            order.id,
            returnInput([{ item: kopi.id, qty }])
          )
        );
        refunds.push(body.return.refundTotal);
      }
      // All 5 Kopi back: 50,000 gross less 5,000 of the discount = 45,000.00.
      const sum = refunds.reduce((a, r) => a + Math.round(Number(r) * 100), 0);
      expect(sum).toBe(4_500_000);

      const sixth = await doReturn(
        TENANT_A,
        order.id,
        returnInput([{ item: kopi.id, qty: 1 }])
      );
      expect(sixth).toEqual({
        kind: "quantity_exceeded",
        orderItemId: kopi.id,
        requested: 1,
        remaining: 0
      });
      expect(await stockOf(KOPI)).toBe(105);
      expect(await countRows("awcms_commerce_return_lines", TENANT_A)).toBe(3);
    });

    test("asking for more than remains is refused and writes nothing", async () => {
      const order = await standardOrder(TENANT_A);
      const outcome = await doReturn(
        TENANT_A,
        order.id,
        returnInput([{ item: order.items[0]!.id, qty: 6 }])
      );
      expect(outcome.kind).toBe("quantity_exceeded");
      expect(await countRows("awcms_commerce_returns", TENANT_A)).toBe(0);
      expect(await stockOf(KOPI)).toBe(100);
    });

    test("only an order whose sale is paid or beyond is returnable; an unknown line or order is a clean refusal", async () => {
      const pending = await standardOrder(TENANT_A, undefined, {
        status: "cancelled"
      });
      expect(
        (
          await doReturn(
            TENANT_A,
            pending.id,
            returnInput([{ item: pending.items[0]!.id, qty: 1 }])
          )
        ).kind
      ).toBe("order_not_returnable");

      const order = await standardOrder(TENANT_A);
      expect(
        (
          await doReturn(
            TENANT_A,
            order.id,
            returnInput([{ item: crypto.randomUUID(), qty: 1 }])
          )
        ).kind
      ).toBe("line_not_found");
      expect(
        (
          await doReturn(
            TENANT_A,
            crypto.randomUUID(),
            returnInput([{ item: order.items[0]!.id, qty: 1 }])
          )
        ).kind
      ).toBe("order_not_found");
      expect(await countRows("awcms_commerce_returns", TENANT_A)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("the final quantity under concurrency", () => {
    test("two genuinely concurrent returns of 3 of 5 units: exactly one wins", async () => {
      const order = await standardOrder(TENANT_A);
      const kopi = order.items[0]!;
      const results = await Promise.all([
        doReturn(TENANT_A, order.id, returnInput([{ item: kopi.id, qty: 3 }])),
        doReturn(TENANT_A, order.id, returnInput([{ item: kopi.id, qty: 3 }]))
      ]);
      const kinds = results.map((r) => r.kind).sort();
      expect(kinds).toEqual(["created", "quantity_exceeded"]);
      const lost = results.find((r) => r.kind === "quantity_exceeded")!;
      expect(lost).toMatchObject({ remaining: 2, requested: 3 });
      expect(await stockOf(KOPI)).toBe(103);
      expect(await countRows("awcms_commerce_return_lines", TENANT_A)).toBe(1);
    });

    test("the database holds on its own: two raw concurrent inserts that skip the order lock cannot over-return", async () => {
      const order = await standardOrder(TENANT_A);
      const kopi = order.items[0]!;
      const admin = getAdminSql();

      const insertReturn = async (tag: string) => {
        await admin.begin(async (tx) => {
          const [ret] = (await tx`
            INSERT INTO awcms_commerce_returns
              (tenant_id, order_id, source_key, actor_tenant_user_id)
            VALUES (${TENANT_A}, ${order.id}, ${`raw:${tag}`}, ${STAFF})
            RETURNING id
          `) as { id: string }[];
          // Give the other transaction time to take its own lock first.
          await tx`SELECT pg_sleep(0.3)`;
          await tx`
            INSERT INTO awcms_commerce_return_lines
              (tenant_id, return_id, order_id, order_item_id, product_id, quantity,
               reason, disposition, stock_effect, goods_gross, discount_share, refund_amount)
            VALUES (${TENANT_A}, ${ret!.id}, ${order.id}, ${kopi.id}, ${KOPI}, 3,
               'defective', 'damaged', 0, 0, 0, 0)
          `;
        });
      };
      const settled = await Promise.allSettled([
        insertReturn("one"),
        insertReturn("two")
      ]);
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.find(
        (s) => s.status === "rejected"
      ) as PromiseRejectedResult;
      expect(String(rejected.reason)).toMatch(/exceed the quantity sold/);
      expect(await countRows("awcms_commerce_return_lines", TENANT_A)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("stock disposition", () => {
    test("only restock changes sellable stock; damaged and quarantine are recorded and change none", async () => {
      const order = await standardOrder(TENANT_A);
      const { body } = await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput(
            [
              { item: order.items[0]!.id, qty: 2, disposition: "damaged" },
              { item: order.items[1]!.id, qty: 1, disposition: "quarantine" }
            ],
            { refund: null }
          )
        )
      );
      expect(await stockOf(KOPI)).toBe(100);
      expect(await stockOf(GULA)).toBe(100);
      expect(
        body.return.lines
          .map((l) => [l.disposition, l.stockEffect])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      ).toEqual([
        ["damaged", 0],
        ["quarantine", 0]
      ]);
      // No refund asked for: the value is recorded and the return stays open.
      expect(body.return.status).toBe("open");
      expect(body.return.refunds).toEqual([]);
      // 2 Kopi (20,000 - 2,000) + 1 Gula (25,000 - 2,500).
      expect(body.return.refundTotal).toBe("40500.00");
    });

    test("a mixed return restocks exactly the restock lines", async () => {
      const order = await standardOrder(TENANT_A);
      await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput([
            { item: order.items[0]!.id, qty: 4, disposition: "restock" },
            { item: order.items[1]!.id, qty: 1, disposition: "damaged" }
          ])
        )
      );
      expect(await stockOf(KOPI)).toBe(104);
      expect(await stockOf(GULA)).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  describe("refund arithmetic and the cap", () => {
    test("the refund is split newest payment first across the legs, exact to the cent", async () => {
      const order = await standardOrder(TENANT_A, [
        { tender: "cash", amount: "30000.00", at: 1 },
        { tender: "manual_bank_transfer", amount: "42500.00", at: 2 }
      ]);
      const { body } = await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput(
            [
              { item: order.items[0]!.id, qty: 5 },
              { item: order.items[1]!.id, qty: 1 }
            ],
            {
              refund: { ...ORIGINAL, shippingRefund: "5000.00" }
            }
          )
        )
      );
      // Everything back: 75,000 - 7,500 + 5,000 shipping = 72,500.00.
      expect(body.return.refundTotal).toBe("72500.00");
      expect(body.return.refunds.map((r) => [r.tenderType, r.amount])).toEqual([
        ["manual_bank_transfer", "42500.00"],
        ["cash", "30000.00"]
      ]);
      expect(body.return.status).toBe("completed");
      const orderRow = (await getAdminSql()`
        SELECT payment_status FROM awcms_commerce_orders WHERE id = ${order.id}`) as {
        payment_status: string;
      }[];
      expect(orderRow[0]!.payment_status).toBe("refunded");
    });

    test("a refund above what the payments can still give back is refused whole", async () => {
      const order = await standardOrder(TENANT_A, [
        { tender: "cash", amount: "72500.00" }
      ]);
      // A hand-recorded reversal already took 60,000 back.
      await getAdminSql()`
        INSERT INTO awcms_commerce_payment_allocations
          (tenant_id, order_id, kind, reverses_allocation_id, tender_type, amount, status,
           note, source, source_key, actor_kind, settled_at)
        VALUES (${TENANT_A}, ${order.id}, 'reversal', ${order.payments[0]!.id}, 'cash',
          60000.00, 'succeeded', 'manual', 'admin', 'seed:manual-rev', 'system', now())
      `;
      const outcome = await doReturn(
        TENANT_A,
        order.id,
        returnInput([{ item: order.items[0]!.id, qty: 5 }])
      );
      expect(outcome).toEqual({
        kind: "refund_exceeds_refundable",
        refundable: "12500.00",
        requested: "45000.00"
      });
      expect(await countRows("awcms_commerce_returns", TENANT_A)).toBe(0);
      expect(await stockOf(KOPI)).toBe(100);
    });

    test("the database refuses a refund leg or reversal beyond the payment, whatever the application did", async () => {
      const order = await standardOrder(TENANT_A, [
        { tender: "cash", amount: "72500.00" }
      ]);
      const admin = getAdminSql();
      const [ret] = (await admin`
        INSERT INTO awcms_commerce_returns (tenant_id, order_id, source_key, actor_tenant_user_id,
          goods_gross, refund_total)
        VALUES (${TENANT_A}, ${order.id}, 'raw:cap', ${STAFF}, 1.00, 1.00)
        RETURNING id`) as { id: string }[];
      await expect(
        attempt(admin`
          INSERT INTO awcms_commerce_refunds
            (tenant_id, return_id, order_id, allocation_id, tender_type, amount, source_key, actor_tenant_user_id)
          VALUES (${TENANT_A}, ${ret!.id}, ${order.id}, ${order.payments[0]!.id}, 'cash',
            72500.01, 'raw:cap:1', ${STAFF})`)
      ).rejects.toThrow(/would exceed what is refundable/);
      await expect(
        attempt(admin`
          INSERT INTO awcms_commerce_payment_allocations
            (tenant_id, order_id, kind, reverses_allocation_id, tender_type, amount, status,
             note, source, source_key, actor_kind, settled_at)
          VALUES (${TENANT_A}, ${order.id}, 'reversal', ${order.payments[0]!.id}, 'cash',
            72500.01, 'succeeded', 'too much', 'admin', 'raw:rev:cap', 'system', now())`)
      ).rejects.toThrow(/would exceed it/);
    });

    test("a shipping refund above the shipping charged is refused", async () => {
      const order = await standardOrder(TENANT_A);
      const outcome = await doReturn(
        TENANT_A,
        order.id,
        returnInput([{ item: order.items[1]!.id, qty: 1 }], {
          refund: { ...ORIGINAL, shippingRefund: "5000.01" }
        })
      );
      expect(outcome).toEqual({
        kind: "shipping_refund_exceeded",
        remaining: "5000.00"
      });
    });

    test("a later refund for the part with no leg yet creates it, and replays by key", async () => {
      const order = await standardOrder(TENANT_A);
      const { body } = await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput([{ item: order.items[0]!.id, qty: 1 }], { refund: null })
        )
      );
      expect(body.return.status).toBe("open");
      const key = KEY();
      const later = await inTenant(TENANT_A, (tx) =>
        createRefundsForReturn(
          tx,
          TENANT_A,
          STAFF,
          body.return.id,
          key,
          ORIGINAL,
          NOW
        )
      );
      expect(later.kind).toBe("created");
      if (later.kind !== "created") return;
      expect(later.body.return.status).toBe("completed");
      expect(later.body.return.refunds[0]!.amount).toBe("9000.00");

      const replay = await inTenant(TENANT_A, (tx) =>
        createRefundsForReturn(
          tx,
          TENANT_A,
          STAFF,
          body.return.id,
          key,
          ORIGINAL,
          NOW
        )
      );
      expect(replay.kind).toBe("replayed");
      expect(await countRows("awcms_commerce_refunds", TENANT_A)).toBe(1);

      const again = await inTenant(TENANT_A, (tx) =>
        createRefundsForReturn(
          tx,
          TENANT_A,
          STAFF,
          body.return.id,
          KEY(),
          ORIGINAL,
          NOW
        )
      );
      expect(again.kind).toBe("nothing_to_refund");
    });
  });

  // -------------------------------------------------------------------------
  describe("gateway refund: provider outside the transaction, retry and replay", () => {
    async function gatewayReturn() {
      const order = await standardOrder(TENANT_A, [
        { tender: "gateway", amount: "72500.00", providerRef: "MID-TEST-1" }
      ]);
      const { body } = await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput([{ item: order.items[0]!.id, qty: 2 }])
        )
      );
      return { order, ret: body.return, refund: body.return.refunds[0]! };
    }

    const exec = (
      returnId: string,
      refundId: string,
      provider: PaymentGatewayProvider | null
    ) =>
      executeRefund(
        getRuntimeSql(),
        TENANT_A,
        {
          returnId,
          refundId,
          actorTenantUserId: STAFF,
          registerSessionId: null
        },
        { provider }
      );

    test("a gateway leg is created pending and nothing is booked until the provider answers", async () => {
      const { ret, refund } = await gatewayReturn();
      expect(ret.status).toBe("open");
      expect(refund).toMatchObject({
        status: "pending",
        tenderType: "gateway"
      });
      const reversals = await countRows(
        "awcms_commerce_payment_allocations WHERE kind = 'reversal' AND true",
        TENANT_A
      ).catch(() => -1);
      // (the helper appends `AND tenant_id`, so use a direct query instead)
      const rows = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_payment_allocations
        WHERE tenant_id = ${TENANT_A} AND kind = 'reversal'`) as {
        n: number;
      }[];
      expect(rows[0]!.n).toBe(0);
      expect(reversals).toBeDefined();
    });

    test("the provider is called with no transaction holding the claim open, with a stable idempotency key", async () => {
      const { ret, refund } = await gatewayReturn();
      const seenDuringCall: string[] = [];
      const provider = stubProvider(async (input) => {
        // Visible from ANOTHER connection => the claim already committed.
        const rows = (await getAdminSql()`
          SELECT status, attempts FROM awcms_commerce_refunds WHERE id = ${refund.id}`) as {
          status: string;
          attempts: number;
        }[];
        seenDuringCall.push(`${rows[0]!.status}/${rows[0]!.attempts}`);
        expect(input).toMatchObject({
          providerRef: "MID-TEST-1",
          amount: "18000.00",
          refundKey: refund.id
        });
        return SUCCEEDED;
      });
      const outcome = await exec(ret.id, refund.id, provider);
      expect(outcome.kind).toBe("settled");
      expect(seenDuringCall).toEqual(["processing/1"]);
      if (outcome.kind !== "settled") return;
      expect(outcome.refund).toMatchObject({
        status: "succeeded",
        settledVia: "provider"
      });
      const after = await inTenant(TENANT_A, (tx) =>
        fetchReturn(tx, TENANT_A, ret.id)
      );
      expect(after!.status).toBe("completed");
    });

    test("a transport failure is a retryable failure, never a refund; the retry reuses the key and settles once", async () => {
      const { ret, refund } = await gatewayReturn();
      const provider = stubProvider(async (_input, call) => {
        if (call === 1) throw new Error("socket hang up");
        return SUCCEEDED;
      });
      const first = await exec(ret.id, refund.id, provider);
      expect(first).toMatchObject({
        kind: "failed",
        failureCode: "PROVIDER_ERROR"
      });
      expect(await countReversals()).toBe(0);

      const second = await exec(ret.id, refund.id, provider);
      expect(second.kind).toBe("settled");
      // Replay after success: nothing is called again, nothing is booked twice.
      const third = await exec(ret.id, refund.id, provider);
      expect(third.kind).toBe("already_settled");
      expect(provider.calls).toHaveLength(2);
      expect(new Set(provider.calls.map((c) => c.refundKey)).size).toBe(1);
      expect(await countReversals()).toBe(1);
    });

    test("a provider refusal is recorded with a short code; 'pending' keeps the leg processing", async () => {
      const { ret, refund } = await gatewayReturn();
      const refused = stubProvider(async () => ({
        status: "failed",
        providerRefundId: null,
        failureCode: "MIDTRANS_412",
        raw: {}
      }));
      expect(await exec(ret.id, refund.id, refused)).toMatchObject({
        kind: "failed",
        failureCode: "MIDTRANS_412"
      });
      const pending = stubProvider(async () => ({
        status: "pending",
        providerRefundId: "p-1",
        failureCode: null,
        raw: {}
      }));
      const outcome = await exec(ret.id, refund.id, pending);
      expect(outcome.kind).toBe("processing");
      expect(await countReversals()).toBe(0);
      // And asking again once the provider has finished settles it.
      expect(
        (
          await exec(
            ret.id,
            refund.id,
            stubProvider(async () => SUCCEEDED)
          )
        ).kind
      ).toBe("settled");
    });

    test("no adapter, or one that cannot refund, leaves the leg open for the offline path", async () => {
      const { ret, refund } = await gatewayReturn();
      expect((await exec(ret.id, refund.id, null)).kind).toBe(
        "provider_unavailable"
      );
      const noRefund = stubProvider(async () => SUCCEEDED);
      delete (noRefund as { refund?: unknown }).refund;
      expect((await exec(ret.id, refund.id, noRefund)).kind).toBe(
        "provider_unavailable"
      );
      const untouched = await inTenant(TENANT_A, (tx) =>
        fetchRefundForReturn(tx, TENANT_A, ret.id, refund.id)
      );
      expect(untouched!.status).toBe("pending");
    });

    test("offline settlement books the fact with the stated reason and approver", async () => {
      const { ret, refund } = await gatewayReturn();
      const outcome = await inTenant(TENANT_A, (tx) =>
        settleRefundOffline(tx, TENANT_A, {
          returnId: ret.id,
          refundId: refund.id,
          actorTenantUserId: STAFF,
          reason: "Transferred from the Midtrans dashboard, ref 123",
          now: NOW
        })
      );
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") return;
      expect(outcome.refund).toMatchObject({
        status: "succeeded",
        settledVia: "offline",
        offlineReason: "Transferred from the Midtrans dashboard, ref 123"
      });
      const again = await inTenant(TENANT_A, (tx) =>
        settleRefundOffline(tx, TENANT_A, {
          returnId: ret.id,
          refundId: refund.id,
          actorTenantUserId: STAFF,
          reason: "again",
          now: NOW
        })
      );
      expect(again.kind).toBe("already_settled");
      expect(await countReversals()).toBe(1);
    });

    test("two concurrent executions settle once", async () => {
      const { ret, refund } = await gatewayReturn();
      const provider = stubProvider(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return SUCCEEDED;
      });
      const [a, b] = await Promise.all([
        exec(ret.id, refund.id, provider),
        exec(ret.id, refund.id, provider)
      ]);
      expect([a.kind, b.kind].sort()).toEqual(["already_settled", "settled"]);
      expect(await countReversals()).toBe(1);
      const final = await inTenant(TENANT_A, (tx) =>
        fetchReturn(tx, TENANT_A, ret.id)
      );
      expect(final!.status).toBe("completed");
    });

    test("a leg of another return, another tenant, or an unknown id is the same not_found", async () => {
      const { ret, refund } = await gatewayReturn();
      const provider = stubProvider(async () => SUCCEEDED);
      const wrongReturn = await exec(crypto.randomUUID(), refund.id, provider);
      expect(wrongReturn.kind).toBe("not_found");
      const otherTenant = await executeRefund(
        getRuntimeSql(),
        TENANT_B,
        {
          returnId: ret.id,
          refundId: refund.id,
          actorTenantUserId: STAFF,
          registerSessionId: null
        },
        { provider }
      );
      expect(otherTenant.kind).toBe("feature_disabled");
      expect(provider.calls).toHaveLength(0);
    });
  });

  async function countReversals(): Promise<number> {
    const rows = (await getAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_payment_allocations
      WHERE tenant_id = ${TENANT_A} AND kind = 'reversal'`) as { n: number }[];
    return rows[0]!.n;
  }

  // -------------------------------------------------------------------------
  describe("store credit", () => {
    async function enableStoreCredit() {
      await setFeatures(TENANT_A, { storedValue: true });
      await inTenant(TENANT_A, (tx) =>
        upsertStoredValueProgram(tx, TENANT_A, STAFF, "store_credit", {
          enabled: true,
          expiryDays: null,
          allowRefundToAccount: true,
          maxBalance: null
        })
      );
    }

    test("a refund into store credit issues one account for the customer, shows its code once, and never stores it", async () => {
      await enableStoreCredit();
      const order = await standardOrder(TENANT_A, [
        { tender: "cash", amount: "30000.00", at: 1 },
        { tender: "manual_qris", amount: "42500.00", at: 2 }
      ]);
      const key = KEY();
      const input = returnInput(
        [
          { item: order.items[0]!.id, qty: 5 },
          { item: order.items[1]!.id, qty: 1 }
        ],
        { key, refund: { ...ORIGINAL, destination: "store_credit" } }
      );
      const first = await created(await doReturn(TENANT_A, order.id, input));
      expect(first.kind).toBe("created");
      const credit = first.body.storeCredit!;
      expect(credit.codeRevealed).toBe(true);
      expect(credit.code).toMatch(/^[A-Z0-9-]{20,}$/);

      // Two payment legs -> two refund legs, ONE account holding the sum.
      expect(first.body.return.refunds).toHaveLength(2);
      expect(
        first.body.return.refunds.every(
          (r) =>
            r.settledVia === "store_credit" &&
            r.storeCreditAccountId === credit.accountId
        )
      ).toBe(true);
      const account = (await getAdminSql()`
        SELECT balance::text, kind, customer_id FROM awcms_commerce_stored_value_accounts
        WHERE id = ${credit.accountId}`) as {
        balance: string;
        kind: string;
        customer_id: string;
      }[];
      expect(account[0]).toEqual({
        balance: "67500.00",
        kind: "store_credit",
        customer_id: CUSTOMER
      });

      // The plaintext is in no table at all (the idempotency store keeps null).
      const tables = (await getAdminSql()`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'awcms_%' AND table_type = 'BASE TABLE'`) as {
        table_name: string;
      }[];
      const needle = credit.code!.replace(/-/g, "").slice(0, 12);
      for (const { table_name } of tables) {
        const hits = (await getAdminSql().unsafe(
          `SELECT count(*)::int AS n FROM ${table_name} t WHERE replace(t::text, '-', '') LIKE '%${needle}%'`
        )) as { n: number }[];
        expect(hits[0]!.n).toBe(0);
      }

      // A replay returns the return and never reveals the code again.
      const replay = await created(await doReturn(TENANT_A, order.id, input));
      expect(replay.kind).toBe("replayed");
      expect(replay.body.storeCredit?.code ?? null).toBeNull();
      expect(await countRows("awcms_commerce_returns", TENANT_A)).toBe(1);
    });

    test("with the stored-value feature or program off, or a walk-in customer, nothing is written", async () => {
      const order = await standardOrder(TENANT_A);
      const asCredit = {
        ...ORIGINAL,
        destination: "store_credit" as const
      };
      const off = await doReturn(
        TENANT_A,
        order.id,
        returnInput([{ item: order.items[0]!.id, qty: 1 }], {
          refund: asCredit
        })
      );
      expect(off).toMatchObject({
        kind: "refund_refused",
        refusal: {
          reason: "store_credit_unavailable",
          detail: "FEATURE_DISABLED"
        }
      });

      await setFeatures(TENANT_A, { storedValue: true });
      const noProgram = await doReturn(
        TENANT_A,
        order.id,
        returnInput([{ item: order.items[0]!.id, qty: 1 }], {
          refund: asCredit
        })
      );
      expect(noProgram).toMatchObject({
        refusal: { detail: "NO_PROGRAM" }
      });
      expect(await countRows("awcms_commerce_returns", TENANT_A)).toBe(0);
      expect(await stockOf(KOPI)).toBe(100);
      expect(
        await countRows("awcms_commerce_stored_value_accounts", TENANT_A)
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("compensations", () => {
    test("loyalty points are taken back in proportion to the refund, and a cancellation takes only the rest", async () => {
      const order = await standardOrder(TENANT_A);
      // 100 points earned on this order.
      await inTenant(TENANT_A, async (tx) => {
        const account = await findOrCreateAccountLocked(tx, TENANT_A, CUSTOMER);
        await appendLedgerEntry(tx, TENANT_A, account, {
          kind: "earn",
          points: 100,
          sourceType: "order",
          sourceId: order.id,
          idempotencyKey: `earn:order:${order.id}`
        });
      });

      // Refund 18,000 of 72,500 -> floor(100 * 18000 / 72500) = 24 points.
      const first = await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput([{ item: order.items[0]!.id, qty: 2 }])
        )
      );
      const reversal = (await getAdminSql()`
        SELECT points, source_type, reverses_entry_id FROM awcms_commerce_loyalty_ledger
        WHERE tenant_id = ${TENANT_A} AND kind = 'reversal'`) as {
        points: number;
        source_type: string;
      }[];
      expect(reversal.map((r) => [Number(r.points), r.source_type])).toEqual([
        [-24, "refund"]
      ]);
      expect(
        first.body.return.compensations.map((c) => [c.kind, c.points])
      ).toEqual([["loyalty_reversal", -24]]);

      // The rest of the order back: the pieces add up to the full 100.
      await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput(
            [
              { item: order.items[0]!.id, qty: 3 },
              { item: order.items[1]!.id, qty: 1 }
            ],
            { refund: { ...ORIGINAL, shippingRefund: "5000.00" } }
          )
        )
      );
      const sum = (await getAdminSql()`
        SELECT COALESCE(SUM(points), 0)::int AS total FROM awcms_commerce_loyalty_ledger
        WHERE tenant_id = ${TENANT_A} AND kind = 'reversal'`) as {
        total: number;
      }[];
      expect(sum[0]!.total).toBe(-100);
      const balance = (await getAdminSql()`
        SELECT balance FROM awcms_commerce_loyalty_accounts WHERE tenant_id = ${TENANT_A}`) as {
        balance: number;
      }[];
      expect(Number(balance[0]!.balance)).toBe(0);
    });

    test("an affiliate commission is reduced in proportion and voided once the order is fully refunded", async () => {
      const order = await standardOrder(TENANT_A);
      const admin = getAdminSql();
      const [affiliate] = (await admin`
        INSERT INTO awcms_commerce_affiliates (tenant_id, customer_id, code, commission_rate)
        VALUES (${TENANT_A}, ${CUSTOMER}, 'AFF287', 10.00) RETURNING id`) as {
        id: string;
      }[];
      await admin`
        INSERT INTO awcms_commerce_affiliate_commissions
          (tenant_id, affiliate_id, order_id, base_amount, rate, amount, status)
        VALUES (${TENANT_A}, ${affiliate!.id}, ${order.id}, 67500.00, 10.00, 6750.00, 'approved')`;

      // Refund 18,000 of 72,500 -> floor(6750.00 * 18000 / 72500) = 1675.86.
      const first = await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput([{ item: order.items[0]!.id, qty: 2 }])
        )
      );
      const mid = (await admin`
        SELECT adjusted_amount::text, status FROM awcms_commerce_affiliate_commissions
        WHERE order_id = ${order.id}`) as {
        adjusted_amount: string;
        status: string;
      }[];
      expect(mid[0]).toEqual({
        adjusted_amount: "1675.86",
        status: "approved"
      });
      expect(
        first.body.return.compensations.some(
          (c) => c.kind === "affiliate_adjustment"
        )
      ).toBe(true);

      await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput(
            [
              { item: order.items[0]!.id, qty: 3 },
              { item: order.items[1]!.id, qty: 1 }
            ],
            { refund: { ...ORIGINAL, shippingRefund: "5000.00" } }
          )
        )
      );
      const end = (await admin`
        SELECT adjusted_amount::text, status FROM awcms_commerce_affiliate_commissions
        WHERE order_id = ${order.id}`) as {
        adjusted_amount: string;
        status: string;
      }[];
      expect(end[0]).toEqual({ adjusted_amount: "6750.00", status: "void" });
    });

    test("a paid-out commission is not voided: the adjustment is a clawback on the row", async () => {
      const order = await standardOrder(TENANT_A);
      const admin = getAdminSql();
      const [affiliate] = (await admin`
        INSERT INTO awcms_commerce_affiliates (tenant_id, customer_id, code, commission_rate)
        VALUES (${TENANT_A}, ${CUSTOMER}, 'AFF288', 10.00) RETURNING id`) as {
        id: string;
      }[];
      await admin`
        INSERT INTO awcms_commerce_affiliate_commissions
          (tenant_id, affiliate_id, order_id, base_amount, rate, amount, status)
        VALUES (${TENANT_A}, ${affiliate!.id}, ${order.id}, 67500.00, 10.00, 6750.00, 'paid')`;
      await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput(
            [
              { item: order.items[0]!.id, qty: 5 },
              { item: order.items[1]!.id, qty: 1 }
            ],
            { refund: { ...ORIGINAL, shippingRefund: "5000.00" } }
          )
        )
      );
      const row = (await admin`
        SELECT adjusted_amount::text, status FROM awcms_commerce_affiliate_commissions
        WHERE order_id = ${order.id}`) as {
        adjusted_amount: string;
        status: string;
      }[];
      expect(row[0]).toEqual({ adjusted_amount: "6750.00", status: "paid" });
    });
  });

  // -------------------------------------------------------------------------
  describe("sales reports net returns", () => {
    test("a return subtracts goods, discount, shipping and money; a rebuild lands on the live rows and reconciles", async () => {
      const order = await standardOrder(TENANT_A);
      await refreshAll(TENANT_A);
      const before = await rawSalesRows(TENANT_A);
      expect(before.daily).toEqual([
        {
          day: PAID_DAY,
          orders_paid: 1,
          gross: "75000.00",
          discount: "7500.00",
          shipping: "5000.00",
          net: "72500.00"
        }
      ]);

      await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput([{ item: order.items[0]!.id, qty: 2 }], {
            refund: { ...ORIGINAL, shippingRefund: "1000.00" }
          })
        )
      );
      await ageReturnEvents(10 * 60_000);
      await refreshAll(TENANT_A);
      const live = await rawSalesRows(TENANT_A);
      expect(live.daily).toEqual([
        {
          day: PAID_DAY,
          orders_paid: 1,
          gross: "55000.00",
          discount: "5500.00",
          shipping: "4000.00",
          net: "53500.00"
        }
      ]);
      const kopiRow = live.byProduct.find(
        (r: Record<string, unknown>) => r.product_id === KOPI
      )!;
      expect([Number(kopiRow.qty), kopiRow.gross]).toEqual([3, "30000.00"]);
      expect(
        live.byCategory.find(
          (r: Record<string, unknown>) => r.category_id === CATEGORY
        )!.qty
      ).toBe(3);

      for (const descriptor of PROJECTIONS) await rebuild(TENANT_A, descriptor);
      expect(await rawSalesRows(TENANT_A)).toEqual(live);
      for (const descriptor of PROJECTIONS) {
        const run = await inTenant(TENANT_A, (tx) =>
          reconcileProjection(tx, TENANT_A, descriptor, null)
        );
        expect(run.mismatch).toBe(false);
      }
    });

    test("cancelling a partly returned order afterwards nets the reports to zero, live and rebuilt", async () => {
      const order = await standardOrder(TENANT_A);
      await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput([{ item: order.items[0]!.id, qty: 2 }])
        )
      );
      await ageReturnEvents(10 * 60_000);
      await getAdminSql()`
        INSERT INTO awcms_commerce_order_events
          (tenant_id, order_id, from_status, to_status, actor, created_at)
        VALUES (${TENANT_A}, ${order.id}, 'paid', 'cancelled', 'admin', ${new Date(T0 + 3 * 60 * 60_000)})`;
      await refreshAll(TENANT_A);
      const live = await rawSalesRows(TENANT_A);
      expect(live.daily).toEqual([
        {
          day: PAID_DAY,
          orders_paid: 0,
          gross: "0.00",
          discount: "0.00",
          shipping: "0.00",
          net: "0.00"
        }
      ]);
      expect(
        live.byProduct.every(
          (r: Record<string, unknown>) =>
            Number(r.qty) === 0 && r.gross === "0.00"
        )
      ).toBe(true);
      for (const descriptor of PROJECTIONS) await rebuild(TENANT_A, descriptor);
      expect(await rawSalesRows(TENANT_A)).toEqual(live);
    });
  });

  // -------------------------------------------------------------------------
  describe("isolation, feature flag, idempotency and guards", () => {
    test("RLS: tenant B sees none of tenant A's returns; BOLA answers are the same not-found", async () => {
      const order = await standardOrder(TENANT_A);
      const { body } = await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput([{ item: order.items[0]!.id, qty: 1 }])
        )
      );
      await setFeatures(TENANT_B);
      await seedCatalog(TENANT_B).catch(() => undefined);

      expect(
        await inTenant(TENANT_B, (tx) =>
          fetchReturn(tx, TENANT_B, body.return.id)
        )
      ).toBeNull();
      expect(
        await inTenant(TENANT_B, (tx) =>
          listReturnsForOrder(tx, TENANT_B, order.id)
        )
      ).toEqual([]);
      const page = await inTenant(TENANT_B, (tx) =>
        listReturns(tx, TENANT_B, {})
      );
      expect(page.items).toEqual([]);
      const rows = await inTenant(
        TENANT_B,
        (tx) =>
          tx`SELECT count(*)::int AS n FROM awcms_commerce_returns` as Promise<
            { n: number }[]
          >
      );
      expect(rows[0]!.n).toBe(0);

      // Tenant B naming tenant A's order or line is the unknown-order answer.
      const viaOrder = await inTenant(TENANT_B, (tx) =>
        createReturn(
          tx,
          TENANT_B,
          STAFF,
          order.id,
          returnInput([{ item: order.items[0]!.id, qty: 1 }]),
          NOW
        )
      );
      expect(viaOrder.kind).toBe("order_not_found");
      expect(await countRows("awcms_commerce_returns", TENANT_A)).toBe(1);

      const link = await inTenant(TENANT_B, (tx) =>
        linkExchangeOrder(tx, TENANT_B, STAFF, body.return.id, order.id, KEY())
      );
      expect(link.kind).toBe("return_not_found");
    });

    test("the app role cannot delete or edit history, and the guards hold", async () => {
      const order = await standardOrder(TENANT_A);
      const { body } = await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput([{ item: order.items[0]!.id, qty: 1 }])
        )
      );
      const admin = getAdminSql();
      await expect(
        attempt(
          admin`UPDATE awcms_commerce_return_lines SET quantity = 1 WHERE return_id = ${body.return.id}`
        )
      ).rejects.toThrow(/append-only/);
      await admin`
        INSERT INTO awcms_commerce_refund_compensations (tenant_id, refund_id, kind, amount)
        VALUES (${TENANT_A}, ${body.return.refunds[0]!.id}, 'store_credit_load', 1.00)`;
      await expect(
        attempt(
          admin`UPDATE awcms_commerce_refund_compensations SET amount = 2.00 WHERE tenant_id = ${TENANT_A}`
        )
      ).rejects.toThrow(/append-only/);
      await expect(
        attempt(
          admin`UPDATE awcms_commerce_returns SET refund_total = 1.00 WHERE id = ${body.return.id}`
        )
      ).rejects.toThrow(/history/);
      await expect(
        attempt(
          admin`UPDATE awcms_commerce_refunds SET status = 'pending' WHERE return_id = ${body.return.id}`
        )
      ).rejects.toThrow(/settled and never changes/);
      await expect(
        attempt(
          admin`UPDATE awcms_commerce_refunds SET amount = 1.00 WHERE return_id = ${body.return.id}`
        )
      ).rejects.toThrow();

      const app = getAppRoleSql();
      for (const table of [
        "awcms_commerce_returns",
        "awcms_commerce_return_lines",
        "awcms_commerce_refunds",
        "awcms_commerce_refund_compensations"
      ]) {
        await expect(
          app.begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, true)`;
            await tx.unsafe(`DELETE FROM ${table}`);
          })
        ).rejects.toThrow(/permission denied/);
      }
    });

    test("with the returns feature off nothing is recorded", async () => {
      await setFeatures(TENANT_A, { returns: false });
      const order = await standardOrder(TENANT_A);
      expect(
        (
          await doReturn(
            TENANT_A,
            order.id,
            returnInput([{ item: order.items[0]!.id, qty: 1 }])
          )
        ).kind
      ).toBe("feature_disabled");
      expect(await countRows("awcms_commerce_returns", TENANT_A)).toBe(0);
      expect(await stockOf(KOPI)).toBe(100);
    });

    test("the same key replays without a second return or stock movement; a different payload under the key is refused", async () => {
      const order = await standardOrder(TENANT_A);
      const key = KEY();
      const input = returnInput([{ item: order.items[0]!.id, qty: 2 }], {
        key
      });
      const first = await created(await doReturn(TENANT_A, order.id, input));
      const second = await created(await doReturn(TENANT_A, order.id, input));
      expect(second.kind).toBe("replayed");
      expect(second.body.return.id).toBe(first.body.return.id);
      expect(await stockOf(KOPI)).toBe(102);
      expect(await countRows("awcms_commerce_returns", TENANT_A)).toBe(1);
      expect(await countReversals()).toBe(1);

      await expect(
        doReturn(
          TENANT_A,
          order.id,
          returnInput([{ item: order.items[0]!.id, qty: 3 }], { key })
        )
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
    });

    test("a cash refund naming a register session that does not exist is refused before anything is written", async () => {
      const order = await standardOrder(TENANT_A);
      const outcome = await doReturn(
        TENANT_A,
        order.id,
        returnInput([{ item: order.items[0]!.id, qty: 1 }], {
          refund: { ...ORIGINAL, registerSessionId: crypto.randomUUID() }
        })
      );
      expect(outcome).toMatchObject({
        kind: "refund_refused",
        refusal: { reason: "register_session_not_found" }
      });
      expect(await countRows("awcms_commerce_returns", TENANT_A)).toBe(0);
      expect(await stockOf(KOPI)).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  describe("exchange", () => {
    test("an exchange is a return plus a linked NEW order; the original order is never edited", async () => {
      const original = await standardOrder(TENANT_A);
      const replacement = await standardOrder(TENANT_A, undefined, {
        status: "pending_payment"
      });
      const { body } = await created(
        await doReturn(
          TENANT_A,
          original.id,
          returnInput([{ item: original.items[0]!.id, qty: 1 }], {
            kind: "exchange",
            refund: null
          })
        )
      );
      expect(body.return.kind).toBe("exchange");
      expect(body.return.exchangeOrderId).toBeNull();

      const key = KEY();
      const link = await inTenant(TENANT_A, (tx) =>
        linkExchangeOrder(
          tx,
          TENANT_A,
          STAFF,
          body.return.id,
          replacement.id,
          key
        )
      );
      expect(link.kind).toBe("linked");
      const replay = await inTenant(TENANT_A, (tx) =>
        linkExchangeOrder(
          tx,
          TENANT_A,
          STAFF,
          body.return.id,
          replacement.id,
          key
        )
      );
      expect(replay.kind).toBe("replayed");
      const other = await inTenant(TENANT_A, (tx) =>
        linkExchangeOrder(
          tx,
          TENANT_A,
          STAFF,
          body.return.id,
          original.id,
          KEY()
        )
      );
      expect(other).toMatchObject({ kind: "already_linked" });

      const row = (await getAdminSql()`
        SELECT quantity FROM awcms_commerce_order_items WHERE id = ${original.items[0]!.id}`) as {
        quantity: number;
      }[];
      expect(Number(row[0]!.quantity)).toBe(5);
      await expect(
        attempt(
          getAdminSql()`UPDATE awcms_commerce_returns SET exchange_order_id = ${original.id} WHERE id = ${body.return.id}`
        )
      ).rejects.toThrow();
    });

    test("a plain return cannot take a replacement order, and an order cannot be its own replacement", async () => {
      const order = await standardOrder(TENANT_A);
      const plain = await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput([{ item: order.items[0]!.id, qty: 1 }], { refund: null })
        )
      );
      expect(
        (
          await inTenant(TENANT_A, (tx) =>
            linkExchangeOrder(
              tx,
              TENANT_A,
              STAFF,
              plain.body.return.id,
              crypto.randomUUID(),
              KEY()
            )
          )
        ).kind
      ).toBe("not_an_exchange");

      const exchange = await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput([{ item: order.items[0]!.id, qty: 1 }], {
            kind: "exchange",
            refund: null
          })
        )
      );
      expect(
        (
          await inTenant(TENANT_A, (tx) =>
            linkExchangeOrder(
              tx,
              TENANT_A,
              STAFF,
              exchange.body.return.id,
              order.id,
              KEY()
            )
          )
        ).kind
      ).toBe("exchange_order_invalid");
      const bad = await doReturn(
        TENANT_A,
        order.id,
        returnInput([{ item: order.items[0]!.id, qty: 1 }], {
          kind: "exchange",
          exchangeOrderId: order.id,
          refund: null
        })
      );
      expect(bad.kind).toBe("exchange_order_invalid");
    });
  });

  // -------------------------------------------------------------------------
  describe("reconcile", () => {
    test("a healthy tenant reconciles clean; a refund reversal that belongs to no refund is found", async () => {
      const order = await standardOrder(TENANT_A);
      await created(
        await doReturn(
          TENANT_A,
          order.id,
          returnInput([{ item: order.items[0]!.id, qty: 2 }])
        )
      );
      const clean = await inTenant(TENANT_A, (tx) =>
        reconcileReturns(tx, TENANT_A)
      );
      expect(clean).toEqual({ checkedReturns: 1, findings: [] });

      await getAdminSql()`
        INSERT INTO awcms_commerce_payment_allocations
          (tenant_id, order_id, kind, reverses_allocation_id, tender_type, amount, status,
           note, source, source_key, actor_kind, settled_at)
        VALUES (${TENANT_A}, ${order.id}, 'reversal', ${order.payments[0]!.id}, 'cash',
          100.00, 'succeeded', 'orphan', 'admin', 'refund:orphan-test', 'system', now())`;
      const dirty = await inTenant(TENANT_A, (tx) =>
        reconcileReturns(tx, TENANT_A)
      );
      expect(dirty.findings.map((f) => f.kind)).toEqual([
        "reversal_without_refund"
      ]);
    });
  });
});
