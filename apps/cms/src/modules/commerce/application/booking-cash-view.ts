/**
 * The CASH view of the booking slice's refunds - by the day the money went back
 * (Issue #478, metrics `docs/aw-business-platform-metrics.md` section 3.6 and
 * 3.9 D4; `GET /api/v1/reports/commerce/booking-revenue-cash`).
 *
 * The waterfall (`booking-revenue-report.ts`) is by the day an order was first
 * PAID and counts a refund when it is DECIDED, so it deliberately cannot answer
 * "how much cash left on Tuesday". This view can: it sums the succeeded
 * `reversal` legs of the payment ledger of the booking-sourced orders (an order
 * that carries a reservation link, or the supplementary order of a stay that grew
 * - the same provenance as the projection) by the Asia/Jakarta day each leg
 * SETTLED. It is labelled `basis: "cash"` in the payload and on the screen, and
 * the two views are never mixed in one chart (metrics 3.6).
 *
 * ## Why a live read and not a second projection
 *
 * Every figure here is one grouped read over an append-only ledger through the
 * `(tenant_id, settled_at)` index of sql/998, bounded to 366 days like the other
 * report ranges, and the ledger IS the source: there is no derivation to drift and
 * no restatement, so nothing needs to be stored (ADR-0040 D5.2: no second store).
 * A leg that fails or is still pending moved no money and is not here; it is the
 * "refund payable" companion of the waterfall until it settles.
 *
 * Aggregates only: no order id, customer, name, contact or provider reference.
 * While the tenant's `booking` feature is OFF the answer is `enabled: false` with
 * no days, as for the waterfall.
 */
import { BOOKING_REVENUE_TIME_ZONE } from "../domain/booking-revenue";
import { fromCents, toCents } from "../domain/price-calculation";
import type { SalesReportRange } from "../domain/sales-report-query";
import { fetchCommerceFeatures } from "./commerce-feature-gate";

export type BookingCashRefundDay = {
  /** `YYYY-MM-DD`, the Asia/Jakarta day the reversal legs settled. */
  day: string;
  /** Settled reversal legs of that day. */
  legs: number;
  /** Money that went back to customers that day, `numeric(14,2)`. */
  refundsPaidOut: string;
};

export type BookingCashRefundReport = {
  enabled: boolean;
  /** This view is cash: the day money moved, never the day an order was paid. */
  basis: "cash";
  timeZone: string;
  asOf: string;
  from: string;
  to: string;
  currency: string;
  days: BookingCashRefundDay[];
  totals: { legs: number; refundsPaidOut: string };
};

type CashRow = { day: string; legs: number; refunds_paid_out: string };

export async function fetchBookingCashRefundReport(
  tx: Bun.SQL,
  tenantId: string,
  range: SalesReportRange,
  now: Date = new Date()
): Promise<BookingCashRefundReport> {
  const envelope = {
    basis: "cash" as const,
    timeZone: BOOKING_REVENUE_TIME_ZONE,
    asOf: now.toISOString(),
    from: range.from,
    to: range.to,
    currency: "IDR"
  };
  if (!(await fetchCommerceFeatures(tx, tenantId)).booking) {
    return {
      ...envelope,
      enabled: false,
      days: [],
      totals: { legs: 0, refundsPaidOut: fromCents(0n) }
    };
  }

  // [from 00:00, to + 1 day 00:00) in Asia/Jakarta, as instants.
  const rows = (await tx`
    SELECT to_char((a.settled_at AT TIME ZONE ${BOOKING_REVENUE_TIME_ZONE})::date, 'YYYY-MM-DD') AS day,
      count(*)::int AS legs,
      sum(a.amount)::text AS refunds_paid_out
    FROM awcms_commerce_payment_allocations a
    WHERE a.tenant_id = ${tenantId}
      AND a.kind = 'reversal' AND a.status = 'succeeded'
      AND a.settled_at IS NOT NULL
      AND a.settled_at >= (${range.from}::date::timestamp AT TIME ZONE ${BOOKING_REVENUE_TIME_ZONE})
      AND a.settled_at < ((${range.to}::date + 1)::timestamp AT TIME ZONE ${BOOKING_REVENUE_TIME_ZONE})
      AND (
        EXISTS (
          SELECT 1 FROM awcms_commerce_booking_reservation_links l
          WHERE l.tenant_id = a.tenant_id AND l.order_id = a.order_id
        )
        OR EXISTS (
          SELECT 1 FROM awcms_commerce_booking_reschedules r
          WHERE r.tenant_id = a.tenant_id AND r.supplement_order_id = a.order_id
        )
      )
    GROUP BY 1
    ORDER BY 1 ASC
  `) as CashRow[];

  let legs = 0;
  let total = 0n;
  const days = rows.map((row) => {
    const cents = toCents(String(row.refunds_paid_out));
    legs += Number(row.legs);
    total += cents;
    return {
      day: row.day,
      legs: Number(row.legs),
      refundsPaidOut: fromCents(cents)
    };
  });
  return {
    ...envelope,
    enabled: true,
    days,
    totals: { legs, refundsPaidOut: fromCents(total) }
  };
}
