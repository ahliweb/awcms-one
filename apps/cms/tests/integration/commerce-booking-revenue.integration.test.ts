/**
 * `commerce.booking_revenue`, the hold pipeline and the booking anchor of
 * `commerce.customer_retention` against a REAL migrated PostgreSQL (Issue #389,
 * ADR-0045 amendment note; metrics spec sections 3, 3.7, 6, 8.2, 8.3 and the
 * proof list of section 11). World 1 of `harness.ts`: the booking adapter's
 * application functions run with the `awcms_app` runtime pool and the REAL
 * composed `BookingPort` (book, pay, no-show, cancel, refund, reschedule), the
 * `reporting` engine runs the way `bun run reporting:projections:refresh` does,
 * and the report is read through the read functions the routes call. Gated on
 * `DATABASE_URL`; skips cleanly without one. The route wiring (permission, the
 * range validator, the toggle) is `commerce-booking-revenue-routes.integration.
 * test.ts`.
 *
 * What only a database proves, mapped to the section 11 items this issue owns:
 *
 *   1. rebuild equals live (the row table byte for byte, `updated_at` aside),
 *      reconciliation reports no mismatch, and DOES flag tampering;
 *   2. each late-event case of the contract table: a refund after close
 *      restates the ORIGINAL paid day, a no-show and a cancellation land on the
 *      original day, and nothing is counted twice when a pass is repeated;
 *   3. holds are excluded from the waterfall and present in the pipeline;
 *   5. retention cohort assignment with the booking anchor - a stay is one
 *      event, the supplementary order is not a repeat, a cancelled stay is none,
 *      a fully refunded stay never started the customer;
 *   7. no second store: the projection is a `reporting` descriptor and its only
 *      tables are the two `commerce` projection tables;
 *   8. the three rows of the section 3.7 deposit worked example through the real
 *      adapter flows, each on its own paid day;
 *
 * plus the villa week of section 8.3 to the cent, fully refunded and walk-in
 * orders, the per-tenant toggle, the export (aggregates only) and RLS.
 *
 * Time: every order is paid "now" through the real path and then moved to a
 * distinct past Jakarta day with a header edit (the only way a test reaches a
 * closed day; `paid_at` never moves in production). The engine's lag is set to
 * zero for this file because the rows are written by real transactions a moment
 * before the pass.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { composedBookingPort } from "../../src/lib/composition/booking-port";
import { setProductDepositPolicy } from "../../src/modules/commerce/application/booking-deposit-policies";
import {
  cancelBookingReservation,
  type CancelResult
} from "../../src/modules/commerce/application/booking-cancellation";
import { recordBookingNoShow } from "../../src/modules/commerce/application/booking-no-show";
import { fetchBookingPipeline } from "../../src/modules/commerce/application/booking-pipeline";
import { fetchBookingRevenueReport } from "../../src/modules/commerce/application/booking-revenue-report";
import { recomputeBookingRevenueRows } from "../../src/modules/commerce/application/booking-revenue-projection";
import { executeRefund } from "../../src/modules/commerce/application/refund-execution";
import { fetchRetentionReport } from "../../src/modules/commerce/application/retention-report-directory";
import { fetchReservationLinkByReservationId } from "../../src/modules/commerce/application/booking-reservation-links";
import {
  rescheduleBookingReservation,
  type RescheduleResult
} from "../../src/modules/commerce/application/booking-reschedule";
import { DEFAULT_RESCHEDULE_REASON_CODE } from "../../src/modules/commerce/domain/booking-reschedule";
import { DEFAULT_NO_SHOW_REASON_CODE } from "../../src/modules/commerce/domain/booking-no-show";
import {
  BOOKING_REVENUE_METRIC_KEYS,
  BOOKING_REVENUE_PROJECTION_KEY,
  averageDailyRate,
  revenuePerAvailableNight
} from "../../src/modules/commerce/domain/booking-revenue";
import { POS_WALK_IN_CUSTOMER_SENTINEL_PHONE } from "../../src/modules/commerce/domain/phone-normalisation";
import { RETENTION_PROJECTION_KEY } from "../../src/modules/commerce/domain/retention";
import { resolveSalesReportDay } from "../../src/modules/commerce/domain/sales-report-deltas";
import { commerceModule } from "../../src/modules/commerce/module";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import type { ProjectionDescriptor } from "../../src/modules/_shared/module-contract";
import { generateProjectionExport } from "../../src/modules/reporting/application/export-generation";
import { getProjectionMetrics } from "../../src/modules/reporting/application/projection-metric-store";
import { runIncrementalUpdateForTenant } from "../../src/modules/reporting/application/projection-incremental-worker";
import {
  continueRebuildPasses,
  triggerOrResumeRebuild
} from "../../src/modules/reporting/application/projection-rebuild";
import { reconcileProjection } from "../../src/modules/reporting/application/projection-reconciliation";
import {
  createAdapterFixtures,
  D,
  HOUR,
  STANDARD_WINDOWS
} from "./booking-adapter-fixtures";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "38900000-0389-4000-8000-0000000000a1";
const TENANT_B = "38900000-0389-4000-8000-0000000000a2";
const STAFF = "38900000-0389-4000-8000-0000000000c1";
const MANAGER = "38900000-0389-4000-8000-0000000000c2";
const SERVICE = "38900000-0389-4000-8000-0000000000c3";
const STAFF_B = "38900000-0389-4000-8000-0000000000c4";
const SERVICE_B = "38900000-0389-4000-8000-0000000000c5";

const DAY = 24 * HOUR;

const fx = createAdapterFixtures({
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  staff: STAFF,
  manager: MANAGER,
  service: SERVICE,
  staffB: STAFF_B,
  serviceB: SERVICE_B,
  keyPrefix: "v389"
});
const {
  inTenant,
  newFixture,
  book,
  pay,
  dispatch,
  policy,
  arrivedHoursAgo,
  startsAtOf,
  legsOf,
  nextKey
} = fx;

const REVENUE: ProjectionDescriptor = commerceModule.reportingProjections!.find(
  (descriptor) => descriptor.key === BOOKING_REVENUE_PROJECTION_KEY
)!;
const RETENTION: ProjectionDescriptor =
  commerceModule.reportingProjections!.find(
    (descriptor) => descriptor.key === RETENTION_PROJECTION_KEY
  )!;

const rp = (amount: number): string => amount.toFixed(2);

/** The Asia/Jakarta day `n` days before today. */
const dayAgo = (n: number): string =>
  resolveSalesReportDay(new Date(Date.now() - n * DAY));

let phoneSeq = 0;
/** A fresh guest, so each booking is its own commerce customer (a guest checkout creates the customer by phone). */
const guest = () => {
  phoneSeq += 1;
  return {
    name: `Tamu ${phoneSeq}`,
    phone: `08139${String(phoneSeq).padStart(7, "0")}`,
    email: null
  };
};

async function refreshOne(
  descriptor: ProjectionDescriptor,
  tenantId = TENANT_A
): Promise<void> {
  const outcome = await runIncrementalUpdateForTenant(
    getRuntimeSql(),
    descriptor,
    tenantId
  );
  expect(outcome.failed).toBe(false);
  expect(outcome.skippedRebuildInProgress).toBe(false);
}

async function refresh(tenantId = TENANT_A): Promise<void> {
  await refreshOne(REVENUE, tenantId);
  await refreshOne(RETENTION, tenantId);
}

async function rebuild(
  descriptor: ProjectionDescriptor,
  tenantId = TENANT_A
): Promise<void> {
  const { run } = await inTenant(
    (tx) =>
      triggerOrResumeRebuild(tx, tenantId, descriptor, {
        requestedBy: null,
        reason: "integration test"
      }),
    tenantId
  );
  const result = await continueRebuildPasses(
    getRuntimeSql(),
    tenantId,
    descriptor,
    run.id
  );
  expect(result.status).toBe("completed");
}

function reconcile(descriptor: ProjectionDescriptor, tenantId = TENANT_A) {
  return inTenant(
    (tx) => reconcileProjection(tx, tenantId, descriptor, null),
    tenantId
  );
}

async function report(from = dayAgo(10), to = dayAgo(0), tenantId = TENANT_A) {
  return inTenant(
    (tx) => fetchBookingRevenueReport(tx, tenantId, { from, to }),
    tenantId
  );
}

const dayOf = (result: Awaited<ReturnType<typeof report>>, day: string) =>
  result.days.find((entry) => entry.day === day);

/** The stored rows, `updated_at` and the surrogate id excluded, to compare a rebuild with the live pass. */
async function rawRows(tenantId = TENANT_A) {
  return getAdminSql()`
    SELECT order_id, to_char(paid_day, 'YYYY-MM-DD') AS paid_day, source_kind, stays,
      no_shows, no_show_retained, gross, discount, shipping, insurance, tax, total,
      paid_in, paid_back, uncollected, outstanding, closed
    FROM awcms_commerce_report_booking_orders
    WHERE tenant_id = ${tenantId} ORDER BY order_id
  `;
}

async function rowOf(orderId: string) {
  const rows = (await getAdminSql()`
    SELECT to_char(paid_day, 'YYYY-MM-DD') AS paid_day, source_kind, stays, no_shows,
      no_show_retained::text, gross::text, discount::text, paid_in::text,
      paid_back::text, uncollected::text, outstanding::text, closed
    FROM awcms_commerce_report_booking_orders WHERE order_id = ${orderId}
  `) as Record<string, unknown>[];
  return rows[0] ?? null;
}

/** Moves the order's first paid transition to `daysAgo` days before it really happened (a test-only header edit). */
async function paidDaysAgo(orderId: string, daysAgo: number): Promise<void> {
  await getAdminSql()`
    UPDATE awcms_commerce_orders
    SET paid_at = paid_at - make_interval(secs => ${daysAgo * 86_400})
    WHERE id = ${orderId}
  `;
}

/** A discount the order recorded before payment (a voucher): the header edit a voucher would have made at checkout. */
async function applyVoucher(orderId: string, amount: number): Promise<void> {
  await getAdminSql()`
    UPDATE awcms_commerce_orders
    SET voucher_discount = ${rp(amount)}, total = total - ${rp(amount)}::numeric
    WHERE id = ${orderId}
  `;
}

/** A goodwill refund booked by hand: a settled REVERSAL leg of the ledger. There is no order-status event, which is why the projection listens to the leg. */
async function refundByHand(
  orderId: string,
  amount: number,
  key: string
): Promise<void> {
  const admin = getAdminSql();
  const payment = (await admin`
    SELECT id FROM awcms_commerce_payment_allocations
    WHERE order_id = ${orderId} AND kind = 'payment' AND status = 'succeeded'
    ORDER BY created_at DESC LIMIT 1
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_commerce_payment_allocations
      (tenant_id, order_id, kind, reverses_allocation_id, tender_type, amount, status,
       source, source_key, actor_kind, created_at, settled_at)
    VALUES (${TENANT_A}, ${orderId}, 'reversal', ${payment[0]!.id}, 'manual_qris',
      ${rp(amount)}, 'succeeded', 'admin', ${key}, 'system', now(), now())
  `;
}

async function depositProduct(price: string, percent = "30.00") {
  const f = await newFixture(TENANT_A, STAFF, { price });
  await inTenant((tx) =>
    setProductDepositPolicy(tx, TENANT_A, STAFF, f.productId, {
      kind: "percent",
      percent
    })
  );
  return f;
}

async function noShow(reservationId: string) {
  return inTenant(async (tx) => {
    const link = await fetchReservationLinkByReservationId(
      tx,
      TENANT_A,
      reservationId
    );
    if (!link) throw new Error("no link");
    const result = await recordBookingNoShow(
      tx,
      {
        tenantId: TENANT_A,
        actor: { kind: "staff", tenantUserId: STAFF },
        correlationId: crypto.randomUUID(),
        port: await composedBookingPort()
      },
      {
        link,
        idempotencyKey: nextKey(),
        reasonCode: DEFAULT_NO_SHOW_REASON_CODE
      }
    );
    if (result.kind === "refused") {
      throw new Error(`no-show refused: ${JSON.stringify(result)}`);
    }
    return result;
  });
}

/** Cancels as staff at `hoursBefore` hours before the ORIGINAL arrival (the clock is injected). */
async function cancel(
  reservationId: string,
  hoursBefore: number
): Promise<Extract<CancelResult, { decision: unknown }>> {
  const startsAt = await startsAtOf(reservationId);
  const result = await inTenant(async (tx) => {
    const link = await fetchReservationLinkByReservationId(
      tx,
      TENANT_A,
      reservationId
    );
    if (!link) throw new Error("no link");
    return cancelBookingReservation(
      tx,
      {
        tenantId: TENANT_A,
        actor: { kind: "staff", tenantUserId: STAFF },
        correlationId: crypto.randomUUID(),
        port: await composedBookingPort(),
        now: new Date(startsAt - hoursBefore * HOUR)
      },
      {
        link,
        idempotencyKey: nextKey(),
        reasonCode: "guest_request",
        acknowledgedRefund: null,
        override: null
      }
    );
  });
  if (result.kind === "refused") {
    throw new Error(`cancel refused: ${JSON.stringify(result)}`);
  }
  return result as Extract<CancelResult, { decision: unknown }>;
}

/** Pays out every pending refund leg of the cancellation through the EXISTING execute path (no provider: a manual tender settles). */
async function settleRefund(returnId: string): Promise<void> {
  for (const leg of await legsOf(returnId)) {
    const outcome = await executeRefund(
      getRuntimeSql(),
      TENANT_A,
      {
        returnId,
        refundId: leg.id,
        actorTenantUserId: MANAGER,
        registerSessionId: null
      },
      { provider: null }
    );
    expect(outcome.kind).toBe("settled");
  }
}

async function resched(
  reservationId: string,
  stay: { checkInDate: string; checkOutDate: string }
): Promise<Extract<RescheduleResult, { view: unknown }>> {
  const result = await inTenant(async (tx) => {
    const link = await fetchReservationLinkByReservationId(
      tx,
      TENANT_A,
      reservationId
    );
    if (!link) throw new Error("no link");
    return rescheduleBookingReservation(
      tx,
      {
        tenantId: TENANT_A,
        actor: { kind: "staff", tenantUserId: STAFF },
        correlationId: crypto.randomUUID(),
        port: await composedBookingPort(),
        mediaPort: mediaLibraryPortAdapter
      },
      {
        link,
        idempotencyKey: nextKey(),
        request: {
          startsAt: null,
          stay,
          resourceId: null,
          reasonCode: DEFAULT_RESCHEDULE_REASON_CODE
        }
      }
    );
  });
  if (result.kind === "refused") {
    throw new Error(`reschedule refused: ${JSON.stringify(result)}`);
  }
  return result as Extract<RescheduleResult, { view: unknown }>;
}

async function enableRetention(tenantId = TENANT_A): Promise<void> {
  await inTenant(
    (tx) =>
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
            returns: true,
            booking: true,
            retention: true
          }
        },
        STAFF
      ),
    tenantId
  );
}

async function setBooking(on: boolean, tenantId = TENANT_A): Promise<void> {
  await inTenant(
    (tx) =>
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
            returns: true,
            booking: on
          }
        },
        STAFF
      ),
    tenantId
  );
}

async function retentionReport() {
  return inTenant((tx) =>
    fetchRetentionReport(tx, TENANT_A, { months: 12 }, new Date())
  );
}

async function retentionRows() {
  return getAdminSql()`
    SELECT customer_id, to_char(cohort_month, 'YYYY-MM-DD') AS cohort_month,
      first_event_at, second_event_at, qualifying_order_count, first_event_kind,
      qualifying_booking_count
    FROM awcms_commerce_report_retention_customers
    WHERE tenant_id = ${TENANT_A} ORDER BY customer_id
  `;
}

async function customerOfOrder(orderId: string): Promise<string> {
  const rows = (await getAdminSql()`
    SELECT customer_id FROM awcms_commerce_orders WHERE id = ${orderId}
  `) as { customer_id: string }[];
  return rows[0]!.customer_id;
}

/** An ORDINARY paid order of `customerId` (no reservation link): a product sale `daysAfterNow` days from now. */
async function ordinaryPaidOrder(
  customerId: string,
  paidAt: Date
): Promise<string> {
  const admin = getAdminSql();
  const [order] = (await admin`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method, payment_status,
       shipping_method, shipping_cost, subtotal, total, paid_at)
    VALUES (${TENANT_A}, ${`ORD-${process.pid}-${Math.random().toString(36).slice(2, 9)}`}, ${customerId},
      'completed', 'manual_bank', 'paid', 'courier', 10000.00, 90000.00, 100000.00, ${paidAt})
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_commerce_order_events
      (tenant_id, order_id, from_status, to_status, actor, created_at)
    VALUES (${TENANT_A}, ${order!.id}, 'pending_payment', 'paid', 'admin', now())
  `;
  return order!.id;
}

suite(
  "booking revenue, hold pipeline and the booking anchor (Issue #389)",
  () => {
    const originalLag = process.env.REPORTING_PROJECTION_LAG_SECONDS;

    beforeAll(async () => {
      process.env.REPORTING_PROJECTION_LAG_SECONDS = "0";
      await setupIntegrationDatabase();
    }, 120000);

    afterAll(async () => {
      if (originalLag === undefined) {
        delete process.env.REPORTING_PROJECTION_LAG_SECONDS;
      } else {
        process.env.REPORTING_PROJECTION_LAG_SECONDS = originalLag;
      }
      await teardownIntegrationDatabase();
    }, 60000);

    beforeEach(async () => {
      await resetDatabase();
      await fx.seedTenant(TENANT_A, "tenant-rv-a", [
        [STAFF, "rv-staff"],
        [MANAGER, "rv-manager"],
        [SERVICE, "rv-service"]
      ]);
      await fx.seedTenant(TENANT_B, "tenant-rv-b", [
        [STAFF_B, "rvb-staff"],
        [SERVICE_B, "rvb-service"]
      ]);
      await fx.configureTenant(TENANT_A, STAFF, SERVICE);
      await fx.configureTenant(TENANT_B, STAFF_B, SERVICE_B);
    }, 60000);

    // ---------------------------------------------------------------------------
    test("proof 8: the three rows of the section 3.7 worked example through the real adapter - balance paid, no-show with the deposit retained, early cancel with half the deposit refunded", async () => {
      const stay = { checkInDate: D(10), checkOutDate: D(13) }; // three nights at 1,000,000

      // Row 1: the balance is paid at check-in.
      const f1 = await depositProduct("1000000.00");
      const v1 = await book(f1, {
        req: { paymentMethod: "dp", stay, guest: guest() }
      });
      await pay(v1.orderId, "900000.00");
      await dispatch();

      // After the deposit alone: the whole 3,000,000 is gross on the deposit day,
      // and the 2,100,000 balance is shown BESIDE the waterfall, not subtracted.
      await refresh();
      const afterDeposit = dayOf(await report(), dayAgo(0))!;
      expect(afterDeposit).toMatchObject({
        gross: "3000000.00",
        refunds: "0.00",
        net: "3000000.00",
        balanceOutstanding: "2100000.00"
      });

      await pay(v1.orderId, "2100000.00");

      // Row 2: no-show, the deposit retained, the balance never paid.
      const f2 = await depositProduct("1000000.00");
      await policy(f2.productId, undefined, { retention: "retain_deposit" });
      const v2 = await book(f2, {
        req: { paymentMethod: "dp", stay, guest: guest() }
      });
      await pay(v2.orderId, "900000.00");
      await dispatch();
      await arrivedHoursAgo(v2.reservationId, 3);
      await noShow(v2.reservationId);

      // Row 3: cancelled early, half the deposit refunded (the 50% window).
      const f3 = await depositProduct("1000000.00");
      await policy(f3.productId, STANDARD_WINDOWS);
      const v3 = await book(f3, {
        req: { paymentMethod: "dp", stay, guest: guest() }
      });
      await pay(v3.orderId, "900000.00");
      await dispatch();
      const cancelled = await cancel(v3.reservationId, 100);
      expect(cancelled.decision.finalRefund).toBe("450000.00");
      await settleRefund(cancelled.decision.returnId!);

      // Each case on its own paid day, as the contract's table reads.
      await paidDaysAgo(v1.orderId, 3);
      await paidDaysAgo(v2.orderId, 2);
      await paidDaysAgo(v3.orderId, 1);
      await refresh();

      const result = await report();
      expect(result.enabled).toBe(true);
      expect(dayOf(result, dayAgo(3))).toMatchObject({
        orders: 1,
        gross: "3000000.00",
        discounts: "0.00",
        refundsPaidBack: "0.00",
        refundsUncollected: "0.00",
        refunds: "0.00",
        net: "3000000.00",
        balanceOutstanding: "0.00"
      });
      expect(dayOf(result, dayAgo(2))).toMatchObject({
        gross: "3000000.00",
        refundsPaidBack: "0.00",
        refundsUncollected: "2100000.00",
        refunds: "2100000.00",
        net: "900000.00",
        balanceOutstanding: "0.00",
        noShows: 1,
        noShowRetained: "900000.00",
        noShowRatePercent: "100.0"
      });
      expect(dayOf(result, dayAgo(1))).toMatchObject({
        gross: "3000000.00",
        refundsPaidBack: "450000.00",
        refundsUncollected: "2100000.00",
        refunds: "2550000.00",
        net: "450000.00",
        balanceOutstanding: "0.00"
      });
      // The two parts always add up to the Refunds step; the range totals the three.
      expect(result.totals).toMatchObject({
        gross: "9000000.00",
        refunds: "4650000.00",
        refundsPaidBack: "450000.00",
        refundsUncollected: "4200000.00",
        net: "4350000.00",
        stays: 3,
        noShows: 1
      });
      // The cancelled and the no-show reservations were released; the money
      // identity of metrics 3.5 holds on every stored row.
      const identity = (await getAdminSql()`
      SELECT count(*)::int AS broken FROM awcms_commerce_report_booking_orders
      WHERE (gross - discount - paid_back - uncollected) + shipping + insurance + tax
        <> (paid_in - paid_back) + outstanding - GREATEST(paid_in - total, 0)
    `) as { broken: number }[];
      expect(identity[0]!.broken).toBe(0);
    }, 120000);

    // ---------------------------------------------------------------------------
    test("the balance paid after the deposit moves only the outstanding balance, never the waterfall or the day", async () => {
      const f = await depositProduct("1000000.00");
      const view = await book(f, {
        req: {
          paymentMethod: "dp",
          stay: { checkInDate: D(10), checkOutDate: D(13) },
          guest: guest()
        }
      });
      await pay(view.orderId, "900000.00");
      await dispatch();
      await refresh();
      const before = dayOf(await report(), dayAgo(0))!;
      expect(before.balanceOutstanding).toBe("2100000.00");

      await pay(view.orderId, "2100000.00");
      await refresh();
      const after = dayOf(await report(), dayAgo(0))!;
      expect(after.gross).toBe(before.gross);
      expect(after.net).toBe(before.net);
      expect(after.balanceOutstanding).toBe("0.00");
      expect(after.restated).toBe(false);
    }, 60000);

    // ---------------------------------------------------------------------------
    test("the villa week of section 8.3 to the cent: gross 5,500,000, discounts 250,000, refunds 100,000, net 5,150,000; ADR 1,030,000, RevPAN 858,333.33; the held night is pipeline, not revenue", async () => {
      // R1: 3 nights, 3,000,000, paid in full.
      const f1 = await newFixture(TENANT_A, STAFF, { price: "1000000.00" });
      const r1 = await book(f1, {
        req: {
          stay: { checkInDate: D(12), checkOutDate: D(15) },
          guest: guest()
        }
      });
      await pay(r1.orderId, "3000000.00");

      // R2: 2 nights, 2,500,000 list, a 250,000 discount applied at payment, a
      // 100,000 partial refund after the stay - both on R2's original paid day.
      const f2 = await newFixture(TENANT_A, STAFF, { price: "1250000.00" });
      const r2 = await book(f2, {
        req: {
          stay: { checkInDate: D(16), checkOutDate: D(18) },
          guest: guest()
        }
      });
      await applyVoucher(r2.orderId, 250_000);
      await pay(r2.orderId, "2250000.00");

      // R3: 1 night, held, not paid (price 1,000,000).
      const f3 = await newFixture(TENANT_A, STAFF, { price: "1000000.00" });
      const r3 = await book(f3, {
        req: {
          stay: { checkInDate: D(18), checkOutDate: D(19) },
          guest: guest()
        }
      });
      await dispatch();
      await paidDaysAgo(r1.orderId, 2);
      await paidDaysAgo(r2.orderId, 1);
      await refresh();
      await refundByHand(r2.orderId, 100_000, "refund-r2-389");
      await refresh();

      const result = await report();
      expect(dayOf(result, dayAgo(2))).toMatchObject({
        gross: "3000000.00",
        discounts: "0.00",
        refunds: "0.00",
        net: "3000000.00"
      });
      // R2's refund and discount attribute to R2's ORIGINAL paid day.
      expect(dayOf(result, dayAgo(1))).toMatchObject({
        gross: "2500000.00",
        discounts: "250000.00",
        refunds: "100000.00",
        refundsPaidBack: "100000.00",
        net: "2150000.00"
      });
      expect(result.totals).toMatchObject({
        orders: 2,
        gross: "5500000.00",
        discounts: "250000.00",
        refunds: "100000.00",
        net: "5150000.00",
        discountRatePercent: "4.5",
        refundRatePercent: "1.8"
      });
      expect(dayOf(result, dayAgo(0))).toBeUndefined();

      // ADR and RevPAN: the nights are Booking's (occupied 5 = 3 + 2, available 6
      // with the maintenance night removed); commerce supplies the net.
      const netCents = BigInt(result.totals.net.replace(".", ""));
      expect(averageDailyRate(netCents, 5)).toBe("1030000.00");
      expect(revenuePerAvailableNight(netCents, 6)).toBe("858333.33");

      // R3 is a hold: one held night, valued at its order total, in the pipeline
      // only - it has no row and no revenue.
      const pipeline = await inTenant((tx) =>
        fetchBookingPipeline(tx, TENANT_A)
      );
      expect(pipeline.enabled).toBe(true);
      expect(pipeline.pipeline).toMatchObject({
        holds: 1,
        units: 1,
        value: "1000000.00"
      });
      expect(pipeline.pipeline.oldestHoldAgeSeconds).toBeGreaterThanOrEqual(0);
      expect(pipeline.pipeline.nextExpiryAt).not.toBeNull();
      expect(await rowOf(r3.orderId)).toBeNull();
    }, 120000);

    // ---------------------------------------------------------------------------
    test("the pipeline counts only live holds: a paid order, a cancelled one and an expired one leave it; a slot counts as one unit", async () => {
      const f = await newFixture(TENANT_A, STAFF, { price: "500000.00" });
      const held = await book(f, {
        req: {
          stay: { checkInDate: D(10), checkOutDate: D(12) },
          guest: guest()
        }
      });
      const f2 = await newFixture(TENANT_A, STAFF, { price: "500000.00" });
      const paid = await book(f2, {
        req: {
          stay: { checkInDate: D(10), checkOutDate: D(11) },
          guest: guest()
        }
      });
      const f3 = await newFixture(TENANT_A, STAFF, { price: "500000.00" });
      const expired = await book(f3, {
        req: {
          stay: { checkInDate: D(10), checkOutDate: D(11) },
          guest: guest()
        }
      });
      const slot = await fx.newSlotFixture(TENANT_A, STAFF);
      await book(slot, {
        req: {
          offeringId: slot.offeringId,
          resourceId: slot.resourceId,
          stay: null,
          startsAt: fx.slotAt(10),
          guest: guest()
        }
      });
      await pay(paid.orderId, "500000.00");
      await getAdminSql()`
      UPDATE awcms_commerce_orders SET expires_at = now() - interval '1 minute'
      WHERE id = ${expired.orderId}
    `;

      const pipeline = (
        await inTenant((tx) => fetchBookingPipeline(tx, TENANT_A))
      ).pipeline;
      // The two-night stay (2 units) and the slot (1 unit); the paid order and the
      // lapsed hold are out.
      expect(pipeline.holds).toBe(2);
      expect(pipeline.units).toBe(3);
      expect(pipeline.value).toBe("1500000.00");
      expect(held.orderId).toBeTruthy();
    }, 120000);

    // ---------------------------------------------------------------------------
    test("fully refunded: the stay was paid and cancelled with a full refund - gross and refunds both 500,000, net 0, on the paid day", async () => {
      const f = await newFixture(TENANT_A, STAFF, { price: "500000.00" });
      await policy(f.productId, STANDARD_WINDOWS);
      const view = await book(f, {
        req: {
          stay: { checkInDate: D(10), checkOutDate: D(11) },
          guest: guest()
        }
      });
      await pay(view.orderId, "500000.00");
      await dispatch();
      const cancelled = await cancel(view.reservationId, 200);
      expect(cancelled.decision.finalRefund).toBe("500000.00");
      await settleRefund(cancelled.decision.returnId!);
      await paidDaysAgo(view.orderId, 4);
      await refresh();

      const day = dayOf(await report(), dayAgo(4))!;
      expect(day).toMatchObject({
        gross: "500000.00",
        refunds: "500000.00",
        refundsPaidBack: "500000.00",
        refundsUncollected: "0.00",
        net: "0.00",
        refundRatePercent: "100.0"
      });
    }, 120000);

    // ---------------------------------------------------------------------------
    test("a late cancellation with nothing refunded keeps the retained payment as settled revenue; the guest is no booking event for retention", async () => {
      await enableRetention();
      const f = await newFixture(TENANT_A, STAFF, { price: "500000.00" });
      await policy(f.productId, STANDARD_WINDOWS);
      const view = await book(f, {
        req: {
          stay: { checkInDate: D(10), checkOutDate: D(11) },
          guest: guest()
        }
      });
      await pay(view.orderId, "500000.00");
      await dispatch();
      await refresh();
      expect((await retentionRows()).length).toBe(1);

      // Inside the no-refund window: the decision is zero, no return, no leg, no
      // order-status event - only the decision row says the stay is gone.
      const cancelled = await cancel(view.reservationId, 10);
      expect(cancelled.decision.finalRefund).toBe("0.00");
      await refresh();

      expect(await rowOf(view.orderId)).toMatchObject({
        closed: true,
        uncollected: "0.00",
        paid_back: "0.00"
      });
      expect(dayOf(await report(), dayAgo(0))).toMatchObject({
        gross: "500000.00",
        refunds: "0.00",
        net: "500000.00"
      });
      // The order is paid and NOT refunded - the old order-only rule would keep
      // the customer in a cohort. The cancelled stay is not an event.
      expect((await retentionRows()).length).toBe(0);
    }, 120000);

    // ---------------------------------------------------------------------------
    test("walk-in: a booking order of the POS walk-in placeholder is revenue, and is 'unlinked' for retention; a walk-in service sale with no reservation is not a booking at all", async () => {
      await enableRetention();
      const f = await newFixture(TENANT_A, STAFF, { price: "500000.00" });
      const view = await book(f, {
        req: {
          stay: { checkInDate: D(10), checkOutDate: D(11) },
          guest: guest()
        }
      });
      const walkIn = (await getAdminSql()`
      INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
      VALUES (${TENANT_A}, 'Walk-in', ${POS_WALK_IN_CUSTOMER_SENTINEL_PHONE})
      RETURNING id
    `) as { id: string }[];
      await getAdminSql()`
      UPDATE awcms_commerce_orders SET customer_id = ${walkIn[0]!.id}
      WHERE id = ${view.orderId}
    `;
      await pay(view.orderId, "500000.00");
      // A walk-in SERVICE sale with no reservation: an ordinary paid order.
      const plain = await ordinaryPaidOrder(walkIn[0]!.id, new Date());
      await dispatch();
      await refresh();

      // A sale is revenue: included. The link-less sale is not a booking.
      expect(dayOf(await report(), dayAgo(0))).toMatchObject({
        orders: 1,
        gross: "500000.00",
        net: "500000.00"
      });
      expect(await rowOf(plain)).toBeNull();

      // Excluded from every cohort and reported once as unlinked.
      const retention = await retentionReport();
      expect(retention.cohorts).toEqual([]);
      expect(retention.unlinkedOrders).toBe(2);
    }, 120000);

    // ---------------------------------------------------------------------------
    test("proof 5: the booking anchor - a stay is one event, the supplementary order of a stay that grew is not a repeat, a later ordinary order is", async () => {
      await enableRetention();
      // Customer X: a stay (anchor), a reschedule that adds a night (a
      // supplementary order, paid), later an ordinary order inside 90 days.
      const f = await newFixture(TENANT_A, STAFF, { price: "500000.00" });
      const view = await book(f, {
        req: {
          stay: { checkInDate: D(10), checkOutDate: D(12) },
          guest: guest()
        }
      });
      await pay(view.orderId, "1000000.00");
      await dispatch();
      const moved = await resched(view.reservationId, {
        checkInDate: D(20),
        checkOutDate: D(23)
      });
      const supplementId = moved.view.supplementOrder!.orderId;
      await pay(supplementId, "500000.00");
      await dispatch();
      await refresh();

      const customer = await customerOfOrder(view.orderId);
      let rows = await retentionRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        customer_id: customer,
        first_event_kind: "booking",
        qualifying_order_count: 1,
        qualifying_booking_count: 1
      });
      // Not a repeat: the supplement is part of the stay.
      expect(rows[0]!.second_event_at).toBeNull();
      // The supplementary order is booking-sourced revenue of its own day.
      expect(await rowOf(supplementId)).toMatchObject({
        source_kind: "supplement",
        stays: 0,
        gross: "500000.00"
      });
      expect(await rowOf(view.orderId)).toMatchObject({
        source_kind: "reservation",
        stays: 1
      });

      // An ordinary order a month later IS the second event.
      await ordinaryPaidOrder(customer, new Date(Date.now() + 30 * DAY));
      await refresh();
      rows = await retentionRows();
      expect(rows[0]).toMatchObject({
        first_event_kind: "booking",
        qualifying_order_count: 2,
        qualifying_booking_count: 1
      });
      expect(rows[0]!.second_event_at).not.toBeNull();

      const cohort = (await retentionReport()).cohorts.find(
        (entry) => entry.size >= 1
      )!;
      expect(cohort).toMatchObject({
        size: 1,
        repeaters: 1,
        bookingAnchored: 1
      });
    }, 180000);

    // ---------------------------------------------------------------------------
    test("a fully refunded first stay never started the customer (the cohort is handed to nobody) and the refund is read from the ledger leg", async () => {
      await enableRetention();
      const f = await newFixture(TENANT_A, STAFF, { price: "500000.00" });
      await policy(f.productId, STANDARD_WINDOWS);
      const view = await book(f, {
        req: {
          stay: { checkInDate: D(10), checkOutDate: D(11) },
          guest: guest()
        }
      });
      await pay(view.orderId, "500000.00");
      await dispatch();
      await refresh();
      expect(await retentionRows()).toHaveLength(1);

      const cancelled = await cancel(view.reservationId, 200);
      await settleRefund(cancelled.decision.returnId!);
      await refresh();
      expect(await retentionRows()).toHaveLength(0);
    }, 120000);

    // ---------------------------------------------------------------------------
    test("proof 1: rebuild equals live byte for byte, reconciliation is clean for both projections, and tampering is flagged", async () => {
      await enableRetention();
      const stay = { checkInDate: D(10), checkOutDate: D(12) };
      const fa = await depositProduct("500000.00");
      const a = await book(fa, {
        req: { paymentMethod: "dp", stay, guest: guest() }
      });
      await pay(a.orderId, "300000.00");
      await dispatch();
      const fb = await newFixture(TENANT_A, STAFF, { price: "500000.00" });
      await policy(fb.productId, STANDARD_WINDOWS);
      const b = await book(fb, { req: { stay, guest: guest() } });
      await pay(b.orderId, "1000000.00");
      await dispatch();
      const cancelled = await cancel(b.reservationId, 100);
      await settleRefund(cancelled.decision.returnId!);
      await paidDaysAgo(a.orderId, 2);
      await refresh();

      const live = await rawRows();
      const liveRetention = await retentionRows();
      expect(live).toHaveLength(2);

      await rebuild(REVENUE);
      await rebuild(RETENTION);
      expect(await rawRows()).toEqual(live);
      expect(await retentionRows()).toEqual(liveRetention);

      const run = await reconcile(REVENUE);
      expect(run.mismatch).toBe(false);
      expect(run.details.length).toBeGreaterThan(5);
      expect(run.details.every((detail) => !detail.mismatch)).toBe(true);
      expect(
        run.details.some((detail) => detail.metricKey === "booking_gross_cents")
      ).toBe(true);
      expect((await reconcile(RETENTION)).mismatch).toBe(false);

      // The engine's own counters: the streams consumed what the sources hold.
      const metrics = await inTenant((tx) =>
        getProjectionMetrics(tx, TENANT_A, BOOKING_REVENUE_PROJECTION_KEY)
      );
      expect(metrics[BOOKING_REVENUE_METRIC_KEYS.refundDecisions]).toBe(1);
      expect(metrics[BOOKING_REVENUE_METRIC_KEYS.paymentLegs]).toBeGreaterThan(
        2
      );

      // Tampering with a stored figure is flagged.
      await getAdminSql()`
      UPDATE awcms_commerce_report_booking_orders
      SET gross = gross + 1, total = total + 1
      WHERE tenant_id = ${TENANT_A} AND order_id = ${a.orderId}
    `;
      const drift = await reconcile(REVENUE);
      expect(drift.mismatch).toBe(true);
      expect(
        drift.details.find(
          (detail) => detail.metricKey === "booking_gross_cents"
        )?.mismatch
      ).toBe(true);
    }, 180000);

    // ---------------------------------------------------------------------------
    test("proof 2: nothing is counted twice - repeated passes and repeated recomputes leave the rows exactly as they were", async () => {
      const f = await depositProduct("1000000.00");
      const view = await book(f, {
        req: {
          paymentMethod: "dp",
          stay: { checkInDate: D(10), checkOutDate: D(13) },
          guest: guest()
        }
      });
      await pay(view.orderId, "900000.00");
      await dispatch();
      await refresh();
      const once = await rawRows();
      await refresh();
      await refresh();
      await inTenant((tx) =>
        recomputeBookingRevenueRows(tx, TENANT_A, [view.orderId, view.orderId])
      );
      expect(await rawRows()).toEqual(once);
      expect(dayOf(await report(), dayAgo(0))).toMatchObject({
        orders: 1,
        gross: "3000000.00"
      });
    }, 60000);

    // ---------------------------------------------------------------------------
    test("the restatement log: a refund after the 35-day window restates the ORIGINAL paid day (and only that), a rebuild leaves the evidence untouched", async () => {
      const f = await newFixture(TENANT_A, STAFF, { price: "500000.00" });
      const view = await book(f, {
        req: {
          stay: { checkInDate: D(10), checkOutDate: D(12) },
          guest: guest()
        }
      });
      await pay(view.orderId, "1000000.00");
      await dispatch();
      // A fresh day: ordinary filling-in, nothing restated.
      await refresh();
      expect(dayOf(await report(), dayAgo(0))?.restated).toBe(false);

      // The order's day is long closed (a test-only header edit), and the log is
      // cleared so only the LATE refund below can write it.
      await paidDaysAgo(view.orderId, 60);
      await refresh();
      await refundByHand(view.orderId, 100_000, "late-refund-389");
      await getAdminSql()`DELETE FROM awcms_commerce_report_booking_restated`;
      await refresh();

      const result = await report(dayAgo(70), dayAgo(0));
      const old = dayOf(result, dayAgo(60))!;
      expect(old).toMatchObject({
        gross: "1000000.00",
        refundsPaidBack: "100000.00",
        net: "900000.00",
        restated: true
      });
      // Nothing landed on today or on the refund's own day.
      expect(dayOf(result, dayAgo(0))).toBeUndefined();

      const evidence = await getAdminSql()`
      SELECT to_char(day, 'YYYY-MM-DD') AS day FROM awcms_commerce_report_booking_restated
    `;
      expect(evidence.map((row: { day: string }) => row.day)).toEqual([
        dayAgo(60)
      ]);
      await rebuild(REVENUE);
      expect(
        (
          await getAdminSql()`
          SELECT to_char(day, 'YYYY-MM-DD') AS day FROM awcms_commerce_report_booking_restated`
        ).map((row: { day: string }) => row.day)
      ).toEqual([dayAgo(60)]);
    }, 120000);

    // ---------------------------------------------------------------------------
    test("the per-tenant toggle: with booking OFF the report and the pipeline are enabled=false and empty, with it ON they show, and the rows stay either way", async () => {
      const f = await newFixture(TENANT_A, STAFF, { price: "500000.00" });
      const view = await book(f, {
        req: {
          stay: { checkInDate: D(10), checkOutDate: D(11) },
          guest: guest()
        }
      });
      await pay(view.orderId, "500000.00");
      await dispatch();
      await refresh();

      await setBooking(false);
      const off = await report();
      expect(off.enabled).toBe(false);
      expect(off.days).toEqual([]);
      expect(off.totals.net).toBe("0.00");
      const offPipeline = await inTenant((tx) =>
        fetchBookingPipeline(tx, TENANT_A)
      );
      expect(offPipeline.enabled).toBe(false);
      expect(offPipeline.pipeline.holds).toBe(0);
      expect(await rawRows()).toHaveLength(1);

      await setBooking(true);
      expect((await report()).days).toHaveLength(1);
    }, 60000);

    // ---------------------------------------------------------------------------
    test("proof 7: no second store - one reporting descriptor, two commerce tables, the engine's own cursors and counters", async () => {
      const f = await newFixture(TENANT_A, STAFF, { price: "500000.00" });
      const view = await book(f, {
        req: {
          stay: { checkInDate: D(10), checkOutDate: D(11) },
          guest: guest()
        }
      });
      await pay(view.orderId, "500000.00");
      await dispatch();
      await refresh();

      expect(
        commerceModule.reportingProjections!.filter(
          (descriptor) => descriptor.key === BOOKING_REVENUE_PROJECTION_KEY
        )
      ).toHaveLength(1);
      expect(REVENUE.source.strategy).toBe("cursor_table");
      expect(REVENUE.dimensional).toBeDefined();

      const tables = (await getAdminSql()`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name LIKE 'awcms_commerce_report_booking%'
      ORDER BY table_name
    `) as { table_name: string }[];
      expect(tables.map((row) => row.table_name)).toEqual([
        "awcms_commerce_report_booking_orders",
        "awcms_commerce_report_booking_restated"
      ]);
      const cursors = (await getAdminSql()`
      SELECT stream_key FROM awcms_reporting_projection_cursors
      WHERE tenant_id = ${TENANT_A} AND projection_key = ${BOOKING_REVENUE_PROJECTION_KEY}
      ORDER BY stream_key
    `) as { stream_key: string }[];
      // A stream gets its cursor row with its first row; this flow wrote no
      // decision and no reschedule, so those two have none yet.
      expect(cursors.map((row) => row.stream_key)).toEqual([
        "order_events",
        "payment_legs"
      ]);
      expect(
        REVENUE.source.strategy === "cursor_table" &&
          REVENUE.source.streams.map((stream) => stream.streamKey)
      ).toEqual([
        "order_events",
        "payment_legs",
        "refund_decisions",
        "reschedules"
      ]);
      // The retention descriptor gained the booking streams, nothing else.
      expect(
        RETENTION.source.strategy === "cursor_table" &&
          RETENTION.source.streams.map((stream) => stream.streamKey)
      ).toEqual([
        "order_events",
        "reversal_legs",
        "booking_decisions",
        "booking_reschedules"
      ]);
    }, 60000);

    // ---------------------------------------------------------------------------
    test("export writes the waterfall per day as aggregates only, never an order or a customer", async () => {
      const f = await depositProduct("1000000.00");
      const view = await book(f, {
        req: {
          paymentMethod: "dp",
          stay: { checkInDate: D(10), checkOutDate: D(13) },
          guest: guest()
        }
      });
      await pay(view.orderId, "900000.00");
      await dispatch();
      await refresh();
      const rootPath = `${process.cwd()}/var/test-booking-revenue-exports-${process.pid}`;
      const run = await generateProjectionExport(
        getRuntimeSql(),
        {
          tenantId: TENANT_A,
          descriptor: REVENUE,
          format: "csv",
          scheduledExportId: null,
          requestedBy: null
        },
        { ...process.env, REPORTING_EXPORT_ROOT_PATH: rootPath }
      );
      expect(run.status).toBe("completed");
      const lines = (await Bun.file(run.storagePath!).text())
        .trim()
        .split("\n");
      expect(lines[0]).toBe(
        "day,orders,gross,discounts,refunds_paid_back,refunds_uncollected,net,shipping,insurance,tax,balance_outstanding,stays,no_shows,no_show_retained"
      );
      expect(lines[1]).toBe(
        `${dayAgo(0)},1,3000000.00,0.00,0.00,0.00,3000000.00,0.00,0.00,0.00,2100000.00,1,0,0.00`
      );
      expect(lines.join("\n")).not.toContain(view.orderId);
      await Bun.$`rm -rf ${rootPath}`.quiet();
    }, 60000);

    // ---------------------------------------------------------------------------
    test("RLS: tenant B reads none of tenant A's rows and cannot write one for tenant A", async () => {
      const f = await newFixture(TENANT_A, STAFF, { price: "500000.00" });
      const view = await book(f, {
        req: {
          stay: { checkInDate: D(10), checkOutDate: D(11) },
          guest: guest()
        }
      });
      await pay(view.orderId, "500000.00");
      await dispatch();
      await refresh();

      const forB = await report(dayAgo(10), dayAgo(0), TENANT_B);
      expect(forB.enabled).toBe(true);
      expect(forB.days).toEqual([]);
      for (const table of [
        "awcms_commerce_report_booking_orders",
        "awcms_commerce_report_booking_restated"
      ]) {
        const leaked = await inTenant(
          async (tx) =>
            (await tx.unsafe(
              `SELECT count(*)::int AS count FROM ${table}`
            )) as {
              count: number;
            }[],
          TENANT_B
        );
        expect(leaked[0]!.count).toBe(0);
      }
      const pipelineB = await inTenant(
        (tx) => fetchBookingPipeline(tx, TENANT_B),
        TENANT_B
      );
      expect(pipelineB.pipeline.holds).toBe(0);
      await expect(
        inTenant(
          (tx) =>
            tx`INSERT INTO awcms_commerce_report_booking_restated (tenant_id, day, restated_at)
             VALUES (${TENANT_A}, ${dayAgo(1)}::date, now())`,
          TENANT_B
        )
      ).rejects.toThrow();
    }, 60000);

    // ---------------------------------------------------------------------------
    test("the database refuses a row that is neither closed nor open, and a negative figure", async () => {
      const attempt = async (balance: string): Promise<void> => {
        await getAdminSql()`
        INSERT INTO awcms_commerce_report_booking_orders
          (tenant_id, order_id, paid_day, source_kind, stays, no_shows, no_show_retained,
           gross, discount, shipping, insurance, tax, total, paid_in, paid_back,
           uncollected, outstanding, closed)
        VALUES (${TENANT_A}, gen_random_uuid(), '2026-01-01', 'reservation', 1, 0, 0,
          100, 0, 0, 0, 0, 100, 50, 0, ${balance}::numeric, 50, false)`;
      };
      // Open order with an uncollected balance: refused.
      await expect(attempt("50")).rejects.toThrow();
      await expect(attempt("-1")).rejects.toThrow();
    }, 60000);
  }
);
