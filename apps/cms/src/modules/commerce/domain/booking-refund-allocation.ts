/**
 * Tax-aware allocation of a booking order's refunds and uncollected balance
 * (Issue #478, metrics `docs/aw-business-platform-metrics.md` section 3.9 D1 and
 * D3, ADR-0045 "Owner decisions on the booking revenue slice"). PURE: integer
 * cents as `bigint`, no database, no I/O, no clock. The `commerce.booking_revenue`
 * sink, the reconciliation's source totals and the unit tests all run THIS
 * function, which is what makes "rebuild equals live" a property of the code.
 *
 * ## The four components of an order
 *
 * An order is worth `goods + shipping + insurance + tax`, where goods is the
 * subtotal less the discount (the derivation of `deriveBookingOrderRow`, so the
 * four add up to the order total exactly). Tax collected is not revenue (IFRS 15.47),
 * so a refund or an uncollected amount must lower the tax companion as well as
 * the goods revenue: only the GOODS share feeds the Refunds step of the waterfall;
 * the shipping, insurance and tax shares reduce their own companion columns.
 *
 * ## One allocation, once
 *
 *   1. **What was decided (D1).** The refund of an order is what its return
 *      records say it is (`awcms_commerce_returns.refund_total`: a goods return,
 *      an exchange, a booking cancellation or a reschedule's shortening), not what
 *      the ledger has paid out so far. It is capped at what the customer paid in,
 *      and never lower than what the ledger already paid back (a reversal with no
 *      return record still counts, on the cash basis it always did).
 *   2. **An exact split wins (D3).** A goods or exchange return carries its own
 *      goods, shipping and tax amounts; those are used as recorded. A booking
 *      cancellation return is a lump (one line equal to the refund, no tax share),
 *      and so is any reversal without a record: those lumps are allocated pro rata.
 *   3. **Pro rata, largest remainder.** The lumps are spread across the components
 *      that are still unrefunded with {@link allocateOrderDiscount}, the
 *      largest-remainder function the returns module already uses (and ADR-0046
 *      D6): every share is `floor(amount x component / total)` and the leftover
 *      cents go to the largest remainders, ties by component order (goods,
 *      shipping, insurance, tax). The shares add up to the amount exactly and a
 *      component never goes below zero. For an order with no exact split this is
 *      "in proportion to the order's own components"; when a goods return came
 *      first the weight is what is left of each component, which keeps the
 *      invariant "a full refund gives net 0 and tax 0, never a negative net".
 *   4. **Settlement never moves net.** The decided amount is split across the
 *      components first; the part already paid back is then taken out of that split
 *      (largest remainder again), and the rest is "refund payable". Paying a leg
 *      moves cents from payable to paid back inside the same shares, so the goods
 *      share of the Refunds step (paid back + payable) does not change.
 *   5. **The uncollected balance** (the unpaid part of a closed order) is allocated
 *      the same way, over what the refunds left.
 *
 * ## What a surplus is
 *
 * Money held above the order total (an overpayment) is a liability, not revenue.
 * A refund that exceeds every component can only be refunding that surplus; the
 * excess is not allocated (it is not revenue), and {@link bookingSurplusHeldCents}
 * reads it back so the control identity still balances.
 */
import { allocateOrderDiscount } from "./returns";

/** The four components of an order, in integer cents. Order is the tie-break order. */
export type BookingComponents = {
  goods: bigint;
  shipping: bigint;
  insurance: bigint;
  tax: bigint;
};

export const ZERO_COMPONENTS: Readonly<BookingComponents> = Object.freeze({
  goods: 0n,
  shipping: 0n,
  insurance: 0n,
  tax: 0n
});

const toList = (c: BookingComponents): bigint[] => [
  c.goods,
  c.shipping,
  c.insurance,
  c.tax
];

const fromList = (list: readonly bigint[]): BookingComponents => ({
  goods: list[0]!,
  shipping: list[1]!,
  insurance: list[2]!,
  tax: list[3]!
});

const sum = (list: readonly bigint[]): bigint =>
  list.reduce((total, value) => total + value, 0n);

export const sumComponents = (c: BookingComponents): bigint => sum(toList(c));

const max0 = (value: bigint): bigint => (value < 0n ? 0n : value);
const minOf = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxOf = (a: bigint, b: bigint): bigint => (a > b ? a : b);

export type BookingRefundAllocationInput = {
  /** The order's own components (goods = subtotal less discount, never negative). */
  components: BookingComponents;
  /** The exact split carried by goods and exchange return records (sum of their goods, shipping, tax). */
  exact: BookingComponents;
  /** The refund total of records with NO exact split (booking cancellations, a reschedule's shortening). */
  lumpCents: bigint;
  /** Succeeded reversal legs of the ledger. */
  paidBackCents: bigint;
  /** Succeeded payment legs of the ledger. */
  paidInCents: bigint;
  /** The unpaid balance of a CLOSED order (0 for an open one). */
  uncollectedCents: bigint;
};

export type BookingRefundAllocation = {
  /** Refunds decided = paid back + payable, after the cap. */
  decidedCents: bigint;
  /** Decided and not yet paid out. */
  payableCents: bigint;
  /** The components of the money already paid back. */
  paidBack: BookingComponents;
  /** The components of the money decided and not yet paid out. */
  payable: BookingComponents;
  /** The components of the uncollected balance. */
  uncollected: BookingComponents;
};

/**
 * Allocates the refunds and the uncollected balance of one order across its four
 * components. Total over every input: it never throws, never returns a negative
 * share, and never allocates more than a component holds.
 */
export function allocateBookingRefunds(
  input: BookingRefundAllocationInput
): BookingRefundAllocation {
  const components = toList(input.components);
  const exactRaw = toList(input.exact);
  const exactTotal = sum(exactRaw);

  // 1. What was decided, capped at what came in, never below what went back.
  const recorded = exactTotal + input.lumpCents;
  const decided = maxOf(
    input.paidBackCents,
    minOf(recorded, input.paidInCents)
  );

  // Whatever the records do not name (a reversal with no record) and whatever
  // the cap trimmed is settled here: shrink the lump first, then give up the
  // exact split rather than allocate more than was decided.
  let exact = exactRaw;
  let lump: bigint;
  if (exactTotal <= decided) {
    lump = decided - exactTotal;
  } else {
    exact = [0n, 0n, 0n, 0n];
    lump = decided;
  }

  // 2. An exact split wins, but never beyond what the component holds.
  const exactUsed = exact.map((value, index) =>
    minOf(value, components[index]!)
  );
  const remaining = components.map((value, index) => value - exactUsed[index]!);
  lump += sum(exact) - sum(exactUsed);

  // 3. The lumps pro rata over what is left (largest remainder, shares <= left).
  const lumpShares = allocateOrderDiscount(remaining, lump);
  const decidedShares = exactUsed.map(
    (value, index) => value + lumpShares[index]!
  );

  // 4. The paid-back part of the decided split; the rest is payable.
  const allocatedDecided = sum(decidedShares);
  const paidBackShares = allocateOrderDiscount(
    decidedShares,
    minOf(input.paidBackCents, allocatedDecided)
  );
  const payableShares = decidedShares.map(
    (value, index) => value - paidBackShares[index]!
  );

  // 5. The uncollected balance over what the refunds left.
  const afterRefunds = components.map(
    (value, index) => value - decidedShares[index]!
  );
  const uncollectedShares = allocateOrderDiscount(
    afterRefunds,
    input.uncollectedCents
  );

  return {
    decidedCents: decided,
    payableCents: decided - input.paidBackCents,
    paidBack: fromList(paidBackShares),
    payable: fromList(payableShares),
    uncollected: fromList(uncollectedShares)
  };
}

/**
 * Money held above the order total that has not been refunded: a liability,
 * never revenue. `paid in - max(total, refunded)`, never negative. With no
 * refund above the total it is the plain `paid in - total` of the #389 identity.
 */
export function bookingSurplusHeldCents(
  paidInCents: bigint,
  totalCents: bigint,
  refundedCents: bigint
): bigint {
  return max0(paidInCents - maxOf(totalCents, refundedCents));
}
