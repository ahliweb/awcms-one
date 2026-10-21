/**
 * Booking-sourced revenue projection sinks and hooks - Issue #389, ADR-0045
 * (amendment note), spec `docs/aw-business-platform-metrics.md` sections 3, 3.7
 * and 8. The DB half of the `commerce.booking_revenue` `cursor_table` projection
 * that `application/booking-report-projections.ts` contributes to the
 * `reporting` engine (through `commerce/module.ts`'s `reportingProjections`):
 * every function takes the ENGINE's transaction (`tx`) and is called by the
 * engine's incremental worker, rebuild, reconciliation and export at the points
 * `ProjectionDimensionalSink`/`ProjectionDimensionalContract` define. Like
 * `retention-projection.ts` it imports no pool and no `withTenant`.
 *
 * ## What a batch is, and why this sink RECOMPUTES
 *
 * Four append-only (or write-once) streams feed it: the order-event log (a
 * transition into `paid`, a cancellation, a return), the payment ledger's
 * settled legs (a balance paid after the deposit, a refund paid back), the
 * booking refund decisions (a cancellation or a no-show) and the reschedule
 * record (the supplementary order of a stay that grew). None of them is a
 * delta of the waterfall by itself - "uncollected balance" appears when a
 * DECISION closes an order, "paid back" when a LEG settles, "gross" when the
 * order is paid - so the sink never applies a delta. For the booking-sourced
 * orders a batch touched it re-reads the order's CURRENT facts, runs the pure
 * {@link deriveBookingOrderRow} and writes the order's row (or deletes it when
 * the order never reached paid). Recomputing from current state is idempotent
 * and order-independent: a rebuild replays the same streams and ends on exactly
 * the rows the live pass holds, a crash-and-retry of a pass re-derives the same
 * rows, and a late refund restates the ORIGINAL paid day by construction (the
 * row's day is the order's `paid_at`, which never moves).
 *
 * ## No second store
 *
 * The row table is a `commerce` projection table the `reporting` engine
 * maintains through the descriptor, like the sales and retention tables. The
 * hold pipeline is NOT stored (it is a current state read live, see
 * `booking-pipeline.ts`).
 *
 * ## Restatement
 *
 * On the live path (never during a rebuild run - the same reasoning as
 * `sql/1020`) a recompute that changes the waterfall of a day whose 35-day
 * window has closed writes `awcms_commerce_report_booking_restated`.
 */
import {
  BOOKING_REVENUE_CONTROL_KEYS,
  BOOKING_REVENUE_PROJECTION_KEY,
  accumulateBookingRevenueControlTotals,
  deriveBookingOrderRow,
  emptyBookingRevenueControlTotals,
  restatedBookingDays,
  type BookingOrderRow
} from "../domain/booking-revenue";
import { toCents } from "../domain/price-calculation";
import type {
  ProjectionDimensionalContract,
  ProjectionDimensionalSink
} from "../../_shared/module-contract";
import { loadBookingOrderFacts } from "./booking-report-facts";

/** Columns the order-event stream asks the engine to SELECT beyond the cursor. */
export const BOOKING_REVENUE_EVENT_SELECT_COLUMNS = ["id", "order_id"] as const;
/** Columns the settled-leg stream asks the engine to SELECT beyond the cursor. */
export const BOOKING_REVENUE_LEG_SELECT_COLUMNS = [
  "id",
  "order_id",
  "status"
] as const;
/** Columns the refund-decision stream asks the engine to SELECT beyond the cursor. */
export const BOOKING_REVENUE_DECISION_SELECT_COLUMNS = [
  "id",
  "order_id"
] as const;
/** Columns the reschedule stream asks the engine to SELECT beyond the cursor. */
export const BOOKING_REVENUE_RESCHEDULE_SELECT_COLUMNS = [
  "id",
  "order_id",
  "supplement_order_id"
] as const;

/**
 * The order ids a batch can change a row of. A leg row that did not succeed
 * (a failed gateway leg) moved no money and is skipped; everything else names
 * an order, and the loader drops the orders that are not booking-sourced.
 */
export function bookingRevenueOrderIds(
  rows: readonly Record<string, unknown>[]
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.status === "string" && row.status !== "succeeded") continue;
    for (const key of ["order_id", "supplement_order_id"] as const) {
      const value = row[key];
      if (typeof value === "string" && value.length > 0) ids.add(value);
    }
  }
  return [...ids].sort();
}

type StoredRow = {
  order_id: string;
  paid_day: string;
  source_kind: string;
  stays: number;
  no_shows: number;
  no_show_retained: string;
  gross: string;
  discount: string;
  shipping: string;
  insurance: string;
  tax: string;
  total: string;
  paid_in: string;
  paid_back: string;
  uncollected: string;
  outstanding: string;
  closed: boolean;
};

function storedToRow(row: StoredRow): BookingOrderRow {
  return {
    paidDay: row.paid_day,
    sourceKind: row.source_kind === "supplement" ? "supplement" : "reservation",
    stays: Number(row.stays),
    noShows: Number(row.no_shows),
    noShowRetainedCents: toCents(String(row.no_show_retained)),
    grossCents: toCents(String(row.gross)),
    discountCents: toCents(String(row.discount)),
    shippingCents: toCents(String(row.shipping)),
    insuranceCents: toCents(String(row.insurance)),
    taxCents: toCents(String(row.tax)),
    totalCents: toCents(String(row.total)),
    paidInCents: toCents(String(row.paid_in)),
    paidBackCents: toCents(String(row.paid_back)),
    uncollectedCents: toCents(String(row.uncollected)),
    outstandingCents: toCents(String(row.outstanding)),
    closed: Boolean(row.closed)
  };
}

async function loadStoredRows(
  tx: Bun.SQL,
  tenantId: string,
  orderIds: readonly string[]
): Promise<Map<string, BookingOrderRow>> {
  const stored = new Map<string, BookingOrderRow>();
  if (orderIds.length === 0) return stored;
  const rows = (await tx`
    SELECT order_id, to_char(paid_day, 'YYYY-MM-DD') AS paid_day, source_kind,
      stays, no_shows, no_show_retained, gross, discount, shipping, insurance,
      tax, total, paid_in, paid_back, uncollected, outstanding, closed
    FROM awcms_commerce_report_booking_orders
    WHERE tenant_id = ${tenantId}
      AND order_id = ANY(${tx.array([...orderIds], "uuid")}::uuid[])
  `) as StoredRow[];
  for (const row of rows) stored.set(row.order_id, storedToRow(row));
  return stored;
}

async function isRebuildRunning(
  tx: Bun.SQL,
  tenantId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT 1 AS running
    FROM awcms_reporting_rebuild_runs
    WHERE tenant_id = ${tenantId}
      AND projection_key = ${BOOKING_REVENUE_PROJECTION_KEY}
      AND status = 'running'
    LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

async function recordRestatement(
  tx: Bun.SQL,
  tenantId: string,
  day: string
): Promise<void> {
  await tx`
    INSERT INTO awcms_commerce_report_booking_restated
      (tenant_id, day, restated_at)
    VALUES (${tenantId}, ${day}::date, now())
    ON CONFLICT (tenant_id, day) DO UPDATE SET
      restated_at = EXCLUDED.restated_at
  `;
}

const cents = (value: bigint): string => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
};

/**
 * Recomputes the row of every booking-sourced order among `orderIds`. Exported
 * for the integration tests; the engine only ever reaches it through the sinks.
 */
export async function recomputeBookingRevenueRows(
  tx: Bun.SQL,
  tenantId: string,
  orderIds: readonly string[]
): Promise<void> {
  if (orderIds.length === 0) return;
  const facts = await loadBookingOrderFacts(tx, tenantId, orderIds);
  if (facts.size === 0) return;
  const ids = [...facts.keys()].sort();
  const previous = await loadStoredRows(tx, tenantId, ids);
  const live = !(await isRebuildRunning(tx, tenantId));
  const clock = (await tx`SELECT now() AS now`) as { now: Date | string }[];
  const now =
    clock[0]!.now instanceof Date
      ? clock[0]!.now
      : new Date(clock[0]!.now as string);

  for (const orderId of ids) {
    const next = deriveBookingOrderRow(facts.get(orderId)!);
    const before = previous.get(orderId) ?? null;
    if (next === null) {
      if (before !== null) {
        await tx`
          DELETE FROM awcms_commerce_report_booking_orders
          WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
        `;
      }
    } else {
      await tx`
        INSERT INTO awcms_commerce_report_booking_orders (
          tenant_id, order_id, paid_day, source_kind, stays, no_shows,
          no_show_retained, gross, discount, shipping, insurance, tax, total,
          paid_in, paid_back, uncollected, outstanding, closed
        )
        VALUES (
          ${tenantId}, ${orderId}, ${next.paidDay}::date, ${next.sourceKind},
          ${next.stays}, ${next.noShows}, ${cents(next.noShowRetainedCents)}::numeric,
          ${cents(next.grossCents)}::numeric, ${cents(next.discountCents)}::numeric,
          ${cents(next.shippingCents)}::numeric, ${cents(next.insuranceCents)}::numeric,
          ${cents(next.taxCents)}::numeric, ${cents(next.totalCents)}::numeric,
          ${cents(next.paidInCents)}::numeric, ${cents(next.paidBackCents)}::numeric,
          ${cents(next.uncollectedCents)}::numeric, ${cents(next.outstandingCents)}::numeric,
          ${next.closed}
        )
        ON CONFLICT (tenant_id, order_id) DO UPDATE SET
          paid_day = EXCLUDED.paid_day,
          source_kind = EXCLUDED.source_kind,
          stays = EXCLUDED.stays,
          no_shows = EXCLUDED.no_shows,
          no_show_retained = EXCLUDED.no_show_retained,
          gross = EXCLUDED.gross,
          discount = EXCLUDED.discount,
          shipping = EXCLUDED.shipping,
          insurance = EXCLUDED.insurance,
          tax = EXCLUDED.tax,
          total = EXCLUDED.total,
          paid_in = EXCLUDED.paid_in,
          paid_back = EXCLUDED.paid_back,
          uncollected = EXCLUDED.uncollected,
          outstanding = EXCLUDED.outstanding,
          closed = EXCLUDED.closed,
          updated_at = now()
      `;
    }
    if (live) {
      for (const day of restatedBookingDays(before, next, now)) {
        await recordRestatement(tx, tenantId, day);
      }
    }
  }
}

export async function applyBookingRevenueBatch(
  tx: Bun.SQL,
  tenantId: string,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  await recomputeBookingRevenueRows(tx, tenantId, bookingRevenueOrderIds(rows));
}

export const BOOKING_REVENUE_EVENT_SINK: ProjectionDimensionalSink = {
  selectColumns: BOOKING_REVENUE_EVENT_SELECT_COLUMNS,
  applyBatch: applyBookingRevenueBatch
};

export const BOOKING_REVENUE_LEG_SINK: ProjectionDimensionalSink = {
  selectColumns: BOOKING_REVENUE_LEG_SELECT_COLUMNS,
  applyBatch: applyBookingRevenueBatch
};

export const BOOKING_REVENUE_DECISION_SINK: ProjectionDimensionalSink = {
  selectColumns: BOOKING_REVENUE_DECISION_SELECT_COLUMNS,
  applyBatch: applyBookingRevenueBatch
};

export const BOOKING_REVENUE_RESCHEDULE_SINK: ProjectionDimensionalSink = {
  selectColumns: BOOKING_REVENUE_RESCHEDULE_SELECT_COLUMNS,
  applyBatch: applyBookingRevenueBatch
};

// ---------------------------------------------------------------------------
// Control totals (reconciliation)
// ---------------------------------------------------------------------------

/** Orders per page of the reconciliation's full source walk. */
const CONTROL_TOTAL_PAGE_SIZE = 1000;

/**
 * Walks every booking-sourced order (keyset by id, paged) and sums the output
 * of the same {@link deriveBookingOrderRow} the sink applies - the
 * reconciliation's source control total. Read-only; unbounded by design like the
 * engine's own `COUNT(*)` totals; runs in the reconcile route's own transaction.
 */
export async function computeBookingRevenueSourceTotals(
  tx: Bun.SQL,
  tenantId: string
) {
  const totals = emptyBookingRevenueControlTotals();
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const page = (await tx`
      SELECT order_id FROM (
        SELECT order_id FROM awcms_commerce_booking_reservation_links
        WHERE tenant_id = ${tenantId}
        UNION
        SELECT supplement_order_id AS order_id
        FROM awcms_commerce_booking_reschedules
        WHERE tenant_id = ${tenantId} AND supplement_order_id IS NOT NULL
      ) sourced
      WHERE order_id > ${after}::uuid
      ORDER BY order_id ASC
      LIMIT ${CONTROL_TOTAL_PAGE_SIZE}
    `) as { order_id: string }[];
    if (page.length === 0) break;
    const ids = page.map((row) => row.order_id);
    const facts = await loadBookingOrderFacts(tx, tenantId, ids);
    for (const id of ids) {
      const fact = facts.get(id);
      if (!fact) continue;
      const row = deriveBookingOrderRow(fact);
      if (row !== null) accumulateBookingRevenueControlTotals(totals, row);
    }
    after = ids[ids.length - 1]!;
    if (page.length < CONTROL_TOTAL_PAGE_SIZE) break;
  }
  return totals;
}

function controlRecord(totals: {
  orders: number;
  stays: number;
  noShows: number;
  grossCents: bigint;
  discountCents: bigint;
  paidBackCents: bigint;
  uncollectedCents: bigint;
  outstandingCents: bigint;
  settledCents: bigint;
}) {
  return {
    [BOOKING_REVENUE_CONTROL_KEYS.orders]: totals.orders,
    [BOOKING_REVENUE_CONTROL_KEYS.stays]: totals.stays,
    [BOOKING_REVENUE_CONTROL_KEYS.noShows]: totals.noShows,
    [BOOKING_REVENUE_CONTROL_KEYS.grossCents]: Number(totals.grossCents),
    [BOOKING_REVENUE_CONTROL_KEYS.discountCents]: Number(totals.discountCents),
    [BOOKING_REVENUE_CONTROL_KEYS.paidBackCents]: Number(totals.paidBackCents),
    [BOOKING_REVENUE_CONTROL_KEYS.uncollectedCents]: Number(
      totals.uncollectedCents
    ),
    [BOOKING_REVENUE_CONTROL_KEYS.outstandingCents]: Number(
      totals.outstandingCents
    ),
    [BOOKING_REVENUE_CONTROL_KEYS.settledCents]: Number(totals.settledCents)
  };
}

export const BOOKING_REVENUE_DIMENSIONAL: ProjectionDimensionalContract = {
  resetForTenant: async (tx, tenantId) => {
    // The restatement log is evidence of WHEN a day changed, not a derivation,
    // so a rebuild leaves it alone (like sql/1020's retention log).
    await tx`DELETE FROM awcms_commerce_report_booking_orders WHERE tenant_id = ${tenantId}`;
  },
  readProjectionTotals: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT count(*)::int AS orders,
        COALESCE(sum(stays), 0)::int AS stays,
        COALESCE(sum(no_shows), 0)::int AS no_shows,
        (COALESCE(sum(gross), 0) * 100)::bigint::text AS gross_cents,
        (COALESCE(sum(discount), 0) * 100)::bigint::text AS discount_cents,
        (COALESCE(sum(paid_back), 0) * 100)::bigint::text AS paid_back_cents,
        (COALESCE(sum(uncollected), 0) * 100)::bigint::text AS uncollected_cents,
        (COALESCE(sum(outstanding), 0) * 100)::bigint::text AS outstanding_cents,
        (COALESCE(sum(paid_in - paid_back), 0) * 100)::bigint::text AS settled_cents
      FROM awcms_commerce_report_booking_orders
      WHERE tenant_id = ${tenantId}
    `) as Record<string, unknown>[];
    const row = rows[0] ?? {};
    return controlRecord({
      orders: Number(row.orders ?? 0),
      stays: Number(row.stays ?? 0),
      noShows: Number(row.no_shows ?? 0),
      grossCents: BigInt(String(row.gross_cents ?? "0")),
      discountCents: BigInt(String(row.discount_cents ?? "0")),
      paidBackCents: BigInt(String(row.paid_back_cents ?? "0")),
      uncollectedCents: BigInt(String(row.uncollected_cents ?? "0")),
      outstandingCents: BigInt(String(row.outstanding_cents ?? "0")),
      settledCents: BigInt(String(row.settled_cents ?? "0"))
    });
  },
  computeSourceTotals: async (tx, tenantId) =>
    controlRecord(await computeBookingRevenueSourceTotals(tx, tenantId)),
  // The waterfall per paid day; aggregates only - no order id, no customer.
  // Money is cast to text: Bun.SQL hands a zero numeric back as the number 0.
  exportRows: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT to_char(paid_day, 'YYYY-MM-DD') AS day,
        count(*)::int AS orders,
        sum(gross)::text AS gross,
        sum(discount)::text AS discounts,
        sum(paid_back)::text AS refunds_paid_back,
        sum(uncollected)::text AS refunds_uncollected,
        sum(gross - discount - paid_back - uncollected)::text AS net,
        sum(shipping)::text AS shipping,
        sum(insurance)::text AS insurance,
        sum(tax)::text AS tax,
        sum(outstanding)::text AS balance_outstanding,
        sum(stays)::int AS stays,
        sum(no_shows)::int AS no_shows,
        sum(no_show_retained)::text AS no_show_retained
      FROM awcms_commerce_report_booking_orders
      WHERE tenant_id = ${tenantId}
      GROUP BY paid_day
      ORDER BY paid_day ASC
    `) as Record<string, unknown>[];
    return {
      columns: [
        "day",
        "orders",
        "gross",
        "discounts",
        "refunds_paid_back",
        "refunds_uncollected",
        "net",
        "shipping",
        "insurance",
        "tax",
        "balance_outstanding",
        "stays",
        "no_shows",
        "no_show_retained"
      ],
      rows
    };
  }
};
