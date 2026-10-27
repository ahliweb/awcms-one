/**
 * Booking-sourced revenue rules - Issue #389 and Issue #478, ADR-0045 (amendment
 * note and "Owner decisions on the booking revenue slice"), spec
 * `docs/aw-business-platform-metrics.md` sections 3 (3.7 and 3.9), 8.2 and 8.3.
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
 *   * Refunds count when they are DECIDED (3.9 D1), not when the money moves: the
 *     refund of the order's return records (a goods return, an exchange, a
 *     booking cancellation, a reschedule's shortening) is an obligation from the
 *     moment it is recorded, the same moment `commerce.sales_daily` nets a
 *     return. The step has three parts that always add up: "paid back" (the
 *     ledger's succeeded reversal legs), "refund payable" (decided, not yet paid
 *     out: planned, processing or failed legs) and "uncollected balance (no money
 *     moved)" (the unpaid part of an order that will now never be collected). All
 *     three land on the ORIGINAL paid day (metrics 1.1 rule 5). Settling a leg
 *     moves cents from payable to paid back and NEVER moves net.
 *   * Each refund and each uncollected amount is allocated across the order's
 *     goods, shipping, insurance and tax (3.9 D3, `booking-refund-allocation.ts`),
 *     once, in integer cents. Only the GOODS share is in the Refunds step; the
 *     other three lower their own companion columns, so a full refund of a taxed
 *     order gives net 0 and tax 0, never a negative net (tax collected is not
 *     revenue).
 *   * Net = gross - discounts - refunds. A retained deposit is ordinary
 *     settled revenue and stays in net.
 *   * Shipping, insurance and tax are three companion columns, not part of the
 *     waterfall (each AFTER its refunded share); the unpaid balance of an order
 *     still open and the refund still payable are two more, so deposit-day
 *     gross is never read as cash received and a decided refund is never read as
 *     paid out.
 *
 * ## The order is "closed" when nothing more will be collected
 *
 * A booking that was cancelled (a cancellation refund decision exists) or marked
 * no-show (a no-show decision exists), or an order that was itself cancelled,
 * is closed: its unpaid balance (`total - paid in`) leaves as "uncollected" on
 * the original day and the outstanding balance is zero. Any other order keeps
 * its balance outstanding. "Paid in" is the sum of the succeeded PAYMENT legs
 * (money that came in, whatever went back afterwards), so the uncollected part
 * does not move when a refund is decided or paid later.
 *
 * ## The control identity (metrics 3.5, 3.9)
 *
 *   net + shipping + insurance + tax (each after its refunded share)
 *     = settled - refund payable + balance outstanding - surplus
 *
 * where `settled = paid in - paid back` and `surplus` is money held above the
 * total that has not been refunded (a liability, not revenue). It holds per
 * order BY CONSTRUCTION of {@link deriveBookingOrderRow} and is the
 * reconciliation's required control total (`bookingRevenueIdentityHolds`). The
 * cash reading of the refunds lives in the labelled by-refund-day view
 * (`booking-cash-view.ts`), never in the waterfall.
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
import {
  ZERO_COMPONENTS,
  allocateBookingRefunds,
  bookingSurplusHeldCents,
  type BookingComponents
} from "./booking-refund-allocation";
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
  settledCents: "booking_settled_cents",
  /** Issue #478 (3.9 D1): decided and not yet paid out. */
  refundPayableCents: "booking_refund_payable_cents",
  /** Issue #478 (3.9 D3): the waterfall's net, after the goods share of refunds and uncollected. */
  netCents: "booking_net_cents",
  /** Issue #478 (3.9 D3): shipping + insurance + tax, each after its refunded share. */
  companionsCents: "booking_companions_cents",
  /** Issue #478: money held above the total that has not been refunded. */
  surplusCents: "booking_surplus_cents"
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
  /**
   * The refunds DECIDED on the order (Issue #478, 3.9 D1): the return records
   * (`awcms_commerce_returns`). A goods or exchange record carries its own
   * split (`exact`: goods = goods gross less the discount released, shipping, tax);
   * a booking cancellation record is a lump (`lumpCents`, no split).
   */
  refunds: BookingDecidedRefunds;
  /** Reservation links of the order that are not `superseded` (a reschedule's replacement counts once); `0` for a supplementary order. */
  stays: number;
  /** No-show refund decisions of the order's links. */
  noShows: number;
  /** What the no-show decisions retained, in cents. */
  noShowRetainedCents: bigint;
  /** Cancellation refund decisions (customer or staff) of the order's links. */
  cancellations: number;
};

/** The refund records of one order, split by whether the record carries an exact split. */
export type BookingDecidedRefunds = {
  exact: BookingComponents;
  lumpCents: bigint;
};

export const NO_DECIDED_REFUNDS: Readonly<BookingDecidedRefunds> =
  Object.freeze({ exact: ZERO_COMPONENTS, lumpCents: 0n });

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
  /** Money: the succeeded reversal legs. */
  paidBackCents: bigint;
  /** Money: decided refunds not yet paid out (Issue #478, 3.9 D1). */
  refundPayableCents: bigint;
  /** Money: the unpaid balance of a closed order, left the order on the original day, no money moved. */
  uncollectedCents: bigint;
  /** The unpaid balance of an order still open. */
  outstandingCents: bigint;
  closed: boolean;
  /**
   * The GOODS share of each part of the Refunds step (3.9 D3): they add up to
   * the step, and settling a leg moves cents between the first two only.
   */
  goodsPaidBackCents: bigint;
  goodsPayableCents: bigint;
  goodsUncollectedCents: bigint;
  /** The shipping / insurance / tax cents that refunds and the uncollected balance took out of their companion columns. */
  shippingRefundedCents: bigint;
  insuranceRefundedCents: bigint;
  taxRefundedCents: bigint;
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
  const uncollectedCents = closed ? unpaid : 0n;
  const allocation = allocateBookingRefunds({
    components: {
      goods: max0(grossCents - discountCents),
      shipping: shippingCents,
      insurance: insuranceCents,
      tax: taxCents
    },
    exact: facts.refunds.exact,
    lumpCents: facts.refunds.lumpCents,
    paidBackCents: facts.paidBackCents,
    paidInCents: facts.paidInCents,
    uncollectedCents
  });
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
    refundPayableCents: allocation.payableCents,
    uncollectedCents,
    outstandingCents: closed ? 0n : unpaid,
    closed,
    goodsPaidBackCents: allocation.paidBack.goods,
    goodsPayableCents: allocation.payable.goods,
    goodsUncollectedCents: allocation.uncollected.goods,
    shippingRefundedCents:
      allocation.paidBack.shipping +
      allocation.payable.shipping +
      allocation.uncollected.shipping,
    insuranceRefundedCents:
      allocation.paidBack.insurance +
      allocation.payable.insurance +
      allocation.uncollected.insurance,
    taxRefundedCents:
      allocation.paidBack.tax +
      allocation.payable.tax +
      allocation.uncollected.tax
  };
}

/** The Refunds step of one order: the goods share of paid back + payable + uncollected (3.9 D1, D3). */
export function bookingOrderRefundsCents(row: BookingOrderRow): bigint {
  return (
    row.goodsPaidBackCents + row.goodsPayableCents + row.goodsUncollectedCents
  );
}

/** The three companion columns of one order, each AFTER its refunded share. */
export function bookingOrderCompanionCents(row: BookingOrderRow) {
  return {
    shippingCents: row.shippingCents - row.shippingRefundedCents,
    insuranceCents: row.insuranceCents - row.insuranceRefundedCents,
    taxCents: row.taxCents - row.taxRefundedCents
  };
}

/** Net revenue of one order: gross - discounts - the Refunds step (the goods share of refunds and of the uncollected balance). */
export function bookingOrderNetCents(row: BookingOrderRow): bigint {
  return row.grossCents - row.discountCents - bookingOrderRefundsCents(row);
}

/** Money held above the order total that has not been refunded: a liability, never revenue. */
export function bookingOrderSurplusCents(row: BookingOrderRow): bigint {
  return bookingSurplusHeldCents(
    row.paidInCents,
    row.totalCents,
    row.paidBackCents + row.refundPayableCents
  );
}

/**
 * The metrics 3.5 / 3.9 control identity for one row:
 *
 *   net + shipping + insurance + tax (each after its refunded share)
 *     = settled - refund payable + balance outstanding - surplus
 *
 * with `settled = paid in - paid back` and `surplus` = money held above the
 * total that has not been refunded (a liability, not revenue). It is the
 * reconciliation's required control total: `customer_paid` of an order with no
 * returns reads `net + companions`, and a refund lowers both sides alike.
 */
export function bookingRevenueIdentityHolds(row: BookingOrderRow): boolean {
  const companions = bookingOrderCompanionCents(row);
  const left =
    bookingOrderNetCents(row) +
    companions.shippingCents +
    companions.insuranceCents +
    companions.taxCents;
  const right =
    row.paidInCents -
    row.paidBackCents -
    row.refundPayableCents +
    row.outstandingCents -
    bookingOrderSurplusCents(row);
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
  /** Money: the succeeded reversal legs. */
  paidBackCents: bigint;
  /** Money: the unpaid balance of closed orders. */
  uncollectedCents: bigint;
  outstandingCents: bigint;
  settledCents: bigint;
  refundPayableCents: bigint;
  netCents: bigint;
  companionsCents: bigint;
  surplusCents: bigint;
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
    settledCents: 0n,
    refundPayableCents: 0n,
    netCents: 0n,
    companionsCents: 0n,
    surplusCents: 0n
  };
}

export function accumulateBookingRevenueControlTotals(
  totals: BookingRevenueControlTotals,
  row: BookingOrderRow
): void {
  const companions = bookingOrderCompanionCents(row);
  totals.orders += 1;
  totals.stays += row.stays;
  totals.noShows += row.noShows;
  totals.grossCents += row.grossCents;
  totals.discountCents += row.discountCents;
  totals.paidBackCents += row.paidBackCents;
  totals.uncollectedCents += row.uncollectedCents;
  totals.outstandingCents += row.outstandingCents;
  totals.settledCents += row.paidInCents - row.paidBackCents;
  totals.refundPayableCents += row.refundPayableCents;
  totals.netCents += bookingOrderNetCents(row);
  totals.companionsCents +=
    companions.shippingCents + companions.insuranceCents + companions.taxCents;
  totals.surplusCents += bookingOrderSurplusCents(row);
}

/**
 * The identity at the level of the control totals (the reconciliation's view of
 * 3.9 D1): net + companions = settled - refund payable + outstanding - surplus.
 * It holds for the sum of rows that each hold it.
 */
export function bookingControlTotalsIdentityHolds(
  totals: BookingRevenueControlTotals
): boolean {
  return (
    totals.netCents + totals.companionsCents ===
    totals.settledCents -
      totals.refundPayableCents +
      totals.outstandingCents -
      totals.surplusCents
  );
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

/**
 * The figures a late event can change on a day that is already closed: the
 * waterfall (gross, discounts, the Refunds step) and what the refunds took out of
 * the companions. Settling a leg moves cents between "paid back" and "payable"
 * and never moves net (3.9 D1), so it is not here and is not a restatement.
 */
function waterfallFingerprint(row: BookingOrderRow | null): string {
  if (row === null) return "none";
  return [
    row.grossCents,
    row.discountCents,
    bookingOrderRefundsCents(row),
    row.shippingRefundedCents,
    row.insuranceRefundedCents,
    row.taxRefundedCents,
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
  /** The companion columns as collected, before the refunded shares. */
  shippingCents: bigint;
  insuranceCents: bigint;
  taxCents: bigint;
  /** The goods share of each part of the Refunds step (3.9 D1, D3). */
  paidBackCents: bigint;
  payableCents: bigint;
  uncollectedCents: bigint;
  /** What refunds and the uncollected balance took out of each companion column. */
  shippingRefundedCents: bigint;
  insuranceRefundedCents: bigint;
  taxRefundedCents: bigint;
  outstandingCents: bigint;
  /** Money still to be paid out on decided refunds, all components (the companion column). */
  refundPayableCents: bigint;
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
    payableCents: 0n,
    uncollectedCents: 0n,
    shippingRefundedCents: 0n,
    insuranceRefundedCents: 0n,
    taxRefundedCents: 0n,
    outstandingCents: 0n,
    refundPayableCents: 0n
  };
}

export type BookingRevenueFigures = {
  orders: number;
  stays: number;
  /** Money, `numeric(14,2)` strings. */
  gross: string;
  discounts: string;
  /** The Refunds step: the goods share of the three parts below, which always add up to it. */
  refunds: string;
  /** Refunds, part one: the goods share of the money that actually went back to the customer. */
  refundsPaidBack: string;
  /** Refunds, part two: the goods share of refunds decided and not yet paid out. */
  refundsPayable: string;
  /** Refunds, part three: "of which uncollected balance (no money moved)", goods share. */
  refundsUncollected: string;
  net: string;
  /** The companion columns, each AFTER its refunded share (3.9 D3). */
  shipping: string;
  insurance: string;
  tax: string;
  /** The unpaid balance of orders still open, shown beside the waterfall (spec 3.7 rule 2). */
  balanceOutstanding: string;
  /** Decided refunds not yet paid out, all components (3.9 D1): the companion that says how much cash is still to leave. */
  refundPayableBalance: string;
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
  const refundsCents =
    sums.paidBackCents + sums.payableCents + sums.uncollectedCents;
  const netCents = sums.grossCents - sums.discountCents - refundsCents;
  return {
    orders: sums.orders,
    stays: sums.stays,
    gross: fromSignedCents(sums.grossCents),
    discounts: fromSignedCents(sums.discountCents),
    refunds: fromSignedCents(refundsCents),
    refundsPaidBack: fromSignedCents(sums.paidBackCents),
    refundsPayable: fromSignedCents(sums.payableCents),
    refundsUncollected: fromSignedCents(sums.uncollectedCents),
    net: fromSignedCents(netCents),
    shipping: fromSignedCents(sums.shippingCents - sums.shippingRefundedCents),
    insurance: fromSignedCents(
      sums.insuranceCents - sums.insuranceRefundedCents
    ),
    tax: fromSignedCents(sums.taxCents - sums.taxRefundedCents),
    balanceOutstanding: fromSignedCents(sums.outstandingCents),
    refundPayableBalance: fromSignedCents(sums.refundPayableCents),
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

/** `fromCents` is unsigned by contract; a signed figure keeps its sign. */
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
  into.payableCents += add.payableCents;
  into.uncollectedCents += add.uncollectedCents;
  into.shippingRefundedCents += add.shippingRefundedCents;
  into.insuranceRefundedCents += add.insuranceRefundedCents;
  into.taxRefundedCents += add.taxRefundedCents;
  into.outstandingCents += add.outstandingCents;
  into.refundPayableCents += add.refundPayableCents;
  return into;
}

/** One stored row as the day sums see it: the sum of the rows of a day is the day. */
export function bookingOrderDaySums(
  row: BookingOrderRow
): BookingRevenueDaySums {
  return {
    orders: 1,
    stays: row.stays,
    noShows: row.noShows,
    noShowRetainedCents: row.noShowRetainedCents,
    grossCents: row.grossCents,
    discountCents: row.discountCents,
    shippingCents: row.shippingCents,
    insuranceCents: row.insuranceCents,
    taxCents: row.taxCents,
    paidBackCents: row.goodsPaidBackCents,
    payableCents: row.goodsPayableCents,
    uncollectedCents: row.goodsUncollectedCents,
    shippingRefundedCents: row.shippingRefundedCents,
    insuranceRefundedCents: row.insuranceRefundedCents,
    taxRefundedCents: row.taxRefundedCents,
    outstandingCents: row.outstandingCents,
    refundPayableCents: row.refundPayableCents
  };
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
