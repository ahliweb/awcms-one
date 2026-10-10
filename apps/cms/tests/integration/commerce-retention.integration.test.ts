/**
 * `commerce.customer_retention` against a REAL migrated PostgreSQL (Issue #364,
 * ADR-0044; metrics spec section 6 and the proof list of section 11) - through
 * `tests/integration/harness.ts`, under the least-privilege runtime role and
 * FORCE RLS, driving the `reporting` engine the way `commerce-sales-reports.
 * integration.test.ts` does. Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * What only a database proves, mapped to the section 11 items this issue owns:
 *
 *   1. rebuild equals live (the customer table byte for byte, `updated_at`
 *      aside) and reconciliation reports no mismatch, and DOES flag tampering;
 *   2. every late-event case of the contract table: a refund of the first
 *      purchase after the fact removes the customer, a cancelled repeat stops
 *      counting, a backdated order moves a customer between cohorts, and
 *      nothing is counted twice when a pass is repeated;
 *   5. the cohort assignment of the section 6.3 example, including the day-90
 *      boundary (to the millisecond) and the fully refunded first purchase;
 *   7. no second store: the projection is a `reporting` descriptor, the only
 *      tables it adds are the two `commerce` projection tables, and the
 *      engine's own state/metrics tables carry its cursor and counters.
 *
 * Plus the properties around them: Asia/Jakarta month boundaries, the small
 * group rule (19 vs 20), exclusions (blocked, purged, the walk-in "unlinked"
 * placeholder), the restatement log (written live, left alone by a rebuild),
 * the per-tenant toggle, and cross-tenant RLS.
 *
 * Time: every fixture is relative to `new Date()` (an anchor month eight
 * Jakarta months back), never a fixed date, so the suite does not rot. Every
 * order-event and ledger leg carries a distinct, explicit cursor timestamp well
 * in the past - the engine's cursor has a documented 1 ms tie limitation and a
 * `now() - lag` upper bound.
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
import { fetchRetentionReport } from "../../src/modules/commerce/application/retention-report-directory";
import {
  RETENTION_METRIC_KEYS,
  RETENTION_PROJECTION_KEY,
  RETENTION_WINDOW_MS,
  addCohortMonths,
  cohortMonthOf,
  cohortMonthStart
} from "../../src/modules/commerce/domain/retention";
import { POS_WALK_IN_CUSTOMER_SENTINEL_PHONE } from "../../src/modules/commerce/domain/phone-normalisation";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
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

const TENANT_A = "11111111-1111-4111-8111-111111111364";
const TENANT_B = "22222222-2222-4222-8222-222222222364";
const STAFF = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c364";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const DESCRIPTOR: ProjectionDescriptor =
  commerceModule.reportingProjections!.find(
    (d) => d.key === RETENTION_PROJECTION_KEY
  )!;

/** Anchor: the first of the Jakarta month eight months back. Month offsets below count from it. */
const MONTH_0 = addCohortMonths(cohortMonthOf(new Date()), -8);
const month = (offset: number) => addCohortMonths(MONTH_0, offset);

/** An instant `days` days and `hours` hours into Jakarta month `offset` (days start at 0). */
const at = (offset: number, days: number, hours = 12) =>
  new Date(
    cohortMonthStart(month(offset)).getTime() + days * DAY + hours * HOUR
  );

/** Event/leg cursor timestamps: distinct, well in the past (the engine reads only rows older than its lag). */
const T0 = Date.now() - 6 * HOUR;
let cursorTick = 0;
const nextCursor = () => new Date(T0 + 1000 * ++cursorTick);

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
    VALUES (${tenantId}, 'person', 'Retention Test Actor')
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

async function setRetentionFeature(
  tenantId: string,
  retention: boolean
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
          retention
        }
      },
      STAFF
    )
  );
}

let customerSeq = 0;
async function seedCustomer(
  tenantId: string,
  options: { phone?: string; status?: string; name?: string } = {}
): Promise<string> {
  customerSeq += 1;
  const [row] = (await getAdminSql()`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone, status)
    VALUES (${tenantId}, ${options.name ?? `Customer ${customerSeq}`},
      ${options.phone ?? `+62812000${String(customerSeq).padStart(6, "0")}`},
      ${options.status ?? "active"})
    RETURNING id
  `) as { id: string }[];
  return row!.id;
}

let orderSeq = 0;
type SeedOrderOptions = {
  paidAt: Date | null;
  status?: string;
  paymentStatus?: string;
};

/** An order with its creation event and, when paid, the `pending_payment -> paid` event. */
async function seedOrder(
  tenantId: string,
  customerId: string,
  options: SeedOrderOptions
): Promise<string> {
  orderSeq += 1;
  const admin = getAdminSql();
  const paid = options.paidAt !== null;
  const status = options.status ?? (paid ? "completed" : "pending_payment");
  const paymentStatus = options.paymentStatus ?? (paid ? "paid" : "unpaid");
  const [order] = (await admin`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method, payment_status,
       shipping_method, shipping_cost, subtotal, total, paid_at)
    VALUES (${tenantId}, ${`RET-${process.pid}-${orderSeq}`}, ${customerId}, ${status},
      'manual_bank', ${paymentStatus}, 'courier', 10000.00, 90000.00, 100000.00,
      ${options.paidAt})
    RETURNING id
  `) as { id: string }[];
  const orderId = order!.id;
  await event(tenantId, orderId, null, "pending_payment");
  if (paid) await event(tenantId, orderId, "pending_payment", "paid");
  return orderId;
}

async function event(
  tenantId: string,
  orderId: string,
  fromStatus: string | null,
  toStatus: string
): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_commerce_order_events
      (tenant_id, order_id, from_status, to_status, actor, created_at)
    VALUES (${tenantId}, ${orderId}, ${fromStatus}, ${toStatus}, 'admin', ${nextCursor()})
  `;
}

/** Cancels a paid order the way the lifecycle does: the header moves and an event announces it. */
async function cancelOrder(
  tenantId: string,
  orderId: string,
  fromStatus = "completed"
): Promise<void> {
  await getAdminSql()`
    UPDATE awcms_commerce_orders SET status = 'cancelled', cancelled_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${orderId}
  `;
  await event(tenantId, orderId, fromStatus, "cancelled");
}

/**
 * A full refund booked by hand: a settled REVERSAL leg in the payment ledger
 * and the cached `payment_status` the ledger derives from it. There is no
 * order-status event, which is exactly why the projection listens to the leg.
 */
async function refundInFull(tenantId: string, orderId: string): Promise<void> {
  const admin = getAdminSql();
  const settledAt = nextCursor();
  const [payment] = (await admin`
    INSERT INTO awcms_commerce_payment_allocations
      (tenant_id, order_id, kind, tender_type, amount, status, source, source_key,
       actor_kind, created_at, settled_at)
    VALUES (${tenantId}, ${orderId}, 'payment', 'cash', 100000.00, 'succeeded',
      'admin', ${`pay-364-${orderId}`}, 'system', ${settledAt}, ${settledAt})
    RETURNING id
  `) as { id: string }[];
  const reversedAt = nextCursor();
  await admin`
    INSERT INTO awcms_commerce_payment_allocations
      (tenant_id, order_id, kind, reverses_allocation_id, tender_type, amount, status,
       source, source_key, actor_kind, created_at, settled_at)
    VALUES (${tenantId}, ${orderId}, 'reversal', ${payment!.id}, 'cash', 100000.00,
      'succeeded', 'admin', ${`rev-364-${orderId}`}, 'system', ${reversedAt}, ${reversedAt})
  `;
  await admin`
    UPDATE awcms_commerce_orders SET payment_status = 'refunded'
    WHERE tenant_id = ${tenantId} AND id = ${orderId}
  `;
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

async function reconcile(tenantId: string) {
  return inTenant(tenantId, (tx) =>
    reconcileProjection(tx, tenantId, DESCRIPTOR, null)
  );
}

/** Raw customer-table rows over the admin channel - `updated_at` excluded - to compare rebuild against live byte for byte. */
async function rawRows(tenantId: string) {
  return getAdminSql()`
    SELECT customer_id, to_char(cohort_month, 'YYYY-MM-DD') AS cohort_month,
      first_event_at, second_event_at, qualifying_order_count
    FROM awcms_commerce_report_retention_customers
    WHERE tenant_id = ${tenantId} ORDER BY customer_id
  `;
}

async function restatedRows(tenantId: string) {
  return getAdminSql()`
    SELECT to_char(cohort_month, 'YYYY-MM-DD') AS cohort_month, restated_at
    FROM awcms_commerce_report_retention_restated
    WHERE tenant_id = ${tenantId} ORDER BY cohort_month
  `;
}

async function report(tenantId: string, now = new Date()) {
  return inTenant(tenantId, (tx) =>
    fetchRetentionReport(tx, tenantId, { months: 12 }, now)
  );
}

const cohortOf = (
  result: Awaited<ReturnType<typeof report>>,
  monthStart: string
) => result.cohorts.find((cohort) => cohort.cohortMonth === monthStart);

suite("commerce customer-retention projection (Issue #364)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  });

  afterAll(async () => {
    await teardownIntegrationDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    cursorTick = 0;
    await seedTenant(TENANT_A, "ret-a");
    await seedTenant(TENANT_B, "ret-b");
    await seedStaff(TENANT_A);
    await seedStaff(TENANT_B).catch(() => undefined);
    await setRetentionFeature(TENANT_A, true);
  });

  test("proof 5: the section 6.3 cohorts, with the day-90 boundary and the fully refunded first purchase", async () => {
    const c = {
      c1: await seedCustomer(TENANT_A),
      c2: await seedCustomer(TENANT_A),
      c3: await seedCustomer(TENANT_A),
      c4: await seedCustomer(TENANT_A),
      c5: await seedCustomer(TENANT_A),
      c6: await seedCustomer(TENANT_A),
      c7: await seedCustomer(TENANT_A)
    };
    const firstOf = (offset: number, day: number) => at(offset, day);
    const plus = (from: Date, days: number) =>
      new Date(from.getTime() + days * DAY);
    const paid = (customerId: string, paidAt: Date) =>
      seedOrder(TENANT_A, customerId, { paidAt });

    // "January" = month 0, "February" = month 1.
    const c1 = firstOf(0, 2);
    await paid(c.c1, c1);
    await paid(c.c1, plus(c1, 48));
    const c2 = firstOf(0, 9);
    await paid(c.c2, c2);
    await paid(c.c2, plus(c2, 120)); // a later purchase, outside 90 days
    await paid(c.c3, firstOf(0, 14));
    const c4 = firstOf(0, 27);
    await paid(c.c4, c4);
    await paid(c.c4, new Date(c4.getTime() + RETENTION_WINDOW_MS)); // exactly 90 x 24 h
    const c5 = firstOf(1, 1);
    await paid(c.c5, c5);
    await paid(c.c5, plus(c5, 10));
    await paid(c.c6, firstOf(1, 8));
    await seedOrder(TENANT_A, c.c7, {
      paidAt: firstOf(1, 20),
      paymentStatus: "refunded"
    });

    await refresh(TENANT_A);
    const result = await report(TENANT_A);

    expect(cohortOf(result, month(0))).toMatchObject({
      size: 4,
      repeaters: 2,
      rateShown: false,
      ratePercent: null,
      mature: true
    });
    expect(cohortOf(result, month(1))).toMatchObject({
      size: 2,
      repeaters: 1,
      rateShown: false
    });
    // C7 never started: only two cohorts exist and C7 has no row at all.
    expect(result.cohorts.map((cohort) => cohort.cohortMonth)).toEqual([
      month(0),
      month(1)
    ]);
    const c7Rows = await getAdminSql()`
      SELECT 1 FROM awcms_commerce_report_retention_customers
      WHERE tenant_id = ${TENANT_A} AND customer_id = ${c.c7}`;
    expect(c7Rows).toHaveLength(0);
  });

  test("the day-90 boundary is to the millisecond: +90 x 24 h is a repeat, +1 ms is not", async () => {
    const inside = await seedCustomer(TENANT_A);
    const outside = await seedCustomer(TENANT_A);
    const first = at(2, 5);
    for (const [customer, delta] of [
      [inside, RETENTION_WINDOW_MS],
      [outside, RETENTION_WINDOW_MS + 1]
    ] as const) {
      await seedOrder(TENANT_A, customer, { paidAt: first });
      await seedOrder(TENANT_A, customer, {
        paidAt: new Date(first.getTime() + delta)
      });
    }
    await refresh(TENANT_A);
    expect(cohortOf(await report(TENANT_A), month(2))).toMatchObject({
      size: 2,
      repeaters: 1
    });
  });

  test("Asia/Jakarta month boundary: 23:59:59 WIB on the last day is this month, 00:00:01 WIB is the next", async () => {
    const lastSecond = new Date(cohortMonthStart(month(4)).getTime() - 1000);
    const firstSecond = new Date(cohortMonthStart(month(4)).getTime() + 1000);
    await seedOrder(TENANT_A, await seedCustomer(TENANT_A), {
      paidAt: lastSecond
    });
    await seedOrder(TENANT_A, await seedCustomer(TENANT_A), {
      paidAt: firstSecond
    });
    await refresh(TENANT_A);
    const result = await report(TENANT_A);
    expect(cohortOf(result, month(3))?.size).toBe(1);
    expect(cohortOf(result, month(4))?.size).toBe(1);
  });

  test("a cohort under 20 withholds the rate; at 20 it is shown to one decimal", async () => {
    // 19 customers in month 2 (5 repeat), 20 in month 3 (5 repeat).
    for (const [offset, size] of [
      [2, 19],
      [3, 20]
    ] as const) {
      for (let i = 0; i < size; i += 1) {
        const customer = await seedCustomer(TENANT_A);
        const first = at(offset, 1 + (i % 20));
        await seedOrder(TENANT_A, customer, { paidAt: first });
        if (i < 5) {
          await seedOrder(TENANT_A, customer, {
            paidAt: new Date(first.getTime() + 10 * DAY)
          });
        }
      }
    }
    await refresh(TENANT_A);
    const result = await report(TENANT_A);
    expect(cohortOf(result, month(2))).toMatchObject({
      size: 19,
      repeaters: 5,
      rateShown: false,
      ratePercent: null
    });
    expect(cohortOf(result, month(3))).toMatchObject({
      size: 20,
      repeaters: 5,
      rateShown: true,
      ratePercent: "25.0"
    });
  });

  test("proof 2: late events - a refund of the first purchase, a cancelled repeat, a backdated order; nothing is counted twice", async () => {
    // (a) refund of the first purchase after the fact: the second becomes the first.
    const refunded = await seedCustomer(TENANT_A);
    const firstOrder = await seedOrder(TENANT_A, refunded, {
      paidAt: at(2, 3)
    });
    await seedOrder(TENANT_A, refunded, { paidAt: at(3, 3) });
    // (b) a repeat that is later cancelled stops counting.
    const cancelled = await seedCustomer(TENANT_A);
    await seedOrder(TENANT_A, cancelled, { paidAt: at(2, 4) });
    const repeat = await seedOrder(TENANT_A, cancelled, { paidAt: at(2, 20) });
    // (c) a backdated order moves a customer to an earlier cohort.
    const moved = await seedCustomer(TENANT_A);
    await seedOrder(TENANT_A, moved, { paidAt: at(4, 6) });

    await refresh(TENANT_A);
    let result = await report(TENANT_A);
    expect(cohortOf(result, month(2))).toMatchObject({ size: 2, repeaters: 2 });
    expect(cohortOf(result, month(4))?.size).toBe(1);

    await refundInFull(TENANT_A, firstOrder);
    await cancelOrder(TENANT_A, repeat);
    await seedOrder(TENANT_A, moved, { paidAt: at(3, 9) });
    await refresh(TENANT_A);

    result = await report(TENANT_A);
    // month 2: only the cancelled-repeat customer remains, now without a repeat.
    expect(cohortOf(result, month(2))).toMatchObject({ size: 1, repeaters: 0 });
    // the refunded customer's second purchase is now their first (month 3),
    // and the backdated one joins it there; month 4 emptied.
    expect(cohortOf(result, month(3))).toMatchObject({ size: 2 });
    expect(cohortOf(result, month(4))).toBeUndefined();

    // Repeating the pass changes nothing: nothing is counted twice.
    const before = await rawRows(TENANT_A);
    await refresh(TENANT_A);
    expect(await rawRows(TENANT_A)).toEqual(before);
    const [sum] = (await getAdminSql()`
      SELECT sum(qualifying_order_count)::int AS orders
      FROM awcms_commerce_report_retention_customers WHERE tenant_id = ${TENANT_A}
    `) as { orders: number }[];
    // refunded: 1 (the second), cancelled: 1, moved: 2
    expect(sum!.orders).toBe(4);
  });

  test("proof 1: rebuild equals live byte for byte, reconciliation is clean, and tampering is flagged", async () => {
    const a = await seedCustomer(TENANT_A);
    await seedOrder(TENANT_A, a, { paidAt: at(2, 3) });
    await seedOrder(TENANT_A, a, { paidAt: at(2, 40) });
    const b = await seedCustomer(TENANT_A);
    const bFirst = await seedOrder(TENANT_A, b, { paidAt: at(3, 5) });
    await seedOrder(TENANT_A, b, { paidAt: at(4, 5) });
    await refundInFull(TENANT_A, bFirst);
    const walkIn = await seedCustomer(TENANT_A, {
      phone: POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
    });
    await seedOrder(TENANT_A, walkIn, { paidAt: at(5, 2) });
    await seedOrder(TENANT_A, walkIn, { paidAt: at(5, 3) });

    await refresh(TENANT_A);
    const live = await rawRows(TENANT_A);
    expect(live).toHaveLength(3);

    await rebuild(TENANT_A);
    expect(await rawRows(TENANT_A)).toEqual(live);

    const run = await reconcile(TENANT_A);
    expect(run.mismatch).toBe(false);
    expect(run.details.length).toBeGreaterThan(1);
    expect(run.details.every((detail) => !detail.mismatch)).toBe(true);
    expect(
      run.details.some((detail) => detail.metricKey === "retention_customers")
    ).toBe(true);

    // The engine's own counters: both streams consumed what the sources hold.
    const metrics = await inTenant(TENANT_A, (tx) =>
      getProjectionMetrics(tx, TENANT_A, RETENTION_PROJECTION_KEY)
    );
    expect(metrics[RETENTION_METRIC_KEYS.paidEvents]).toBe(6);
    expect(metrics[RETENTION_METRIC_KEYS.reversalLegs]).toBe(1);

    await getAdminSql()`
      UPDATE awcms_commerce_report_retention_customers
      SET qualifying_order_count = qualifying_order_count + 1
      WHERE tenant_id = ${TENANT_A} AND customer_id = ${a}
    `;
    const drift = await reconcile(TENANT_A);
    expect(drift.mismatch).toBe(true);
    expect(
      drift.details.find(
        (detail) => detail.metricKey === "retention_qualifying_orders"
      )?.mismatch
    ).toBe(true);
  });

  test("exclusions: blocked and purged customers leave the denominator at once; the walk-in placeholder is 'unlinked', never a cohort", async () => {
    const active = await seedCustomer(TENANT_A);
    const blocked = await seedCustomer(TENANT_A, { status: "blocked" });
    const purged = await seedCustomer(TENANT_A);
    const walkIn = await seedCustomer(TENANT_A, {
      phone: POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
    });
    for (const customer of [active, blocked, purged]) {
      await seedOrder(TENANT_A, customer, { paidAt: at(2, 3) });
    }
    await seedOrder(TENANT_A, walkIn, { paidAt: at(2, 4) });
    await seedOrder(TENANT_A, walkIn, { paidAt: at(2, 5) });
    await seedOrder(TENANT_A, walkIn, { paidAt: at(3, 5) });
    await getAdminSql()`
      UPDATE awcms_commerce_customers SET deleted_at = now()
      WHERE tenant_id = ${TENANT_A} AND id = ${purged}
    `;

    await refresh(TENANT_A);
    const result = await report(TENANT_A);
    expect(cohortOf(result, month(2))?.size).toBe(1);
    expect(cohortOf(result, month(3))).toBeUndefined();
    expect(result.unlinkedOrders).toBe(3);
  });

  test("the restatement log: a backdated change to a closed cohort is flagged live, a normal current-month order is not, and a rebuild keeps the log untouched", async () => {
    // Normal flow: a purchase two hours ago, current cohort, window not closed.
    const fresh = await seedCustomer(TENANT_A);
    const freshAt = new Date(Date.now() - 2 * HOUR);
    await seedOrder(TENANT_A, fresh, { paidAt: freshAt });
    await refresh(TENANT_A);
    expect(await restatedRows(TENANT_A)).toEqual([]);
    expect(cohortOf(await report(TENANT_A), cohortMonthOf(freshAt))?.size).toBe(
      1
    );

    // A backdated order lands in a cohort closed more than 35 days ago.
    const late = await seedCustomer(TENANT_A);
    await seedOrder(TENANT_A, late, { paidAt: at(2, 8) });
    await refresh(TENANT_A);
    const flagged = await restatedRows(TENANT_A);
    expect(
      flagged.map((row: { cohort_month: string }) => row.cohort_month)
    ).toEqual([month(2)]);
    const flaggedReport = await report(TENANT_A);
    expect(cohortOf(flaggedReport, month(2))?.restated).toBe(true);
    expect(cohortOf(flaggedReport, cohortMonthOf(freshAt))?.restated).toBe(
      false
    );

    // A rebuild re-derives every row from nothing; it must neither restate the
    // old cohort again nor erase the evidence.
    const before = await restatedRows(TENANT_A);
    await rebuild(TENANT_A);
    expect(await restatedRows(TENANT_A)).toEqual(before);
  });

  test("the per-tenant toggle: off (the default) is 200-shaped enabled=false with no cohorts, on shows them, off again hides them while the rows stay", async () => {
    await seedOrder(TENANT_A, await seedCustomer(TENANT_A), {
      paidAt: at(2, 3)
    });
    await refresh(TENANT_A);

    await setRetentionFeature(TENANT_A, false);
    const off = await report(TENANT_A);
    expect(off.enabled).toBe(false);
    expect(off.cohorts).toEqual([]);
    expect(off.unlinkedOrders).toBe(0);

    await setRetentionFeature(TENANT_A, true);
    expect((await report(TENANT_A)).cohorts.length).toBe(1);

    await setRetentionFeature(TENANT_A, false);
    expect((await report(TENANT_A)).enabled).toBe(false);
    expect(await rawRows(TENANT_A)).toHaveLength(1);
  });

  test("a tenant that never opened Features reads the default: retention is OFF", async () => {
    await seedTenant("33333333-3333-4333-8333-333333333364", "ret-default");
    const result = await report("33333333-3333-4333-8333-333333333364");
    expect(result.enabled).toBe(false);
  });

  test("proof 7: no second store - one reporting descriptor, two commerce tables, the engine's own cursor and counters", async () => {
    await seedOrder(TENANT_A, await seedCustomer(TENANT_A), {
      paidAt: at(2, 3)
    });
    await refresh(TENANT_A);

    expect(
      commerceModule.reportingProjections!.filter(
        (d) => d.key === RETENTION_PROJECTION_KEY
      )
    ).toHaveLength(1);
    expect(DESCRIPTOR.source.strategy).toBe("cursor_table");
    expect(DESCRIPTOR.dimensional).toBeDefined();

    const tables = (await getAdminSql()`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE '%retention%'
      ORDER BY table_name
    `) as { table_name: string }[];
    expect(tables.map((row) => row.table_name)).toEqual([
      "awcms_commerce_report_retention_customers",
      "awcms_commerce_report_retention_restated"
    ]);

    const cursors = (await getAdminSql()`
      SELECT stream_key FROM awcms_reporting_projection_cursors
      WHERE tenant_id = ${TENANT_A} AND projection_key = ${RETENTION_PROJECTION_KEY}
      ORDER BY stream_key
    `) as { stream_key: string }[];
    expect(cursors.length).toBeGreaterThan(0);
  });

  test("export writes cohort aggregates only, never a customer", async () => {
    for (let i = 0; i < 2; i += 1) {
      await seedOrder(TENANT_A, await seedCustomer(TENANT_A), {
        paidAt: at(2, 3 + i)
      });
    }
    await refresh(TENANT_A);
    const rootPath = `${process.cwd()}/var/test-retention-exports-${process.pid}`;
    const run = await generateProjectionExport(
      getRuntimeSql(),
      {
        tenantId: TENANT_A,
        descriptor: DESCRIPTOR,
        format: "csv",
        scheduledExportId: null,
        requestedBy: null
      },
      { ...process.env, REPORTING_EXPORT_ROOT_PATH: rootPath }
    );
    expect(run.status).toBe("completed");
    const lines = (await Bun.file(run.storagePath!).text()).trim().split("\n");
    expect(lines[0]).toBe("cohort_month,customers,repeaters");
    expect(lines[1]).toBe(`${month(2)},2,0`);
    await Bun.$`rm -rf ${rootPath}`.quiet();
  });

  test("RLS: tenant B reads none of tenant A's cohorts and cannot see a single row", async () => {
    await seedOrder(TENANT_A, await seedCustomer(TENANT_A), {
      paidAt: at(2, 3)
    });
    await refresh(TENANT_A);
    await setRetentionFeature(TENANT_B, true);

    const forB = await report(TENANT_B);
    expect(forB.enabled).toBe(true);
    expect(forB.cohorts).toEqual([]);
    expect(forB.unlinkedOrders).toBe(0);

    for (const table of [
      "awcms_commerce_report_retention_customers",
      "awcms_commerce_report_retention_restated"
    ]) {
      const leaked = await inTenant(
        TENANT_B,
        async (tx) =>
          (await tx.unsafe(`SELECT count(*)::int AS count FROM ${table}`)) as {
            count: number;
          }[]
      );
      expect(leaked[0]!.count).toBe(0);
    }

    // And a write for another tenant is refused by WITH CHECK.
    await expect(
      inTenant(
        TENANT_B,
        (tx) =>
          tx`INSERT INTO awcms_commerce_report_retention_customers
             (tenant_id, customer_id, cohort_month, first_event_at, qualifying_order_count)
           VALUES (${TENANT_A}, gen_random_uuid(), ${month(2)}::date, now(), 1)`
      )
    ).rejects.toThrow();
  });
});
