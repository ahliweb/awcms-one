/**
 * Read side of the booking-sourced revenue report (Issue #389, ADR-0045
 * amendment note; metrics spec sections 3, 3.7 and 8.2) - the
 * `GET /api/v1/reports/commerce/booking-revenue` route and the panel on
 * `admin/commerce-reports.astro` read the projection table through this
 * function and nothing else. It only READs `awcms_commerce_report_booking_*`
 * (maintained by `booking-revenue-projection.ts` under the `reporting` engine)
 * and returns aggregates only - never an order id, customer, name or contact.
 *
 * ## Feature gating
 *
 * While the tenant's `booking` feature is OFF (the default) the answer is
 * `enabled: false` with no days - not an error: the adapter is not in use, and
 * "nothing to show" is a state the screen hides. The projection keeps running,
 * so switching the feature on shows history immediately.
 *
 * ## Refunds on a decision basis (Issue #478, metrics 3.9)
 *
 * A refund counts when it is DECIDED, so the Refunds step reads the same on the
 * day a refund is recorded as on the day its money leaves; it has three parts that
 * always add up (paid back, refund payable, uncollected balance) and each is the
 * GOODS share of the money (tax collected is not revenue: the tax, shipping and
 * insurance shares lower their own companion columns). `refundPayableBalance` is
 * the money, all components, still to be paid out. The cash reading lives in the
 * by-refund-day view (`booking-cash-view.ts`), labelled as cash, and is never in
 * this waterfall.
 *
 * ## What a day is
 *
 * A day is the Asia/Jakarta calendar day of the booking order's FIRST paid
 * transition. The waterfall (gross, discounts, refunds, net), the companion
 * columns (shipping, insurance, tax, the balance still outstanding) and the
 * no-show figures of that day are sums of the orders paid that day - a later
 * refund, a no-show or a cancellation restates THAT day, never today (metrics
 * 1.1 rule 5). `restated` marks a day older than the 35-day window that a late
 * event changed.
 */
import {
  BOOKING_REVENUE_RESTATEMENT_WINDOW_DAYS,
  BOOKING_REVENUE_TIME_ZONE,
  addBookingRevenueDaySums,
  emptyBookingRevenueDaySums,
  shapeBookingRevenueFigures,
  type BookingRevenueDaySums,
  type BookingRevenueFigures
} from "../domain/booking-revenue";
import { toCents } from "../domain/price-calculation";
import type { SalesReportRange } from "../domain/sales-report-query";
import { fetchCommerceFeatures } from "./commerce-feature-gate";

export type BookingRevenueDay = BookingRevenueFigures & {
  /** `YYYY-MM-DD`, the Asia/Jakarta day of the orders' first paid transition. */
  day: string;
  /** A late event changed this day after its 35-day window closed (spec 1.2). */
  restated: boolean;
  restatedAt: string | null;
};

export type BookingRevenueReport = {
  enabled: boolean;
  /** What a day means here: the day of the order's first paid transition (attribution), never the day money moved. */
  basis: "paid_day";
  timeZone: string;
  restatementWindowDays: number;
  /** ISO instant the report was computed at. */
  asOf: string;
  from: string;
  to: string;
  currency: string;
  days: BookingRevenueDay[];
  /** The whole range, summed. */
  totals: BookingRevenueFigures;
};

type DayRow = {
  day: string;
  orders: number;
  stays: number;
  no_shows: number;
  no_show_retained: string;
  gross: string;
  discount: string;
  shipping: string;
  insurance: string;
  tax: string;
  goods_paid_back: string;
  goods_payable: string;
  goods_uncollected: string;
  shipping_refunded: string;
  insurance_refunded: string;
  tax_refunded: string;
  outstanding: string;
  refund_payable: string;
};

function sumsOf(row: DayRow): BookingRevenueDaySums {
  return {
    orders: Number(row.orders),
    stays: Number(row.stays),
    noShows: Number(row.no_shows),
    noShowRetainedCents: toCents(String(row.no_show_retained)),
    grossCents: toCents(String(row.gross)),
    discountCents: toCents(String(row.discount)),
    shippingCents: toCents(String(row.shipping)),
    insuranceCents: toCents(String(row.insurance)),
    taxCents: toCents(String(row.tax)),
    paidBackCents: toCents(String(row.goods_paid_back)),
    payableCents: toCents(String(row.goods_payable)),
    uncollectedCents: toCents(String(row.goods_uncollected)),
    shippingRefundedCents: toCents(String(row.shipping_refunded)),
    insuranceRefundedCents: toCents(String(row.insurance_refunded)),
    taxRefundedCents: toCents(String(row.tax_refunded)),
    outstandingCents: toCents(String(row.outstanding)),
    refundPayableCents: toCents(String(row.refund_payable))
  };
}

export async function fetchBookingRevenueReport(
  tx: Bun.SQL,
  tenantId: string,
  range: SalesReportRange,
  now: Date = new Date()
): Promise<BookingRevenueReport> {
  const envelope = {
    basis: "paid_day" as const,
    timeZone: BOOKING_REVENUE_TIME_ZONE,
    restatementWindowDays: BOOKING_REVENUE_RESTATEMENT_WINDOW_DAYS,
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
      totals: shapeBookingRevenueFigures(emptyBookingRevenueDaySums())
    };
  }

  const rows = (await tx`
    SELECT to_char(paid_day, 'YYYY-MM-DD') AS day,
      count(*)::int AS orders,
      COALESCE(sum(stays), 0)::int AS stays,
      COALESCE(sum(no_shows), 0)::int AS no_shows,
      COALESCE(sum(no_show_retained), 0)::text AS no_show_retained,
      COALESCE(sum(gross), 0)::text AS gross,
      COALESCE(sum(discount), 0)::text AS discount,
      COALESCE(sum(shipping), 0)::text AS shipping,
      COALESCE(sum(insurance), 0)::text AS insurance,
      COALESCE(sum(tax), 0)::text AS tax,
      COALESCE(sum(goods_paid_back), 0)::text AS goods_paid_back,
      COALESCE(sum(goods_payable), 0)::text AS goods_payable,
      COALESCE(sum(goods_uncollected), 0)::text AS goods_uncollected,
      COALESCE(sum(shipping_refunded), 0)::text AS shipping_refunded,
      COALESCE(sum(insurance_refunded), 0)::text AS insurance_refunded,
      COALESCE(sum(tax_refunded), 0)::text AS tax_refunded,
      COALESCE(sum(outstanding), 0)::text AS outstanding,
      COALESCE(sum(refund_payable), 0)::text AS refund_payable
    FROM awcms_commerce_report_booking_orders
    WHERE tenant_id = ${tenantId}
      AND paid_day >= ${range.from}::date AND paid_day <= ${range.to}::date
    GROUP BY paid_day
    ORDER BY paid_day ASC
  `) as DayRow[];

  const restated = (await tx`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, restated_at
    FROM awcms_commerce_report_booking_restated
    WHERE tenant_id = ${tenantId}
      AND day >= ${range.from}::date AND day <= ${range.to}::date
  `) as { day: string; restated_at: Date | string }[];
  const restatedAt = new Map(
    restated.map((row) => [
      row.day,
      row.restated_at instanceof Date
        ? row.restated_at
        : new Date(row.restated_at)
    ])
  );

  const totals = emptyBookingRevenueDaySums();
  const days: BookingRevenueDay[] = rows.map((row) => {
    const sums = sumsOf(row);
    addBookingRevenueDaySums(totals, sums);
    const at = restatedAt.get(row.day) ?? null;
    return {
      day: row.day,
      ...shapeBookingRevenueFigures(sums),
      restated: at !== null,
      restatedAt: at === null ? null : at.toISOString()
    };
  });

  return {
    ...envelope,
    enabled: true,
    days,
    totals: shapeBookingRevenueFigures(totals)
  };
}
