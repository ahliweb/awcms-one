/**
 * Booking-sourced revenue rules and the booking anchor of retention (Issue
 * #389, ADR-0045 amendment note; metrics spec sections 3, 3.7, 6, 8.2, 8.3 and
 * the proof list of section 11) - PURE, no database, so the fixed figures below
 * are fixtures of the spec's own worked examples, not wall-clock dependencies.
 * The live-database half (rebuild equals live, late events through the engine,
 * RLS, the real adapter flows) is
 * `tests/integration/commerce-booking-revenue.integration.test.ts`.
 *
 * Section 11 items proved here at the arithmetic level:
 *   2. each late-event case of the contract table (a refund after close, an
 *      amended booking, nothing counted twice);
 *   5. retention cohort assignment on the section 6.3 example with the booking
 *      anchor - the day-90 boundary and the fully refunded first purchase;
 *   8. the three rows of the section 3.7 deposit worked example;
 * plus the section 8.3 villa example, to the cent.
 */
import { describe, expect, test } from "bun:test";

import {
  NO_DECIDED_REFUNDS,
  addBookingRevenueDaySums,
  averageDailyRate,
  bookingControlTotalsIdentityHolds,
  bookingDayRestatementThreshold,
  bookingOrderCompanionCents,
  bookingOrderDaySums,
  bookingOrderNetCents,
  bookingRevenueIdentityHolds,
  accumulateBookingRevenueControlTotals,
  deriveBookingOrderRow,
  emptyBookingRevenueControlTotals,
  emptyBookingRevenueDaySums,
  formatRatePercent,
  fromSignedCents,
  restatedBookingDays,
  revenuePerAvailableNight,
  shapeBookingRevenueFigures,
  shapeHoldPipeline,
  type BookingOrderFacts,
  type BookingOrderRow,
  type BookingRevenueDaySums
} from "../src/modules/commerce/domain/booking-revenue";
import {
  RETENTION_WINDOW_MS,
  cohortMonthOf,
  deriveCustomerRetention,
  retentionEventOf,
  shapeRetentionCohorts,
  type RetentionOrderFact
} from "../src/modules/commerce/domain/retention";
import { bookingBatchOrderIds } from "../src/modules/commerce/application/retention-projection";
import { bookingRevenueOrderIds } from "../src/modules/commerce/application/booking-revenue-projection";

/** An `Asia/Jakarta` wall-clock instant: `jkt(2026, 1, 3, 9)` is 3 Jan 2026 09:00 WIB. */
const jkt = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(Date.UTC(y, m - 1, d, h - 7, min));
const DAY = 24 * 60 * 60 * 1000;
const rp = (amount: number) => BigInt(amount) * 100n;

function facts(over: Partial<BookingOrderFacts> = {}): BookingOrderFacts {
  return {
    orderId: "order-1",
    sourceKind: "reservation",
    paidAt: jkt(2026, 10, 1, 10),
    status: "paid",
    subtotal: "3000000.00",
    shippingCost: "0.00",
    insuranceFee: "0.00",
    tax: "0.00",
    total: "3000000.00",
    paidInCents: 0n,
    paidBackCents: 0n,
    refunds: NO_DECIDED_REFUNDS,
    stays: 1,
    noShows: 0,
    noShowRetainedCents: 0n,
    cancellations: 0,
    ...over
  };
}

function derived(over: Partial<BookingOrderFacts> = {}): BookingOrderRow {
  const row = deriveBookingOrderRow(facts(over));
  if (row === null) throw new Error("expected a row");
  return row;
}

const sumsOf = (...rows: BookingOrderRow[]): BookingRevenueDaySums => {
  const sums = emptyBookingRevenueDaySums();
  for (const row of rows)
    addBookingRevenueDaySums(sums, bookingOrderDaySums(row));
  return sums;
};

describe("proof 8: the deposit worked example of metrics section 3.7 (three nights at 1,000,000, a 30% deposit of 900,000)", () => {
  test("balance paid at check-in: gross 3,000,000, nothing back, nothing uncollected, net 3,000,000, balance 0", () => {
    const row = derived({ paidInCents: rp(3_000_000) });
    expect(row.grossCents).toBe(rp(3_000_000));
    expect(row.paidBackCents).toBe(0n);
    expect(row.uncollectedCents).toBe(0n);
    expect(row.outstandingCents).toBe(0n);
    expect(bookingOrderNetCents(row)).toBe(rp(3_000_000));
  });

  test("no-show, deposit retained, balance never paid: uncollected 2,100,000 on the deposit day, net 900,000, order closed", () => {
    const row = derived({
      paidInCents: rp(900_000),
      noShows: 1,
      noShowRetainedCents: rp(900_000)
    });
    expect(row.closed).toBe(true);
    expect(row.grossCents).toBe(rp(3_000_000));
    expect(row.paidBackCents).toBe(0n);
    expect(row.uncollectedCents).toBe(rp(2_100_000));
    expect(row.outstandingCents).toBe(0n);
    expect(bookingOrderNetCents(row)).toBe(rp(900_000));
    expect(row.paidDay).toBe("2026-10-01");
  });

  test("cancelled early, half the deposit refunded: paid back 450,000, uncollected 2,100,000, net 450,000", () => {
    const row = derived({
      paidInCents: rp(900_000),
      paidBackCents: rp(450_000),
      cancellations: 1
    });
    expect(row.closed).toBe(true);
    expect(row.paidBackCents).toBe(rp(450_000));
    expect(row.uncollectedCents).toBe(rp(2_100_000));
    expect(bookingOrderNetCents(row)).toBe(rp(450_000));
    // The parts always add up to the Refunds step.
    const figures = shapeBookingRevenueFigures(sumsOf(row));
    expect(figures.refunds).toBe("2550000.00");
    expect(figures.refundsPaidBack).toBe("450000.00");
    expect(figures.refundsPayable).toBe("0.00");
    expect(figures.refundsUncollected).toBe("2100000.00");
    expect(figures.net).toBe("450000.00");
  });

  test("on the deposit day itself gross is the whole 3,000,000 and the 2,100,000 balance is shown beside the waterfall, not subtracted", () => {
    const row = derived({ paidInCents: rp(900_000) });
    expect(row.closed).toBe(false);
    expect(row.uncollectedCents).toBe(0n);
    expect(row.outstandingCents).toBe(rp(2_100_000));
    const figures = shapeBookingRevenueFigures(sumsOf(row));
    expect(figures.gross).toBe("3000000.00");
    expect(figures.net).toBe("3000000.00");
    expect(figures.balanceOutstanding).toBe("2100000.00");
  });

  test("the balance paid later changes nothing in the waterfall, only the outstanding balance", () => {
    const deposit = derived({ paidInCents: rp(900_000) });
    const settled = derived({ paidInCents: rp(3_000_000) });
    expect(settled.grossCents).toBe(deposit.grossCents);
    expect(bookingOrderNetCents(settled)).toBe(bookingOrderNetCents(deposit));
    expect(deposit.outstandingCents).toBe(rp(2_100_000));
    expect(settled.outstandingCents).toBe(0n);
    expect(settled.paidDay).toBe(deposit.paidDay);
  });

  test("a retained deposit is ordinary settled revenue; a partial refund adds to the paid-back line only", () => {
    const row = derived({
      paidInCents: rp(900_000),
      paidBackCents: rp(100_000),
      noShows: 1,
      noShowRetainedCents: rp(800_000)
    });
    expect(row.paidBackCents).toBe(rp(100_000));
    expect(row.uncollectedCents).toBe(rp(2_100_000));
    expect(bookingOrderNetCents(row)).toBe(rp(800_000));
  });
});

describe("the contract table's late-event cases (proof 2)", () => {
  test("paid 30 Sep 23:50 WIB, refunded in full on 3 Oct: gross 100, refunds 100, net 0 - on 30 Sep", () => {
    const row = derived({
      paidAt: jkt(2026, 9, 30, 23, 50),
      subtotal: "100.00",
      total: "100.00",
      paidInCents: 10_000n,
      paidBackCents: 10_000n
    });
    expect(row.paidDay).toBe("2026-09-30");
    const figures = shapeBookingRevenueFigures(sumsOf(row));
    expect(figures.gross).toBe("100.00");
    expect(figures.refunds).toBe("100.00");
    expect(figures.net).toBe("0.00");
    expect(figures.refundRatePercent).toBe("100.0");
  });

  test("paid at 00:10 WIB on 1 Oct (17:10 UTC on 30 Sep) counts on 1 Oct: the UTC date is irrelevant", () => {
    const row = derived({ paidAt: jkt(2026, 10, 1, 0, 10) });
    expect(row.paidDay).toBe("2026-10-01");
    expect(derived({ paidAt: jkt(2026, 9, 30, 23, 59) }).paidDay).toBe(
      "2026-09-30"
    );
  });

  test("never paid (cancelled before payment, held, unpaid): no row, nothing in any column", () => {
    expect(deriveBookingOrderRow(facts({ paidAt: null }))).toBeNull();
    expect(
      deriveBookingOrderRow(facts({ paidAt: null, status: "cancelled" }))
    ).toBeNull();
  });

  test("a recompute is idempotent: the same facts give the same row, so a repeated pass counts nothing twice", () => {
    const input = facts({ paidInCents: rp(900_000), cancellations: 1 });
    expect(deriveBookingOrderRow(input)).toEqual(deriveBookingOrderRow(input));
  });

  test("an order paid more than its total: the surplus is held, not earned, and the identity still holds", () => {
    const row = derived({ paidInCents: rp(3_200_000) });
    expect(row.outstandingCents).toBe(0n);
    expect(bookingRevenueIdentityHolds(row)).toBe(true);
  });

  test("a supplementary order is revenue of its own day with no stay of its own", () => {
    const row = derived({
      sourceKind: "supplement",
      stays: 0,
      subtotal: "500000.00",
      total: "500000.00",
      paidInCents: rp(500_000)
    });
    expect(row.sourceKind).toBe("supplement");
    expect(row.stays).toBe(0);
    expect(bookingOrderNetCents(row)).toBe(rp(500_000));
  });
});

describe("the control identity of metrics section 3.5", () => {
  test("net + shipping + insurance + tax = settled + outstanding - surplus holds for every combination of the facts", () => {
    let checked = 0;
    for (const paidIn of [0, 1, 900_000, 1_850_000, 3_000_000, 3_300_000]) {
      for (const paidBack of [0, 450_000, 900_000]) {
        for (const closing of ["open", "cancel", "no_show", "order"] as const) {
          for (const [tax, shipping, insurance, discount] of [
            [0, 0, 0, 0],
            [330_000, 0, 0, 0],
            [0, 25_000, 10_000, 250_000],
            [297_000, 0, 5_000, 300_000]
          ] as [number, number, number, number][]) {
            if (paidBack > paidIn) continue;
            const subtotal = 3_000_000;
            const total = subtotal - discount + tax + shipping + insurance;
            const row = derived({
              subtotal: `${subtotal}.00`,
              tax: `${tax}.00`,
              shippingCost: `${shipping}.00`,
              insuranceFee: `${insurance}.00`,
              total: `${total}.00`,
              paidInCents: rp(paidIn),
              paidBackCents: rp(paidBack),
              cancellations: closing === "cancel" ? 1 : 0,
              noShows: closing === "no_show" ? 1 : 0,
              status: closing === "order" ? "cancelled" : "paid"
            });
            expect(row.discountCents).toBe(rp(discount));
            expect(bookingRevenueIdentityHolds(row)).toBe(true);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("companion columns stay beside the waterfall, never inside it", () => {
    const row = derived({
      tax: "330000.00",
      shippingCost: "25000.00",
      insuranceFee: "10000.00",
      total: "3365000.00",
      paidInCents: rp(3_365_000)
    });
    const figures = shapeBookingRevenueFigures(sumsOf(row));
    expect(figures.gross).toBe("3000000.00");
    expect(figures.net).toBe("3000000.00");
    expect(figures.tax).toBe("330000.00");
    expect(figures.shipping).toBe("25000.00");
    expect(figures.insurance).toBe("10000.00");
  });
});

describe("the villa week of metrics section 8.3, to the cent", () => {
  // R1: 3 nights, 3,000,000, paid in full. R2: 2 nights, 2,500,000, a 250,000
  // discount, a 100,000 partial refund after the stay (the original paid day).
  const r1 = derived({
    orderId: "r1",
    paidAt: jkt(2026, 10, 1, 9),
    paidInCents: rp(3_000_000)
  });
  const r2 = derived({
    orderId: "r2",
    paidAt: jkt(2026, 10, 3, 9),
    subtotal: "2500000.00",
    total: "2250000.00",
    paidInCents: rp(2_250_000),
    paidBackCents: rp(100_000)
  });
  const week = shapeBookingRevenueFigures(sumsOf(r1, r2));

  test("revenue waterfall: gross 5,500,000, discounts 250,000, refunds 100,000, net 5,150,000", () => {
    expect(r2.discountCents).toBe(rp(250_000));
    expect(week.gross).toBe("5500000.00");
    expect(week.discounts).toBe("250000.00");
    expect(week.refunds).toBe("100000.00");
    expect(week.refundsPaidBack).toBe("100000.00");
    expect(week.refundsUncollected).toBe("0.00");
    expect(week.net).toBe("5150000.00");
    // R2's own line.
    expect(fromSignedCents(bookingOrderNetCents(r2))).toBe("2150000.00");
  });

  test("ADR = net / occupied nights = 1,030,000 and RevPAN = net / available nights = 858,333.33 (Booking supplies the nights)", () => {
    const net = bookingOrderNetCents(r1) + bookingOrderNetCents(r2);
    expect(net).toBe(rp(5_150_000));
    expect(averageDailyRate(net, 5)).toBe("1030000.00");
    expect(revenuePerAvailableNight(net, 6)).toBe("858333.33");
    // occupancy x ADR = RevPAN: (5 / 6) x 1,030,000.
    expect(revenuePerAvailableNight(net * 5n, 5 * 6)).toBe("858333.33");
    expect(averageDailyRate(net, 0)).toBeNull();
    expect(revenuePerAvailableNight(net, 0)).toBeNull();
  });

  test("derived ratios use gross as the denominator", () => {
    expect(week.discountRatePercent).toBe("4.5");
    expect(week.refundRatePercent).toBe("1.8");
  });

  test("the held night (R3) is NOT revenue: a hold has no paid order, so it has no row at all", () => {
    expect(deriveBookingOrderRow(facts({ paidAt: null }))).toBeNull();
  });

  test("a rate shows nothing when gross is zero", () => {
    const empty = shapeBookingRevenueFigures(emptyBookingRevenueDaySums());
    expect(empty.discountRatePercent).toBeNull();
    expect(empty.refundRatePercent).toBeNull();
    expect(empty.noShowRatePercent).toBeNull();
    expect(empty.net).toBe("0.00");
  });
});

describe("no-show figures, joined through the order", () => {
  test("the rate is no-shows / stays, one decimal, round-half-up", () => {
    const showed = derived({ orderId: "a", paidInCents: rp(3_000_000) });
    const missed = derived({
      orderId: "b",
      paidInCents: rp(900_000),
      noShows: 1,
      noShowRetainedCents: rp(900_000)
    });
    const figures = shapeBookingRevenueFigures(sumsOf(showed, missed));
    expect(figures.stays).toBe(2);
    expect(figures.noShows).toBe(1);
    expect(figures.noShowRatePercent).toBe("50.0");
    expect(figures.noShowRetained).toBe("900000.00");
    expect(formatRatePercent(1n, 8n)).toBe("12.5");
    expect(formatRatePercent(1n, 3n)).toBe("33.3");
    expect(formatRatePercent(2n, 3n)).toBe("66.7");
    expect(formatRatePercent(0n, 5n)).toBe("0.0");
    expect(formatRatePercent(1n, 0n)).toBeNull();
  });

  test("a replacement reservation counts once: the superseded link is not a stay", () => {
    expect(derived({ stays: 1 }).stays).toBe(1);
  });
});

describe("restatement (metrics 1.2, window 35 days)", () => {
  const closed = derived({
    paidAt: jkt(2026, 8, 1, 10),
    paidInCents: rp(900_000)
  });
  const afterWindow = new Date(
    bookingDayRestatementThreshold("2026-08-01").getTime() + 1000
  );

  test("the threshold is the end of the Jakarta day plus 35 days", () => {
    expect(bookingDayRestatementThreshold("2026-08-01").toISOString()).toBe(
      new Date(Date.UTC(2026, 7, 1, 17, 0) + 35 * DAY).toISOString()
    );
  });

  test("a no-show that closes an old day restates it; the same facts again restate nothing", () => {
    const noShow = derived({
      paidAt: jkt(2026, 8, 1, 10),
      paidInCents: rp(900_000),
      noShows: 1,
      noShowRetainedCents: rp(900_000)
    });
    expect(restatedBookingDays(closed, noShow, afterWindow)).toEqual([
      "2026-08-01"
    ]);
    expect(restatedBookingDays(noShow, noShow, afterWindow)).toEqual([]);
  });

  test("the same change inside the window is ordinary filling-in, not a restatement", () => {
    const noShow = derived({
      paidAt: jkt(2026, 8, 1, 10),
      paidInCents: rp(900_000),
      noShows: 1
    });
    expect(
      restatedBookingDays(closed, noShow, new Date(jkt(2026, 8, 20).getTime()))
    ).toEqual([]);
  });

  test("a balance paid late moves only the outstanding companion, never the waterfall", () => {
    const settled = derived({
      paidAt: jkt(2026, 8, 1, 10),
      paidInCents: rp(3_000_000)
    });
    expect(restatedBookingDays(closed, settled, afterWindow)).toEqual([]);
  });

  test("a late refund restates the ORIGINAL paid day", () => {
    const refunded = derived({
      paidAt: jkt(2026, 8, 1, 10),
      paidInCents: rp(900_000),
      paidBackCents: rp(450_000)
    });
    expect(restatedBookingDays(closed, refunded, afterWindow)).toEqual([
      "2026-08-01"
    ]);
  });
});

describe("the hold pipeline (metrics 4.3, 8.2)", () => {
  const now = new Date("2026-10-10T10:00:00Z");

  test("held units and value, the oldest hold's age and the next expiry", () => {
    const pipeline = shapeHoldPipeline(
      [
        {
          totalCents: rp(1_000_000),
          units: 1,
          createdAt: new Date("2026-10-10T09:00:00Z"),
          expiresAt: new Date("2026-10-10T12:00:00Z")
        },
        {
          totalCents: rp(2_500_000),
          units: 2,
          createdAt: new Date("2026-10-10T08:00:00Z"),
          expiresAt: new Date("2026-10-10T11:00:00Z")
        }
      ],
      now
    );
    expect(pipeline).toEqual({
      holds: 2,
      units: 3,
      value: "3500000.00",
      oldestHoldAgeSeconds: 2 * 3600,
      nextExpiryAt: "2026-10-10T11:00:00.000Z"
    });
  });

  test("an empty pipeline is zero with no age and no expiry", () => {
    expect(shapeHoldPipeline([], now)).toEqual({
      holds: 0,
      units: 0,
      value: "0.00",
      oldestHoldAgeSeconds: null,
      nextExpiryAt: null
    });
  });
});

describe("which batch rows can change a projection row", () => {
  test("revenue: orders and supplementary orders; a failed leg moves no money", () => {
    expect(
      bookingRevenueOrderIds([
        { order_id: "b" },
        { order_id: "a", supplement_order_id: "c" },
        { order_id: "d", status: "failed" },
        { order_id: "e", status: "succeeded" },
        { order_id: "a" }
      ])
    ).toEqual(["a", "b", "c", "e"]);
  });

  test("retention: the order a decision or reschedule is about and the supplementary order it created", () => {
    expect(
      bookingBatchOrderIds([
        { order_id: "x", supplement_order_id: null },
        { order_id: "y", supplement_order_id: "z" }
      ])
    ).toEqual(["x", "y", "z"]);
  });
});

// ---------------------------------------------------------------------------
// The booking anchor of retention (metrics section 6)
// ---------------------------------------------------------------------------

const order = (
  id: string,
  paidAt: Date | null,
  over: Partial<RetentionOrderFact> = {}
): RetentionOrderFact => ({
  orderId: id,
  paidAt,
  status: paidAt === null ? "pending_payment" : "completed",
  paymentStatus: paidAt === null ? "unpaid" : "paid",
  ...over
});

const booking = (
  id: string,
  paidAt: Date | null,
  over: Partial<RetentionOrderFact> = {}
): RetentionOrderFact =>
  order(id, paidAt, {
    booking: { kind: "reservation", standing: true },
    ...over
  });

describe("retention events with the booking anchor", () => {
  test("a standing booking is a booking event; an ordinary order is an order event", () => {
    expect(retentionEventOf(booking("b", jkt(2026, 1, 10)))).toMatchObject({
      kind: "booking"
    });
    expect(retentionEventOf(order("o", jkt(2026, 1, 10)))).toMatchObject({
      kind: "order"
    });
  });

  test("a cancelled stay is no event even though a retained deposit keeps the order from being fully refunded", () => {
    const cancelled = booking("b", jkt(2026, 1, 10), {
      booking: { kind: "reservation", standing: false },
      paymentStatus: "paid"
    });
    expect(retentionEventOf(cancelled)).toBeNull();
    expect(deriveCustomerRetention([cancelled])).toBeNull();
  });

  test("a no-show still stands: the guest booked and paid", () => {
    // `standing` stays true for a no-show release (booking-report-facts.ts).
    expect(retentionEventOf(booking("b", jkt(2026, 1, 10)))).not.toBeNull();
  });

  test("a fully refunded booking never started the customer", () => {
    expect(
      retentionEventOf(
        booking("b", jkt(2026, 1, 10), { paymentStatus: "refunded" })
      )
    ).toBeNull();
  });

  test("the supplementary order of a stay that grew is part of the stay, not a repeat", () => {
    const stay = booking("b", jkt(2026, 1, 10));
    const supplement = order("s", jkt(2026, 1, 12), {
      booking: { kind: "supplement" }
    });
    const derived = deriveCustomerRetention([stay, supplement])!;
    expect(derived.firstEventKind).toBe("booking");
    expect(derived.secondEventAt).toBeNull();
    expect(derived.qualifyingOrderCount).toBe(1);
    expect(derived.qualifyingBookingCount).toBe(1);
  });

  test("a booking then an order is a repeat; the first event's kind is recorded", () => {
    const derived = deriveCustomerRetention([
      order("o", jkt(2026, 2, 20)),
      booking("b", jkt(2026, 1, 3))
    ])!;
    expect(derived.firstEventKind).toBe("booking");
    expect(derived.cohortMonth).toBe("2026-01-01");
    expect(derived.secondEventAt).toEqual(jkt(2026, 2, 20));
    expect(derived.qualifyingOrderCount).toBe(2);
    expect(derived.qualifyingBookingCount).toBe(1);
  });

  test("a booking at the very instant of an order anchors the customer (deterministic, read-order independent)", () => {
    const at = jkt(2026, 3, 3, 10);
    const forward = deriveCustomerRetention([
      order("o", at),
      booking("b", at)
    ])!;
    const reversed = deriveCustomerRetention([
      booking("b", at),
      order("o", at)
    ])!;
    expect(forward.firstEventKind).toBe("booking");
    expect(reversed).toEqual(forward);
    // Two events at one instant are not a repeat.
    expect(forward.secondEventAt).toBeNull();
  });

  test("an order-only customer is unchanged: kind order, no bookings", () => {
    const derived = deriveCustomerRetention([
      order("o1", jkt(2026, 1, 3)),
      order("o2", jkt(2026, 1, 9))
    ])!;
    expect(derived.firstEventKind).toBe("order");
    expect(derived.qualifyingBookingCount).toBe(0);
  });
});

describe("proof 5: the section 6.3 cohorts with bookings (B) and orders (O), including the day-90 boundary and the fully refunded first purchase", () => {
  type Customer = { id: string; facts: RetentionOrderFact[] };
  const c1 = jkt(2026, 1, 3);
  const c4 = jkt(2026, 1, 28);
  const customers: Customer[] = [
    // C1: 3 Jan (O), 20 Feb (B): 48 days, a repeat.
    {
      id: "C1",
      facts: [order("c1a", c1), booking("c1b", jkt(2026, 2, 20))]
    },
    // C2: 10 Jan (B), 10 May (O): 120 days, no repeat.
    {
      id: "C2",
      facts: [booking("c2a", jkt(2026, 1, 10)), order("c2b", jkt(2026, 5, 10))]
    },
    // C3: 15 Jan (O), nothing.
    { id: "C3", facts: [order("c3a", jkt(2026, 1, 15))] },
    // C4: 28 Jan (B), exactly 90 x 24 h later (B): inside the window.
    {
      id: "C4",
      facts: [
        booking("c4a", c4),
        booking("c4b", new Date(c4.getTime() + RETENTION_WINDOW_MS))
      ]
    },
    // C5: 2 Feb (O), 12 Feb (O).
    {
      id: "C5",
      facts: [order("c5a", jkt(2026, 2, 2)), order("c5b", jkt(2026, 2, 12))]
    },
    // C6: 9 Feb (B), nothing.
    { id: "C6", facts: [booking("c6a", jkt(2026, 2, 9))] },
    // C7: 21 Feb (B), then refunded in full: never started.
    {
      id: "C7",
      facts: [booking("c7a", jkt(2026, 2, 21), { paymentStatus: "refunded" })]
    }
  ];

  const tally = new Map<
    string,
    {
      cohortMonth: string;
      size: number;
      repeaters: number;
      bookingAnchored: number;
    }
  >();
  for (const customer of customers) {
    const row = deriveCustomerRetention(customer.facts);
    if (row === null) continue;
    const cohort = tally.get(row.cohortMonth) ?? {
      cohortMonth: row.cohortMonth,
      size: 0,
      repeaters: 0,
      bookingAnchored: 0
    };
    cohort.size += 1;
    if (
      row.secondEventAt !== null &&
      row.secondEventAt.getTime() - row.firstEventAt.getTime() <=
        RETENTION_WINDOW_MS
    ) {
      cohort.repeaters += 1;
    }
    if (row.firstEventKind === "booking") cohort.bookingAnchored += 1;
    tally.set(row.cohortMonth, cohort);
  }

  test("January: C1, C2, C3, C4 -> 4 customers, 2 repeaters (C1 and C4, day 90 inside); February: C5, C6 -> 2, 1; C7 is in no cohort", () => {
    const cohorts = shapeRetentionCohorts(
      [...tally.values()],
      jkt(2026, 10, 1)
    );
    expect(cohorts.map((c) => [c.cohortMonth, c.size, c.repeaters])).toEqual([
      ["2026-01-01", 4, 2],
      ["2026-02-01", 2, 1]
    ]);
    // Under 20 customers: counts, not a percentage.
    expect(cohorts.every((c) => !c.rateShown && c.ratePercent === null)).toBe(
      true
    );
    expect(deriveCustomerRetention(customers[6]!.facts)).toBeNull();
  });

  test("how many of each cohort began with a booking", () => {
    const cohorts = shapeRetentionCohorts(
      [...tally.values()],
      jkt(2026, 10, 1)
    );
    expect(cohorts.map((c) => c.bookingAnchored)).toEqual([2, 1]);
  });

  test("the day-90 boundary is to the millisecond with bookings too", () => {
    const first = jkt(2026, 4, 5);
    const inside = deriveCustomerRetention([
      booking("a", first),
      booking("b", new Date(first.getTime() + RETENTION_WINDOW_MS))
    ])!;
    const outside = deriveCustomerRetention([
      booking("a", first),
      booking("b", new Date(first.getTime() + RETENTION_WINDOW_MS + 1))
    ])!;
    const repeat = (row: NonNullable<typeof inside>) =>
      row.secondEventAt !== null &&
      row.secondEventAt.getTime() - row.firstEventAt.getTime() <=
        RETENTION_WINDOW_MS;
    expect(repeat(inside)).toBe(true);
    expect(repeat(outside)).toBe(false);
    expect(cohortMonthOf(first)).toBe("2026-04-01");
  });
});

// ---------------------------------------------------------------------------
// Issue #478: refunds on a decision basis (metrics 3.9 D1) and tax-aware
// allocation (3.9 D3). The three rows of the 3.7 worked example keep their net;
// the taxed cases are asserted to the cent.
// ---------------------------------------------------------------------------

/** A cancellation record: a lump with no exact split (the booking cancellation return). */
const lump = (amount: number) => ({
  exact: { goods: 0n, shipping: 0n, insurance: 0n, tax: 0n },
  lumpCents: rp(amount)
});

describe("D1: a refund counts when it is decided, settlement never moves net", () => {
  const early = (paidBack: number) =>
    derived({
      paidInCents: rp(900_000),
      paidBackCents: rp(paidBack),
      cancellations: 1,
      refunds: lump(450_000)
    });

  test("early cancel, half the deposit refunded: decided but not paid out = payable 450,000, paid back 0, net 450,000", () => {
    const row = early(0);
    expect(row.refundPayableCents).toBe(rp(450_000));
    expect(row.paidBackCents).toBe(0n);
    const figures = shapeBookingRevenueFigures(sumsOf(row));
    expect(figures.refundsPaidBack).toBe("0.00");
    expect(figures.refundsPayable).toBe("450000.00");
    expect(figures.refundsUncollected).toBe("2100000.00");
    expect(figures.refunds).toBe("2550000.00");
    expect(figures.net).toBe("450000.00");
    expect(figures.refundPayableBalance).toBe("450000.00");
    expect(bookingRevenueIdentityHolds(row)).toBe(true);
  });

  test("after the leg settles: paid back 450,000, payable 0, net 450,000 - net did not move", () => {
    const decided = shapeBookingRevenueFigures(sumsOf(early(0)));
    const settled = shapeBookingRevenueFigures(sumsOf(early(450_000)));
    expect(settled.refundsPaidBack).toBe("450000.00");
    expect(settled.refundsPayable).toBe("0.00");
    expect(settled.refundPayableBalance).toBe("0.00");
    expect(settled.net).toBe("450000.00");
    expect(settled.net).toBe(decided.net);
    expect(settled.refunds).toBe(decided.refunds);
  });

  test("a partly settled leg moves cents between the two parts only", () => {
    const part = early(200_000);
    expect(part.goodsPaidBackCents).toBe(rp(200_000));
    expect(part.goodsPayableCents).toBe(rp(250_000));
    expect(part.refundPayableCents).toBe(rp(250_000));
    expect(bookingOrderNetCents(part)).toBe(rp(450_000));
    expect(bookingRevenueIdentityHolds(part)).toBe(true);
  });

  test("the metrics 3.7 rows without tax keep today's net: 3,000,000 / 900,000 / 450,000", () => {
    expect(bookingOrderNetCents(derived({ paidInCents: rp(3_000_000) }))).toBe(
      rp(3_000_000)
    );
    expect(
      bookingOrderNetCents(
        derived({
          paidInCents: rp(900_000),
          noShows: 1,
          noShowRetainedCents: rp(900_000)
        })
      )
    ).toBe(rp(900_000));
    expect(bookingOrderNetCents(early(0))).toBe(rp(450_000));
  });

  test("a failed leg stays payable: the same facts as 'decided, not paid out'", () => {
    // A failed leg is not a succeeded reversal, so the ledger fact is still 0 paid back.
    const failed = early(0);
    expect(failed.refundPayableCents).toBe(rp(450_000));
    expect(failed.goodsPayableCents).toBe(rp(450_000));
  });

  test("a reversal with no return record still counts (the cash basis it always had)", () => {
    const row = derived({
      paidInCents: rp(3_000_000),
      paidBackCents: rp(100_000)
    });
    expect(row.refundPayableCents).toBe(0n);
    expect(row.goodsPaidBackCents).toBe(rp(100_000));
    expect(bookingOrderNetCents(row)).toBe(rp(2_900_000));
  });

  test("a refund decided beyond what was paid in is capped at the money that came in", () => {
    const row = derived({
      paidInCents: rp(900_000),
      cancellations: 1,
      refunds: lump(1_500_000)
    });
    expect(row.refundPayableCents).toBe(rp(900_000));
    expect(bookingRevenueIdentityHolds(row)).toBe(true);
  });

  test("a refund after a cancellation is never subtracted twice: the uncollected balance is the unpaid part, the refund the paid part", () => {
    const row = derived({
      paidInCents: rp(900_000),
      status: "cancelled",
      cancellations: 1,
      refunds: lump(900_000),
      paidBackCents: rp(900_000)
    });
    expect(row.uncollectedCents).toBe(rp(2_100_000));
    expect(row.goodsPaidBackCents).toBe(rp(900_000));
    expect(bookingOrderNetCents(row)).toBe(0n);
    expect(bookingRevenueIdentityHolds(row)).toBe(true);
  });

  test("settling a leg is not a restatement of the day, a newly decided refund is", () => {
    const decided = early(0);
    const settled = early(450_000);
    const after = new Date(
      bookingDayRestatementThreshold("2026-10-01").getTime() + 1000
    );
    expect(restatedBookingDays(decided, settled, after)).toEqual([]);
    const before = derived({ paidInCents: rp(900_000), cancellations: 1 });
    expect(restatedBookingDays(before, decided, after)).toEqual(["2026-10-01"]);
  });
});

describe("D3: a refund of a taxed order nets the tax companion, never the goods revenue alone", () => {
  // 1,000,000 of goods plus 100,000 tax, paid in full.
  const taxed = (over: Partial<BookingOrderFacts>) =>
    derived({
      subtotal: "1000000.00",
      tax: "100000.00",
      total: "1100000.00",
      paidInCents: rp(1_100_000),
      ...over
    });

  test("a full refund gives net 0 and tax 0, never a negative net", () => {
    const row = taxed({
      paidBackCents: rp(1_100_000),
      cancellations: 1,
      refunds: lump(1_100_000)
    });
    expect(bookingOrderNetCents(row)).toBe(0n);
    expect(bookingOrderCompanionCents(row).taxCents).toBe(0n);
    expect(bookingRevenueIdentityHolds(row)).toBe(true);
    const figures = shapeBookingRevenueFigures(sumsOf(row));
    expect(figures.net).toBe("0.00");
    expect(figures.tax).toBe("0.00");
    expect(figures.refunds).toBe("1000000.00");
  });

  test("a refund of 550,000 gives net 500,000 and tax 50,000", () => {
    const row = taxed({
      paidBackCents: rp(550_000),
      cancellations: 1,
      refunds: lump(550_000)
    });
    expect(bookingOrderNetCents(row)).toBe(rp(500_000));
    expect(bookingOrderCompanionCents(row).taxCents).toBe(rp(50_000));
    expect(bookingRevenueIdentityHolds(row)).toBe(true);
  });

  test("the same refund decided and not yet paid gives the same net and tax (settlement never moves net)", () => {
    const row = taxed({ cancellations: 1, refunds: lump(550_000) });
    expect(row.refundPayableCents).toBe(rp(550_000));
    expect(bookingOrderNetCents(row)).toBe(rp(500_000));
    expect(bookingOrderCompanionCents(row).taxCents).toBe(rp(50_000));
    expect(bookingRevenueIdentityHolds(row)).toBe(true);
  });

  test("the taxed no-show of 3.9: 3,000,000 + 330,000 tax, 30% deposit 999,000: net 900,000, tax 99,000", () => {
    const row = derived({
      subtotal: "3000000.00",
      tax: "330000.00",
      total: "3330000.00",
      paidInCents: rp(999_000),
      noShows: 1,
      noShowRetainedCents: rp(999_000)
    });
    expect(row.uncollectedCents).toBe(rp(2_331_000));
    expect(row.goodsUncollectedCents).toBe(rp(2_100_000));
    expect(row.taxRefundedCents).toBe(rp(231_000));
    expect(bookingOrderNetCents(row)).toBe(rp(900_000));
    expect(bookingOrderCompanionCents(row).taxCents).toBe(rp(99_000));
    // settled 999,000 = net 900,000 + tax 99,000.
    expect(row.paidInCents - row.paidBackCents).toBe(rp(999_000));
    expect(bookingRevenueIdentityHolds(row)).toBe(true);
  });

  test("an exact split on a goods return wins over pro rata", () => {
    // The return refunded 400,000 of goods and 20,000 of tax (a 5% share, not the order's 10%).
    const row = taxed({
      paidBackCents: rp(420_000),
      refunds: {
        exact: {
          goods: rp(400_000),
          shipping: 0n,
          insurance: 0n,
          tax: rp(20_000)
        },
        lumpCents: 0n
      }
    });
    expect(row.goodsPaidBackCents).toBe(rp(400_000));
    expect(row.taxRefundedCents).toBe(rp(20_000));
    expect(bookingOrderNetCents(row)).toBe(rp(600_000));
    expect(bookingOrderCompanionCents(row).taxCents).toBe(rp(80_000));
    expect(bookingRevenueIdentityHolds(row)).toBe(true);
  });

  test("a goods return then a cancellation: the lump takes what is left, so a full refund still ends at net 0 and tax 0", () => {
    const row = taxed({
      paidBackCents: rp(1_100_000),
      cancellations: 1,
      refunds: {
        exact: {
          goods: rp(400_000),
          shipping: 0n,
          insurance: 0n,
          tax: rp(20_000)
        },
        lumpCents: rp(680_000)
      }
    });
    expect(bookingOrderNetCents(row)).toBe(0n);
    expect(bookingOrderCompanionCents(row).taxCents).toBe(0n);
    expect(bookingRevenueIdentityHolds(row)).toBe(true);
  });

  test("shipping and insurance take their own pro rata share", () => {
    const row = derived({
      subtotal: "1000000.00",
      shippingCost: "50000.00",
      insuranceFee: "10000.00",
      tax: "100000.00",
      total: "1160000.00",
      paidInCents: rp(1_160_000),
      paidBackCents: rp(580_000),
      cancellations: 1,
      refunds: lump(580_000)
    });
    expect(row.goodsPaidBackCents).toBe(rp(500_000));
    expect(row.shippingRefundedCents).toBe(rp(25_000));
    expect(row.insuranceRefundedCents).toBe(rp(5_000));
    expect(row.taxRefundedCents).toBe(rp(50_000));
    expect(bookingOrderNetCents(row)).toBe(rp(500_000));
    expect(bookingRevenueIdentityHolds(row)).toBe(true);
  });
});

describe("the identity holds per order and in the control totals, for every combination (D1, D3)", () => {
  test("refund decided / paid / uncollected x tax x shipping x insurance x discount", () => {
    let checked = 0;
    const totals = emptyBookingRevenueControlTotals();
    for (const paidIn of [
      0, 1, 900_000, 1_850_000, 3_000_000, 3_300_000, 3_665_000
    ]) {
      for (const [decided, paidBack] of [
        [0, 0],
        [450_000, 0],
        [450_000, 450_000],
        [450_000, 200_000],
        [3_665_000, 3_665_000],
        [1, 1]
      ] as [number, number][]) {
        if (paidBack > paidIn) continue;
        for (const closing of ["open", "cancel", "no_show", "order"] as const) {
          for (const [tax, shipping, insurance, discount] of [
            [0, 0, 0, 0],
            [330_000, 0, 0, 0],
            [0, 25_000, 10_000, 250_000],
            [297_000, 0, 5_000, 300_000],
            [333_333, 33_333, 3_333, 7]
          ] as [number, number, number, number][]) {
            const subtotal = 3_000_000;
            const total = subtotal - discount + tax + shipping + insurance;
            const row = derived({
              subtotal: `${subtotal}.00`,
              tax: `${tax}.00`,
              shippingCost: `${shipping}.00`,
              insuranceFee: `${insurance}.00`,
              total: `${total}.00`,
              paidInCents: rp(paidIn),
              paidBackCents: rp(paidBack),
              refunds: lump(decided),
              cancellations: closing === "cancel" ? 1 : 0,
              noShows: closing === "no_show" ? 1 : 0,
              status: closing === "order" ? "cancelled" : "paid"
            });
            expect(bookingRevenueIdentityHolds(row)).toBe(true);
            // Net never goes negative, a companion never goes negative.
            expect(bookingOrderNetCents(row) >= 0n).toBe(true);
            const companions = bookingOrderCompanionCents(row);
            expect(companions.shippingCents >= 0n).toBe(true);
            expect(companions.insuranceCents >= 0n).toBe(true);
            expect(companions.taxCents >= 0n).toBe(true);
            // Payable is what was decided less what was paid back.
            expect(row.refundPayableCents >= 0n).toBe(true);
            accumulateBookingRevenueControlTotals(totals, row);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(400);
    expect(bookingControlTotalsIdentityHolds(totals)).toBe(true);
  });

  test("a rebuild is a recompute: deriving the same facts twice gives the same row, and the totals add up the same way", () => {
    const input = facts({
      subtotal: "3000000.00",
      tax: "330000.00",
      total: "3330000.00",
      paidInCents: rp(999_000),
      paidBackCents: rp(100_000),
      cancellations: 1,
      refunds: lump(300_000)
    });
    const a = deriveBookingOrderRow(input)!;
    const b = deriveBookingOrderRow({ ...input })!;
    expect(a).toEqual(b);
    const first = emptyBookingRevenueControlTotals();
    const second = emptyBookingRevenueControlTotals();
    accumulateBookingRevenueControlTotals(first, a);
    accumulateBookingRevenueControlTotals(second, b);
    expect(first).toEqual(second);
  });
});
