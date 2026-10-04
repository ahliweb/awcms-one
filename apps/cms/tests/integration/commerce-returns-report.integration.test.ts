/**
 * The returns & refunds operational report (Issue #316, ADR-0035 D1) against a
 * REAL migrated PostgreSQL, through `tests/integration/harness.ts` under the
 * least-privilege runtime role and FORCE RLS, driving the REAL `reporting`
 * engine the way `commerce-operational-reports.integration.test.ts` does for
 * the first five families. Gated on `DATABASE_URL`.
 *
 * The acceptance list, each a property only a database proves:
 *
 *   - the live (incremental) rows equal a full rebuild, byte for byte - with a
 *     PENDING payment leg (NULL `settled_at`) in the ledger, the hazard the
 *     ADR-0035 D3 views exist for: the refund stream reads the NOT-NULL-cursor
 *     view, so the rebuild does not double anything;
 *   - reconcile is clean on a caught-up projection, detects tampering with
 *     each of the three sections, and reports a source that moved ahead;
 *   - a return and its lines land on the day they were recorded and on the
 *     register of the ORIGINAL sale; a refund leg on the day it settled;
 *   - a cancellation reversal (no refund behind it) and a pending refund are
 *     not refund legs, and a late return amends its OWN day;
 *   - a store-credit refund keeps its destination apart from the tender;
 *   - the `returns` feature OFF reads empty with `enabled: false`, and the
 *     history reappears when it is switched back on;
 *   - RLS: tenant B sees none of tenant A's rows, through the read function
 *     AND a raw SELECT, and a write naming another tenant is refused.
 *
 * Fixtures are raw SQL over the RLS-bypassing admin connection with explicit,
 * distinct, well-in-the-past cursor timestamps (the engine's 1 ms tie limit).
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
  fetchReturnsReport,
  type ReturnsReportRow
} from "../../src/modules/commerce/application/operational-report-directory";
import { POS_RETURNS_DAILY_PROJECTION_KEY } from "../../src/modules/commerce/domain/operational-report-keys";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { runIncrementalUpdateForTenant } from "../../src/modules/reporting/application/projection-incremental-worker";
import {
  continueRebuildPasses,
  triggerOrResumeRebuild
} from "../../src/modules/reporting/application/projection-rebuild";
import { reconcileProjection } from "../../src/modules/reporting/application/projection-reconciliation";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "11111111-1111-4111-8111-111111111316";
const TENANT_B = "22222222-2222-4222-8222-222222222316";
const CASHIER = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c316";
const B_USER = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f316";

/** 2026-09-10 in Asia/Jakarta is 2026-09-09T17:00Z .. 2026-09-10T16:59:59.999Z. */
const MORNING = new Date("2026-09-10T03:00:00.000Z"); // 10:00 WIB, 09-10
const LAST_SECOND = new Date("2026-09-10T16:59:59.000Z"); // 23:59:59 WIB, 09-10
const AFTER_MIDNIGHT = new Date("2026-09-10T17:00:01.000Z"); // 00:00:01 WIB, 09-11
const NEXT_NOON = new Date("2026-09-11T05:00:00.000Z"); // 12:00 WIB, 09-11
const LATER = new Date("2026-09-14T05:00:00.000Z"); // 09-14
const hoursAfter = (at: Date, hours: number) =>
  new Date(at.getTime() + hours * 3_600_000);

const WIDE = { from: "2026-09-01", to: "2026-09-30" };

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

async function seedTenantUser(tenantId: string, id: string): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Returns Report Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`ret-actor-${id}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${id}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function setFeatures(
  tenantId: string,
  features: Record<string, boolean>
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
          ...features
        }
      },
      CASHIER
    )
  );
}

async function refresh(tenantId: string): Promise<void> {
  const outcome = await runIncrementalUpdateForTenant(
    getRuntimeSql(),
    DESCRIPTOR,
    tenantId
  );
  expect(outcome.failed).toBe(false);
  expect(outcome.skippedRebuildInProgress).toBe(false);
}

async function rebuild(tenantId: string): Promise<void> {
  const { run } = await inTenant(tenantId, (tx) =>
    triggerOrResumeRebuild(tx, tenantId, DESCRIPTOR, {
      requestedBy: null,
      reason: "integration test"
    })
  );
  const result = await continueRebuildPasses(
    getRuntimeSql(),
    tenantId,
    DESCRIPTOR,
    run.id
  );
  expect(result.status).toBe("completed");
}

function reconcile(tenantId: string) {
  return inTenant(tenantId, (tx) =>
    reconcileProjection(tx, tenantId, DESCRIPTOR, null)
  );
}

/** Raw table rows (admin channel, `updated_at` excluded) to compare a rebuild against live rows byte for byte. */
async function rawRows(tenantId: string): Promise<string> {
  const rows = await getAdminSql()`
    SELECT to_jsonb(t) - 'updated_at' AS row
    FROM awcms_commerce_report_returns_daily t
    WHERE tenant_id = ${tenantId}
    ORDER BY day, register_id, section, bucket, detail
  `;
  return JSON.stringify(rows.map((r: { row: unknown }) => r.row));
}

// ---------------------------------------------------------------------------
// Source fixtures
// ---------------------------------------------------------------------------

type Ids = {
  customer: string;
  product: string;
  register1: string;
  register2: string;
};

async function seedBase(tenantId: string): Promise<Ids> {
  const admin = getAdminSql();
  const [customer] = (await admin`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
    VALUES (${tenantId}, 'Budi', ${"+6281300" + tenantId.slice(-4)})
    RETURNING id
  `) as { id: string }[];
  const [product] = (await admin`
    INSERT INTO awcms_commerce_products (tenant_id, sku, name, slug, price, stock)
    VALUES (${tenantId}, 'SKU-316', 'Kopi', 'kopi-316', 10000.00, 100)
    RETURNING id
  `) as { id: string }[];
  const registers = (await admin`
    INSERT INTO awcms_commerce_registers (tenant_id, code, name)
    VALUES (${tenantId}, 'R1', 'Front till'), (${tenantId}, 'R2', 'Back till')
    RETURNING id, code
  `) as { id: string; code: string }[];
  return {
    customer: customer!.id,
    product: product!.id,
    register1: registers.find((r) => r.code === "R1")!.id,
    register2: registers.find((r) => r.code === "R2")!.id
  };
}

let counter = 0;
const nextKey = (prefix: string) => `${prefix}-316-${++counter}`;

async function seedSession(
  tenantId: string,
  registerId: string
): Promise<string> {
  const [row] = (await getAdminSql()`
    INSERT INTO awcms_commerce_register_sessions
      (tenant_id, register_id, opened_at, opened_by_tenant_user_id,
       opening_float, current_cashier_tenant_user_id)
    VALUES (${tenantId}, ${registerId}, ${MORNING}, ${CASHIER}, 100000.00, ${CASHIER})
    RETURNING id
  `) as { id: string }[];
  return row!.id;
}

type SeededOrder = { id: string; itemId: string };

async function seedOrder(
  tenantId: string,
  ids: Ids,
  options: { sessionId?: string; quantity: number }
): Promise<SeededOrder> {
  const unit = 10000;
  const total = (unit * options.quantity).toFixed(2);
  const [order] = (await getAdminSql()`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method, payment_status,
       shipping_method, subtotal, total, channel, register_session_id, created_at)
    VALUES (${tenantId}, ${nextKey("ORD")}, ${ids.customer}, 'paid', 'manual_bank',
      'paid', 'self_pickup', ${total}, ${total},
      ${options.sessionId ? "pos" : "storefront"}, ${options.sessionId ?? null},
      '2026-09-01T00:00:00Z')
    RETURNING id
  `) as { id: string }[];
  const [item] = (await getAdminSql()`
    INSERT INTO awcms_commerce_order_items
      (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
    VALUES (${tenantId}, ${order!.id}, ${ids.product}, 'Kopi', ${unit.toFixed(2)},
      ${options.quantity}, ${total})
    RETURNING id
  `) as { id: string }[];
  return { id: order!.id, itemId: item!.id };
}

type Leg = {
  orderId: string;
  tender: "cash" | "manual_bank_transfer" | "gateway";
  amount: string;
  at: Date | null;
  kind?: "payment" | "reversal";
  reverses?: string;
  status?: "succeeded" | "pending";
  sessionId?: string;
};

async function seedLeg(tenantId: string, leg: Leg): Promise<string> {
  const status = leg.status ?? "succeeded";
  const [row] = (await getAdminSql()`
    INSERT INTO awcms_commerce_payment_allocations
      (tenant_id, order_id, kind, reverses_allocation_id, tender_type, amount, status,
       provider, source, source_key, actor_kind, register_session_id, created_at, settled_at)
    VALUES (${tenantId}, ${leg.orderId}, ${leg.kind ?? "payment"}, ${leg.reverses ?? null},
      ${leg.tender}, ${leg.amount}, ${status},
      ${leg.tender === "gateway" ? "midtrans" : null}, 'admin', ${nextKey("leg")},
      'system', ${leg.sessionId ?? null}, ${leg.at ?? MORNING},
      ${status === "pending" ? null : leg.at})
    RETURNING id
  `) as { id: string }[];
  return row!.id;
}

async function seedReturn(
  tenantId: string,
  order: SeededOrder,
  options: {
    kind?: "return" | "exchange";
    refundTotal: string;
    at: Date;
  }
): Promise<string> {
  const [row] = (await getAdminSql()`
    INSERT INTO awcms_commerce_returns
      (tenant_id, order_id, kind, status, goods_gross, discount_share,
       shipping_refund, refund_total, source_key, actor_tenant_user_id, created_at,
       updated_at)
    VALUES (${tenantId}, ${order.id}, ${options.kind ?? "return"}, 'open',
      ${options.refundTotal}, 0, 0, ${options.refundTotal}, ${nextKey("ret")},
      ${CASHIER}, ${options.at}, ${options.at})
    RETURNING id
  `) as { id: string }[];
  return row!.id;
}

async function seedReturnLine(
  tenantId: string,
  ids: Ids,
  order: SeededOrder,
  returnId: string,
  options: {
    quantity: number;
    disposition: "restock" | "damaged" | "quarantine";
    at: Date;
  }
): Promise<void> {
  const value = (10000 * options.quantity).toFixed(2);
  await getAdminSql()`
    INSERT INTO awcms_commerce_return_lines
      (tenant_id, return_id, order_id, order_item_id, product_id, quantity, reason,
       disposition, stock_effect, goods_gross, discount_share, refund_amount, created_at)
    VALUES (${tenantId}, ${returnId}, ${order.id}, ${order.itemId}, ${ids.product},
      ${options.quantity}, 'defective', ${options.disposition},
      ${options.disposition === "restock" ? options.quantity : 0}, ${value}, 0,
      ${value}, ${options.at})
  `;
}

/** A settled refund leg: the reversal row in the payment ledger plus the refund that booked it. */
async function seedSettledRefund(
  tenantId: string,
  order: SeededOrder,
  returnId: string,
  options: {
    payment: string;
    tender: "cash" | "manual_bank_transfer";
    amount: string;
    at: Date;
    destination?: "original_tender" | "store_credit";
    sessionId?: string;
  }
): Promise<void> {
  const reversal = await seedLeg(tenantId, {
    orderId: order.id,
    tender: options.tender,
    amount: options.amount,
    at: options.at,
    kind: "reversal",
    reverses: options.payment,
    sessionId: options.sessionId
  });
  await getAdminSql()`
    INSERT INTO awcms_commerce_refunds
      (tenant_id, return_id, order_id, allocation_id, tender_type, amount, destination,
       status, settled_via, reversal_allocation_id, source_key, actor_tenant_user_id,
       settled_at, created_at, updated_at)
    VALUES (${tenantId}, ${returnId}, ${order.id}, ${options.payment}, ${options.tender},
      ${options.amount}, ${options.destination ?? "original_tender"}, 'succeeded',
      ${options.destination === "store_credit" ? "store_credit" : "ledger"}, ${reversal},
      ${nextKey("ref")}, ${CASHIER}, ${options.at}, ${options.at}, ${options.at})
  `;
}

async function seedWorld(tenantId: string, ids: Ids): Promise<void> {
  const session = await seedSession(tenantId, ids.register1);

  // --- a register sale on R1: 5 units, paid 50 000 in cash --------------------
  const pos = await seedOrder(tenantId, ids, {
    sessionId: session,
    quantity: 5
  });
  const cash = await seedLeg(tenantId, {
    orderId: pos.id,
    tender: "cash",
    amount: "50000.00",
    at: MORNING,
    sessionId: session
  });

  // Return 1 (day 1): one unit restocked, one written off; 20 000 handed back in cash.
  const return1 = await seedReturn(tenantId, pos, {
    refundTotal: "20000.00",
    at: hoursAfter(MORNING, 1)
  });
  await seedReturnLine(tenantId, ids, pos, return1, {
    quantity: 1,
    disposition: "restock",
    at: hoursAfter(MORNING, 1)
  });
  await seedReturnLine(tenantId, ids, pos, return1, {
    quantity: 1,
    disposition: "damaged",
    at: hoursAfter(MORNING, 1)
  });
  await seedSettledRefund(tenantId, pos, return1, {
    payment: cash,
    tender: "cash",
    amount: "20000.00",
    at: hoursAfter(MORNING, 1),
    sessionId: session
  });

  // An exchange on the same sale, recorded in the last second of day 1: it
  // refunds nothing and has no lines, but it is a recorded exchange.
  await seedReturn(tenantId, pos, {
    kind: "exchange",
    refundTotal: "0.00",
    at: LAST_SECOND
  });

  // A CANCELLATION reversal of the same payment: no refund points at it, so it
  // is the tender report's, never a refund leg of this report.
  await seedLeg(tenantId, {
    orderId: pos.id,
    tender: "cash",
    amount: "5000.00",
    at: hoursAfter(MORNING, 2),
    kind: "reversal",
    reverses: cash,
    sessionId: session
  });

  // --- an online sale: 3 units, paid by bank transfer -------------------------
  const online = await seedOrder(tenantId, ids, { quantity: 3 });
  const transfer = await seedLeg(tenantId, {
    orderId: online.id,
    tender: "manual_bank_transfer",
    amount: "30000.00",
    at: MORNING
  });
  // A pending gateway leg: NULL `settled_at` until it resolves. The D3 hazard.
  await seedLeg(tenantId, {
    orderId: online.id,
    tender: "gateway",
    amount: "33000.00",
    at: null,
    status: "pending"
  });

  // Return 2 (one second after local midnight, so day 2): two units quarantined,
  // 6 000 sent back into store credit at noon.
  const return2 = await seedReturn(tenantId, online, {
    refundTotal: "6000.00",
    at: AFTER_MIDNIGHT
  });
  await seedReturnLine(tenantId, ids, online, return2, {
    quantity: 2,
    disposition: "quarantine",
    at: AFTER_MIDNIGHT
  });
  await seedSettledRefund(tenantId, online, return2, {
    payment: transfer,
    tender: "manual_bank_transfer",
    amount: "6000.00",
    at: NEXT_NOON,
    destination: "store_credit"
  });

  // A refund still waiting on the provider: pending, no reversal row.
  const return3 = await seedReturn(tenantId, online, {
    refundTotal: "4000.00",
    at: NEXT_NOON
  });
  await getAdminSql()`
    INSERT INTO awcms_commerce_refunds
      (tenant_id, return_id, order_id, allocation_id, tender_type, amount, destination,
       status, source_key, actor_tenant_user_id, created_at, updated_at)
    VALUES (${tenantId}, ${return3}, ${online.id}, ${transfer}, 'manual_bank_transfer',
      4000.00, 'original_tender', 'pending', ${nextKey("ref")}, ${CASHIER},
      ${NEXT_NOON}, ${NEXT_NOON})
  `;
}

// ---------------------------------------------------------------------------

type Cell = {
  day: string;
  registerCode: string | null;
  section: string;
  bucket: string;
  detail: string;
};

const find = (items: readonly ReturnsReportRow[], cell: Cell) =>
  items.find(
    (row) =>
      row.day === cell.day &&
      row.registerCode === cell.registerCode &&
      row.section === cell.section &&
      row.bucket === cell.bucket &&
      row.detail === cell.detail
  );

suite("returns & refunds operational report (Issue #316)", () => {
  let ids: Ids;
  let idsB: Ids;

  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-ret-a");
    await seedTenant(TENANT_B, "tenant-ret-b");
    await seedTenantUser(TENANT_A, CASHIER);
    await seedTenantUser(TENANT_B, B_USER);
    await setFeatures(TENANT_A, { register: true, returns: true });
    await setFeatures(TENANT_B, { register: true, returns: true });
    ids = await seedBase(TENANT_A);
    idsB = await seedBase(TENANT_B);
  }, 30000);

  test("the descriptor is registered, tenant-scoped, three streams, gated on its own report permission", () => {
    expect(DESCRIPTOR.source.strategy).toBe("cursor_table");
    expect(DESCRIPTOR.requiredPermission).toBe("commerce.report_returns.read");
    expect(DESCRIPTOR.dimensional).toBeDefined();
    if (DESCRIPTOR.source.strategy !== "cursor_table") return;
    expect(DESCRIPTOR.source.streams.map((s) => s.streamKey)).toEqual([
      "returns",
      "return_lines",
      "payment_allocations"
    ]);
  });

  test("projects returns, dispositions and refund legs by day, register and tender; cancellations, pending refunds and pending legs never count", async () => {
    await seedWorld(TENANT_A, ids);
    await refresh(TENANT_A);
    const report = await inTenant(TENANT_A, (tx) =>
      fetchReturnsReport(tx, TENANT_A, WIDE)
    );
    expect(report.enabled).toBe(true);
    const items = report.items;

    // Day 1, register R1 (the original sale's register).
    expect(
      find(items, {
        day: "2026-09-10",
        registerCode: "R1",
        section: "return",
        bucket: "return",
        detail: ""
      })
    ).toMatchObject({ count: 1, amount: "20000.00" });
    expect(
      find(items, {
        day: "2026-09-10",
        registerCode: "R1",
        section: "return",
        bucket: "exchange",
        detail: ""
      })
    ).toMatchObject({ count: 1, amount: "0.00" });
    expect(
      find(items, {
        day: "2026-09-10",
        registerCode: "R1",
        section: "disposition",
        bucket: "restock",
        detail: ""
      })
    ).toMatchObject({ count: 1, units: 1, amount: "10000.00" });
    expect(
      find(items, {
        day: "2026-09-10",
        registerCode: "R1",
        section: "disposition",
        bucket: "damaged",
        detail: ""
      })
    ).toMatchObject({ count: 1, units: 1, amount: "10000.00" });
    // Only the REFUND's reversal is a refund leg; the 5 000 cancellation is not.
    expect(
      find(items, {
        day: "2026-09-10",
        registerCode: "R1",
        section: "refund",
        bucket: "cash",
        detail: "original_tender"
      })
    ).toMatchObject({ count: 1, amount: "20000.00" });

    // Day 2, no register: the online sale's return lands on the day it was
    // recorded (local midnight + 1 s), its store-credit refund on the day it settled.
    expect(
      find(items, {
        day: "2026-09-11",
        registerCode: null,
        section: "disposition",
        bucket: "quarantine",
        detail: ""
      })
    ).toMatchObject({ count: 1, units: 2, amount: "20000.00" });
    expect(
      find(items, {
        day: "2026-09-11",
        registerCode: null,
        section: "refund",
        bucket: "manual_bank_transfer",
        detail: "store_credit"
      })
    ).toMatchObject({ count: 1, amount: "6000.00" });
    // The still-pending refund's return is recorded (4 000) on day 2 too.
    expect(
      find(items, {
        day: "2026-09-11",
        registerCode: null,
        section: "return",
        bucket: "return",
        detail: ""
      })
    ).toMatchObject({ count: 2, amount: "10000.00" });

    // Range summary, exact cents.
    expect(report.returnCount).toBe(4); // two returns, one exchange, one return awaiting its refund
    expect(report.returnedValue).toBe("30000.00");
    expect(report.refundedToTender).toBe("20000.00");
    expect(report.refundedToStoreCredit).toBe("6000.00");
    expect(report.refundedTotal).toBe("26000.00");
    expect(report.restockedUnits).toBe(1);
    expect(report.writtenOffUnits).toBe(1);
    expect(report.quarantinedUnits).toBe(2);

    // A narrower range sees only its own days.
    const dayTwo = await inTenant(TENANT_A, (tx) =>
      fetchReturnsReport(tx, TENANT_A, { from: "2026-09-11", to: "2026-09-11" })
    );
    expect(dayTwo.refundedTotal).toBe("6000.00");
    expect(dayTwo.restockedUnits).toBe(0);
  });

  test("a late return and a late refund amend THEIR OWN day; today's figure is not inflated", async () => {
    await seedWorld(TENANT_A, ids);
    await refresh(TENANT_A);
    const before = await inTenant(TENANT_A, (tx) =>
      fetchReturnsReport(tx, TENANT_A, { from: "2026-09-10", to: "2026-09-10" })
    );

    // Four days later a return on the first sale is recorded and refunded.
    const [order] = (await getAdminSql()`
      SELECT o.id, i.id AS item_id FROM awcms_commerce_orders o
      JOIN awcms_commerce_order_items i ON i.order_id = o.id
      WHERE o.tenant_id = ${TENANT_A} AND o.channel = 'pos'
    `) as { id: string; item_id: string }[];
    const pos: SeededOrder = { id: order!.id, itemId: order!.item_id };
    const cash = (await getAdminSql()`
      SELECT id FROM awcms_commerce_payment_allocations
      WHERE tenant_id = ${TENANT_A} AND order_id = ${pos.id} AND kind = 'payment'
    `) as { id: string }[];
    const late = await seedReturn(TENANT_A, pos, {
      refundTotal: "10000.00",
      at: LATER
    });
    await seedReturnLine(TENANT_A, ids, pos, late, {
      quantity: 1,
      disposition: "restock",
      at: LATER
    });
    await seedSettledRefund(TENANT_A, pos, late, {
      payment: cash[0]!.id,
      tender: "cash",
      amount: "10000.00",
      at: hoursAfter(LATER, 1)
    });
    await refresh(TENANT_A);

    const after = await inTenant(TENANT_A, (tx) =>
      fetchReturnsReport(tx, TENANT_A, { from: "2026-09-10", to: "2026-09-10" })
    );
    expect(after.items).toEqual(before.items);
    const lateDay = await inTenant(TENANT_A, (tx) =>
      fetchReturnsReport(tx, TENANT_A, { from: "2026-09-14", to: "2026-09-14" })
    );
    expect(lateDay.returnCount).toBe(1);
    expect(lateDay.refundedTotal).toBe("10000.00");
    expect(lateDay.restockedUnits).toBe(1);
  });

  test("a rebuild reproduces the live rows byte for byte (a pending leg with a NULL cursor doubles nothing), and a caught-up projection reconciles clean", async () => {
    await seedWorld(TENANT_A, ids);
    await refresh(TENANT_A);
    const live = await rawRows(TENANT_A);
    expect(JSON.parse(live).length).toBeGreaterThan(5);

    expect((await reconcile(TENANT_A)).mismatch).toBe(false);
    await rebuild(TENANT_A);
    const after = await reconcile(TENANT_A);
    expect(after.details.filter((detail) => detail.mismatch)).toEqual([]);
    expect(await rawRows(TENANT_A)).toEqual(live);

    // The rebuilt projection keeps advancing: a second incremental pass adds nothing.
    await refresh(TENANT_A);
    expect(await rawRows(TENANT_A)).toEqual(live);
  });

  test("reconcile detects tampering with each section, and a rebuild repairs it", async () => {
    await seedWorld(TENANT_A, ids);
    await refresh(TENANT_A);
    const admin = getAdminSql();
    const tamper = [
      () =>
        admin`UPDATE awcms_commerce_report_returns_daily SET amount = amount + 1.00 WHERE tenant_id = ${TENANT_A} AND section = 'return' AND bucket = 'return' AND day = '2026-09-10'`,
      () =>
        admin`UPDATE awcms_commerce_report_returns_daily SET units = units + 1 WHERE tenant_id = ${TENANT_A} AND section = 'disposition' AND bucket = 'restock'`,
      () =>
        admin`UPDATE awcms_commerce_report_returns_daily SET amount = amount + 1.00 WHERE tenant_id = ${TENANT_A} AND section = 'refund' AND detail = 'store_credit'`
    ];
    for (const run of tamper) {
      expect((await reconcile(TENANT_A)).mismatch).toBe(false);
      await run();
      const result = await reconcile(TENANT_A);
      expect(result.mismatch).toBe(true);
      expect(result.details.some((detail) => detail.mismatch)).toBe(true);
      await rebuild(TENANT_A);
      expect((await reconcile(TENANT_A)).mismatch).toBe(false);
    }
  });

  test("a source that moved ahead of the projection reconciles as drift until the next refresh", async () => {
    await seedWorld(TENANT_A, ids);
    await refresh(TENANT_A);
    const [order] = (await getAdminSql()`
      SELECT o.id, i.id AS item_id FROM awcms_commerce_orders o
      JOIN awcms_commerce_order_items i ON i.order_id = o.id
      WHERE o.tenant_id = ${TENANT_A} AND o.channel = 'storefront'
    `) as { id: string; item_id: string }[];
    await seedReturn(
      TENANT_A,
      { id: order!.id, itemId: order!.item_id },
      { refundTotal: "1000.00", at: LATER }
    );
    expect((await reconcile(TENANT_A)).mismatch).toBe(true);
    await refresh(TENANT_A);
    expect((await reconcile(TENANT_A)).mismatch).toBe(false);
  });

  test("the generic projection export returns the projected rows with the declared columns", async () => {
    await seedWorld(TENANT_A, ids);
    await refresh(TENANT_A);
    const exported = await inTenant(TENANT_A, (tx) =>
      DESCRIPTOR.dimensional!.exportRows(tx, TENANT_A)
    );
    expect(exported.rows.length).toBeGreaterThan(0);
    for (const column of exported.columns) {
      expect(Object.keys(exported.rows[0]!)).toContain(column);
    }
  });

  test("the returns feature OFF reads empty with enabled=false, and the history reappears when it is switched back on", async () => {
    await seedWorld(TENANT_A, ids);
    await refresh(TENANT_A);
    await setFeatures(TENANT_A, { register: true, returns: false });
    const off = await inTenant(TENANT_A, (tx) =>
      fetchReturnsReport(tx, TENANT_A, WIDE)
    );
    expect(off.enabled).toBe(false);
    expect(off.items).toEqual([]);
    expect(off.summary).toEqual([]);
    expect(off.refundedTotal).toBe("0.00");
    await setFeatures(TENANT_A, { register: true, returns: true });
    const back = await inTenant(TENANT_A, (tx) =>
      fetchReturnsReport(tx, TENANT_A, WIDE)
    );
    expect(back.enabled).toBe(true);
    expect(back.refundedTotal).toBe("26000.00");
  });

  test("tenant B's projection is its own, and neither tenant can read or write the other's rows", async () => {
    await seedWorld(TENANT_A, ids);
    await refresh(TENANT_A);
    const beforeB = await inTenant(TENANT_B, (tx) =>
      fetchReturnsReport(tx, TENANT_B, WIDE)
    );
    expect(beforeB.items).toEqual([]);

    // Tenant B gets one return of its own.
    const orderB = await seedOrder(TENANT_B, idsB, { quantity: 1 });
    await seedReturn(TENANT_B, orderB, { refundTotal: "777.00", at: MORNING });
    await refresh(TENANT_B);

    const a = await inTenant(TENANT_A, (tx) =>
      fetchReturnsReport(tx, TENANT_A, WIDE)
    );
    const b = await inTenant(TENANT_B, (tx) =>
      fetchReturnsReport(tx, TENANT_B, WIDE)
    );
    expect(b.returnCount).toBe(1);
    expect(b.returnedValue).toBe("777.00");
    expect(a.returnedValue).toBe("30000.00");

    await inTenant(TENANT_B, async (tx) => {
      const rows = (await tx.unsafe(
        `SELECT DISTINCT tenant_id FROM awcms_commerce_report_returns_daily`
      )) as { tenant_id: string }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.tenant_id).toBe(TENANT_B);
    });
    await expect(
      inTenant(TENANT_B, async (tx) => {
        await tx.unsafe(
          `INSERT INTO awcms_commerce_report_returns_daily
             (tenant_id, day, register_id, section, bucket, detail, entry_count, amount)
           VALUES ($1, '2026-09-10', gen_random_uuid(), 'return', 'return', '', 1, 1)`,
          [TENANT_A]
        );
      })
    ).rejects.toThrow();
  });

  test("the table refuses a malformed section, bucket or detail", async () => {
    const admin = getAdminSql();
    for (const [section, bucket, detail] of [
      ["sale", "return", ""],
      ["return", "restock", ""],
      ["disposition", "restock", "original_tender"],
      ["refund", "cash", "somewhere"]
    ] as const) {
      await expect(
        (async () => {
          await admin`INSERT INTO awcms_commerce_report_returns_daily
            (tenant_id, day, register_id, section, bucket, detail)
            VALUES (${TENANT_A}, '2026-09-10', gen_random_uuid(), ${section}, ${bucket}, ${detail})`;
        })()
      ).rejects.toThrow();
    }
  });
});
