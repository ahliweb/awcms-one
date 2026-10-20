/**
 * Booking-sourced revenue rules - Issue #389, ADR-0045 (amendment note), spec
 * `docs/aw-business-platform-metrics.md` sections 3 (and 3.7), 8.2 and 8.3.
 * PURE: no database, no I/O, no clock (every function that needs "now" takes
 * it). The `commerce.booking_revenue` reporting projection, its reconciliation
 * control totals and its read route all run THESE functions, which is what
 * makes "rebuild equals live" a property of the code and not a hope.
 *
 * ## The contract in one paragraph
 *
 * Revenue follows the commerce ORDER and the PAYMENT LEDGER only (metrics Q6,
 * section 3.7); a booking status never creates revenue. The booking-sourced
 * slice is the paid orders that carry a reservation link (plus the
 * supplementary order a reschedule that added nights created). Per order:
 *
 *   * Gross is recognised ONCE, on the Asia/Jakarta day of the order's first
 *     paid transition (`paid_at`) - for a deposit order that is the deposit
 *     day - for the whole value of the goods and services (`subtotal`). The
 *     balance paid later changes nothing in the waterfall.
 *   * Discounts are every reduction applied before payment (voucher, points):
 *     what the order recorded as a price reduction, derived so the control
 *     identity below holds exactly. A per-line price cut is already inside the
 *     line price the order froze and is not a discount here (the order keeps
 *     no list price).
 *   * Refunds have two parts that always add up to the step: the money that
 *     actually went BACK ("paid back" - the ledger's succeeded reversal legs)
 *     and the "uncollected balance (no money moved)" - the unpaid part of an
 *     order that will now never be collected. Both land on the ORIGINAL paid
 *     day (metrics 1.1 rule 5), not on the day of the cancellation.
 *   * Net = gross - discounts - refunds. A retained deposit is ordinary
 *     settled revenue and stays in net.
 *   * Shipping, insurance and tax are three companion columns, not part of the
 *     waterfall; the unpaid balance of an order still open is a fourth, so
 *     deposit-day gross is never read as cash received.
 *
 * ## The order is "closed" when nothing more will be collected
 *
 * A booking that was cancelled (a cancellation refund decision exists) or marked
 * no-show (a no-show decision exists), or an order that was itself cancelled,
 * is closed: its unpaid balance (`total - paid in`) leaves as "uncollected" on
 * the original day and the outstanding balance is zero. Any other order keeps
 * its balance outstanding. "Paid in" is the sum of the succeeded PAYMENT legs
 * (money that came in, whatever went back afterwards), so the uncollected part
 * does not move when a refund is paid later.
 *
 * ## The control identity (metrics 3.5)
 *
 *   net + shipping + insurance + tax = settled + balance outstanding - surplus
 *
 * where `settled = paid in - paid back` and `surplus` is money held above the
 * total (a liability, not revenue). It holds per order BY CONSTRUCTION of
 * {@link deriveBookingOrderRow} and is the reconciliation's required control
 * total (`bookingRevenueIdentityHolds`). A refund is money, so a full refund of
 * an order that carried tax leaves the tax companion un-netted and the net
 * below zero by that amount - the identity, not the optics, is the contract.
 *
 * ## No-show
 *
 * The no-show decision (`trigger_kind = 'no_show'`, `retained_amount`) is
 * joined through its ORDER and so lands on the order's paid day like every
 * other compensating fact. The rate is no-shows divided by stays (the
 * non-superseded reservation links of the paid orders of that day: a
 * replacement reservation counts once).
 *
 * ## Hold pipeline
 *
 * Not a projection: a hold is a CURRENT state (an active reservation link on an
 * order still waiting for its first payment), so it is a live, tenant-scoped,
 * read-only query (`application/booking-pipeline.ts`); {@link shapeHoldPipeline}
 * is its pure shaping.
 */
import { fromCents, toCents } from "./price-calculation";
import { resolveSalesReportDay } from "./sales-report-deltas";

export { SALES_REPORT_TIME_ZONE as BOOKING_REVENUE_TIME_ZONE } from "./sales-report-deltas";

export const BOOKING_REVENUE_PROJECTION_KEY = "commerce.booking_revenue";

/** Stream keys: cursors are per (tenant, projection, stream). */
export const BOOKING_REVENUE_STREAM_KEYS = {
  orderEvents: "order_events",
  paymentLegs: "payment_legs",
  refundDecisions: "refund_decisions",
  reschedules: "reschedules"
} as const;

export const BOOKING_REVENUE_METRIC_KEYS = {
  orderEvents: "booking_order_events",
  paymentLegs: "booking_payment_legs",
  refundDecisions: "booking_refund_decisions",
  reschedules: "booking_reschedules"
} as const;

/** Reconciliation keys of the dimensional control totals (integers: counts, or money in cents). */
export const BOOKING_REVENUE_CONTROL_KEYS = {
  orders: "booking_orders",
  stays: "booking_stays",
  noShows: "booking_no_shows",
  grossCents: "booking_gross_cents",
  discountCents: "booking_discount_cents",
  paidBackCents: "booking_paid_back_cents",
  uncollectedCents: "booking_uncollected_cents",
  outstandingCents: "booking_outstanding_cents",
  settledCents: "booking_settled_cents"
} as const;

/** Owner-accepted restatement window (spec 1.2, Q1): a day older than this that a late event changed is flagged. */
export const BOOKING_REVENUE_RESTATEMENT_WINDOW_DAYS = 35;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `Asia/Jakarta` is UTC+7 all year. */
const JAKARTA_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

/** How many days one read may span (the sales reports' bound). */
export const BOOKING_REVENUE_MAX_RANGE_DAYS = 366;

// ---------------------------------------------------------------------------
// Per-order derivation
// ---------------------------------------------------------------------------

/** Where an order's booking provenance comes from. */
export type BookingSourceKind = "reservation" | "supplement";

/** The CURRENT facts of one booking-sourced order. Money is `numeric(14,2)` strings (the order's own) or integer cents (ledger sums). */
export type BookingOrderFacts = {
  orderId: string;
  sourceKind: BookingSourceKind;
  /** The order's first paid transition; `null` = never reached paid (no row). */
  paidAt: Date | null;
  status: string;
  subtotal: string;
  shippingCost: string;
  insuranceFee: string;
  tax: string;
  total: string;
  /** Sum of the succeeded `payment` legs of the ledger. */
  paidInCents: bigint;
  /** Sum of the succeeded `reversal` legs of the ledger. */
  paidBackCents: bigint;
  /** Reservation links of the order that are not `superseded` (a reschedule's replacement counts once); `0` for a supplementary order. */
  stays: number;
  /** No-show refund decisions of the order's links. */
  noShows: number;
  /** What the no-show decisions retained, in cents. */
  noShowRetainedCents: bigint;
  /** Cancellation refund decisions (customer or staff) of the order's links. */
  cancellations: number;
};

/** The derived, stored row of one order. */
export type BookingOrderRow = {
  /** `YYYY-MM-DD`, the Asia/Jakarta day of the first paid transition. */
  paidDay: string;
  sourceKind: BookingSourceKind;
  stays: number;
  noShows: number;
  noShowRetainedCents: bigint;
  grossCents: bigint;
  discountCents: bigint;
  shippingCents: bigint;
  insuranceCents: bigint;
  taxCents: bigint;
  totalCents: bigint;
  paidInCents: bigint;
  paidBackCents: bigint;
  /** The unpaid balance of a closed order: left the order on the original day, no money moved. */
  uncollectedCents: bigint;
  /** The unpaid balance of an order still open. */
  outstandingCents: bigint;
  closed: boolean;
};

const max0 = (value: bigint): bigint => (value < 0n ? 0n : value);

/** `true` once nothing more will be collected on the order. */
export function isBookingOrderClosed(
  facts: Pick<BookingOrderFacts, "status" | "cancellations" | "noShows">
): boolean {
  return (
    facts.status === "cancelled" || facts.cancellations > 0 || facts.noShows > 0
  );
}

/**
 * Derives one order's row from its CURRENT facts - the only way the sink ever
 * writes a row (a recompute, never an increment). `null` when the order never
 * reached paid (no revenue; the row is deleted if one existed).
 */
export function deriveBookingOrderRow(
  facts: BookingOrderFacts
): BookingOrderRow | null {
  if (facts.paidAt === null) return null;
  const grossCents = toCents(facts.subtotal);
  const shippingCents = toCents(facts.shippingCost);
  const insuranceCents = toCents(facts.insuranceFee);
  const taxCents = toCents(facts.tax);
  const totalCents = toCents(facts.total);
  // What the order recorded as a price reduction before payment, derived from
  // the order's own identity (total = subtotal - discounts + shipping +
  // insurance + tax) so the control identity of the file header is exact.
  const discountCents = max0(
    grossCents + shippingCents + insuranceCents + taxCents - totalCents
  );
  const closed = isBookingOrderClosed(facts);
  const unpaid = max0(totalCents - facts.paidInCents);
  return {
    paidDay: resolveSalesReportDay(facts.paidAt),
    sourceKind: facts.sourceKind,
    stays: facts.stays,
    noShows: facts.noShows,
    noShowRetainedCents: facts.noShowRetainedCents,
    grossCents,
    discountCents,
    shippingCents,
    insuranceCents,
    taxCents,
    totalCents,
    paidInCents: facts.paidInCents,
    paidBackCents: facts.paidBackCents,
    uncollectedCents: closed ? unpaid : 0n,
    outstandingCents: closed ? 0n : unpaid,
    closed
  };
}

/** Net revenue of one order: gross - discounts - (paid back + uncollected). */
export function bookingOrderNetCents(row: BookingOrderRow): bigint {
  return (
    row.grossCents -
    row.discountCents -
    row.paidBackCents -
    row.uncollectedCents
  );
}

/**
 * The metrics 3.5 control identity for one row:
 *
 *   net + shipping + insurance + tax = settled + balance outstanding - surplus
 *
 * with `settled = paid in - paid back` and `surplus = max(0, paid in - total)`
 * (money held above the total is a liability, not revenue). It is the
 * reconciliation's required control total: `customer_paid` of an order with no
 * returns reads `net + companions`, and a refund lowers both sides alike.
 */
export function bookingRevenueIdentityHolds(row: BookingOrderRow): boolean {
  const surplus = max0(row.paidInCents - row.totalCents);
  const left =
    bookingOrderNetCents(row) +
    row.shippingCents +
    row.insuranceCents +
    row.taxCents;
  const right =
    row.paidInCents - row.paidBackCents + row.outstandingCents - surplus;
  return left === right;
}

// ---------------------------------------------------------------------------
// Control totals
// ---------------------------------------------------------------------------

export type BookingRevenueControlTotals = {
  orders: number;
  stays: number;
  noShows: number;
  grossCents: bigint;
  discountCents: bigint;
  paidBackCents: bigint;
  uncollectedCents: bigint;
  outstandingCents: bigint;
  settledCents: bigint;
};

export function emptyBookingRevenueControlTotals(): BookingRevenueControlTotals {
  return {
    orders: 0,
    stays: 0,
    noShows: 0,
    grossCents: 0n,
    discountCents: 0n,
    paidBackCents: 0n,
    uncollectedCents: 0n,
    outstandingCents: 0n,
    settledCents: 0n
  };
}

export function accumulateBookingRevenueControlTotals(
  totals: BookingRevenueControlTotals,
  row: BookingOrderRow
): void {
  totals.orders += 1;
  totals.stays += row.stays;
  totals.noShows += row.noShows;
  totals.grossCents += row.grossCents;
  totals.discountCents += row.discountCents;
  totals.paidBackCents += row.paidBackCents;
  totals.uncollectedCents += row.uncollectedCents;
  totals.outstandingCents += row.outstandingCents;
  totals.settledCents += row.paidInCents - row.paidBackCents;
}

// ---------------------------------------------------------------------------
// Restatement (spec 1.2)
// ---------------------------------------------------------------------------

/** The instant after which a change to `day` is a restatement: the day's end plus 35 days. */
export function bookingDayRestatementThreshold(day: string): Date {
  const [year, month, date] = day.split("-").map(Number) as [
    number,
    number,
    number
  ];
  const endOfDay = Date.UTC(year, month - 1, date + 1) - JAKARTA_UTC_OFFSET_MS;
  return new Date(endOfDay + BOOKING_REVENUE_RESTATEMENT_WINDOW_DAYS * DAY_MS);
}

/** The figures a late event can change on a day that is already closed. */
function waterfallFingerprint(row: BookingOrderRow | null): string {
  if (row === null) return "none";
  return [
    row.grossCents,
    row.discountCents,
    row.paidBackCents,
    row.uncollectedCents,
    row.noShows,
    row.stays
  ].join("|");
}

/**
 * Which paid days a recompute restated, given the order's previous row (`null`
 * = none) and the new one, at `now`. A day is restated when a figure of the
 * waterfall (or a stay / no-show count) changed AFTER the day's restatement
 * window closed. The order's FIRST appearance on a day whose window is already
 * closed is a backdated fact and restates it too; a balance paid later moves
 * only the outstanding companion and the cash view, never the waterfall, and is
 * not a restatement.
 */
export function restatedBookingDays(
  previous: BookingOrderRow | null,
  next: BookingOrderRow | null,
  now: Date
): string[] {
  if (waterfallFingerprint(previous) === waterfallFingerprint(next)) return [];
  const days = new Set<string>();
  for (const row of [previous, next]) {
    if (
      row !== null &&
      now.getTime() >= bookingDayRestatementThreshold(row.paidDay).getTime()
    ) {
      days.add(row.paidDay);
    }
  }
  return [...days].sort();
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

/** Summed projection rows of one day (or of the whole range), in integer cents. */
export type BookingRevenueDaySums = {
  orders: number;
  stays: number;
  noShows: number;
  noShowRetainedCents: bigint;
  grossCents: bigint;
  discountCents: bigint;
  shippingCents: bigint;
  insuranceCents: bigint;
  taxCents: bigint;
  paidBackCents: bigint;
  uncollectedCents: bigint;
  outstandingCents: bigint;
};

export function emptyBookingRevenueDaySums(): BookingRevenueDaySums {
  return {
    orders: 0,
    stays: 0,
    noShows: 0,
    noShowRetainedCents: 0n,
    grossCents: 0n,
    discountCents: 0n,
    shippingCents: 0n,
    insuranceCents: 0n,
    taxCents: 0n,
    paidBackCents: 0n,
    uncollectedCents: 0n,
    outstandingCents: 0n
  };
}

export type BookingRevenueFigures = {
  orders: number;
  stays: number;
  /** Money, `numeric(14,2)` strings. */
  gross: string;
  discounts: string;
  refunds: string;
  /** Refunds, part one: the money that actually went back to the customer. */
  refundsPaidBack: string;
  /** Refunds, part two: "of which uncollected balance (no money moved)". */
  refundsUncollected: string;
  net: string;
  shipping: string;
  insurance: string;
  tax: string;
  /** The unpaid balance of orders still open, shown beside the waterfall (spec 3.7 rule 2). */
  balanceOutstanding: string;
  noShows: number;
  noShowRetained: string;
  /** No-shows / stays, one decimal, round-half-up; `null` with no stays. */
  noShowRatePercent: string | null;
  /** discounts / gross; `null` when gross is zero (spec 3.3). */
  discountRatePercent: string | null;
  /** refunds / gross; `null` when gross is zero (spec 3.3). */
  refundRatePercent: string | null;
};

/** `part / whole` as a one-decimal percentage string, round-half-up on integers (no float); `null` for a zero whole. */
export function formatRatePercent(part: bigint, whole: bigint): string | null {
  if (whole <= 0n) return null;
  const tenths = (part * 2000n + whole) / (whole * 2n);
  return `${tenths / 10n}.${tenths % 10n}`;
}

export function shapeBookingRevenueFigures(
  sums: BookingRevenueDaySums
): BookingRevenueFigures {
  const refundsCents = sums.paidBackCents + sums.uncollectedCents;
  const netCents = sums.grossCents - sums.discountCents - refundsCents;
  return {
    orders: sums.orders,
    stays: sums.stays,
    gross: fromSignedCents(sums.grossCents),
    discounts: fromSignedCents(sums.discountCents),
    refunds: fromSignedCents(refundsCents),
    refundsPaidBack: fromSignedCents(sums.paidBackCents),
    refundsUncollected: fromSignedCents(sums.uncollectedCents),
    net: fromSignedCents(netCents),
    shipping: fromSignedCents(sums.shippingCents),
    insurance: fromSignedCents(sums.insuranceCents),
    tax: fromSignedCents(sums.taxCents),
    balanceOutstanding: fromSignedCents(sums.outstandingCents),
    noShows: sums.noShows,
    noShowRetained: fromSignedCents(sums.noShowRetainedCents),
    noShowRatePercent: formatRatePercent(
      BigInt(sums.noShows),
      BigInt(sums.stays)
    ),
    discountRatePercent: formatRatePercent(sums.discountCents, sums.grossCents),
    refundRatePercent: formatRatePercent(refundsCents, sums.grossCents)
  };
}

/** `fromCents` is unsigned by contract; a net can be negative (see the file header). */
export function fromSignedCents(cents: bigint): string {
  return cents < 0n ? `-${fromCents(-cents)}` : fromCents(cents);
}

export function addBookingRevenueDaySums(
  into: BookingRevenueDaySums,
  add: BookingRevenueDaySums
): BookingRevenueDaySums {
  into.orders += add.orders;
  into.stays += add.stays;
  into.noShows += add.noShows;
  into.noShowRetainedCents += add.noShowRetainedCents;
  into.grossCents += add.grossCents;
  into.discountCents += add.discountCents;
  into.shippingCents += add.shippingCents;
  into.insuranceCents += add.insuranceCents;
  into.taxCents += add.taxCents;
  into.paidBackCents += add.paidBackCents;
  into.uncollectedCents += add.uncollectedCents;
  into.outstandingCents += add.outstandingCents;
  return into;
}

// ---------------------------------------------------------------------------
// Hospitality ratios that need Booking's nights (metrics 8.2 / 8.3)
// ---------------------------------------------------------------------------

/**
 * Average daily rate: net room revenue / occupied resource-nights. The nights
 * are BOOKING's (upstream occupancy projection, `ahliweb/awcms#944`); commerce
 * supplies the net and does not recompute occupancy. Rendered to two decimals
 * with rounding applied once, at the end, half-up; `null` for zero nights.
 */
export function averageDailyRate(
  netCents: bigint,
  occupiedNights: number
): string | null {
  return divideCentsHalfUp(netCents, BigInt(occupiedNights));
}

/** Revenue per available night: net / available resource-nights (Booking's denominator, blocked nights already removed). */
export function revenuePerAvailableNight(
  netCents: bigint,
  availableNights: number
): string | null {
  return divideCentsHalfUp(netCents, BigInt(availableNights));
}

function divideCentsHalfUp(cents: bigint, divisor: bigint): string | null {
  if (divisor <= 0n) return null;
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const quotient = (absolute * 2n + divisor) / (divisor * 2n);
  return `${negative ? "-" : ""}${fromCents(quotient)}`;
}

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

export {
  validateSalesReportRange as validateBookingRevenueRange,
  type SalesReportRange as BookingRevenueRange
} from "./sales-report-query";

// ---------------------------------------------------------------------------
// Hold pipeline
// ---------------------------------------------------------------------------

/** One hold as the live query reads it. */
export type HoldRow = {
  /** The order total the hold is waiting to be paid (cents). */
  totalCents: bigint;
  /** Units the hold claims: nights for a stay product, 1 for a slot. */
  units: number;
  createdAt: Date;
  /** The order's expiry = the hold's expiry; `null` = none recorded. */
  expiresAt: Date | null;
};

export type HoldPipeline = {
  holds: number;
  /** Held resource-nights (stay products) plus held slots (one each). */
  units: number;
  /** Sum of the order totals waiting for payment, `numeric(14,2)`. */
  value: string;
  /** Age in seconds of the oldest hold; `null` with no holds. */
  oldestHoldAgeSeconds: number | null;
  /** The soonest expiry among the holds; `null` with none recorded. */
  nextExpiryAt: string | null;
};

/** Pure shaping of the live hold rows: held units and value, oldest age, next expiry. */
export function shapeHoldPipeline(
  rows: readonly HoldRow[],
  now: Date
): HoldPipeline {
  let units = 0;
  let value = 0n;
  let oldest: Date | null = null;
  let nextExpiry: Date | null = null;
  for (const row of rows) {
    units += row.units;
    value += row.totalCents;
    if (oldest === null || row.createdAt.getTime() < oldest.getTime()) {
      oldest = row.createdAt;
    }
    if (
      row.expiresAt !== null &&
      (nextExpiry === null || row.expiresAt.getTime() < nextExpiry.getTime())
    ) {
      nextExpiry = row.expiresAt;
    }
  }
  return {
    holds: rows.length,
    units,
    value: fromCents(value),
    oldestHoldAgeSeconds:
      oldest === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000)),
    nextExpiryAt: nextExpiry === null ? null : nextExpiry.toISOString()
  };
}
