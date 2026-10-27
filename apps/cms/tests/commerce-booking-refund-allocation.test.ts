/**
 * Tax-aware allocation of a booking order's refunds and uncollected balance
 * (Issue #478, metrics 3.9 D1 and D3) - PURE, integer cents. The integration
 * proof (rebuild equals live on a real database) is
 * `tests/integration/commerce-booking-revenue.integration.test.ts`.
 *
 * Cases: a full refund, a partial refund, a taxed order, shipping and insurance,
 * the rounding remainder (largest remainder, ties by component order), a
 * different currency scale (the function counts minor units, whatever they are),
 * an exact split, the cap, a surplus, and an idempotent recompute.
 */
import { describe, expect, test } from "bun:test";

import {
  ZERO_COMPONENTS,
  allocateBookingRefunds,
  bookingSurplusHeldCents,
  sumComponents,
  type BookingComponents,
  type BookingRefundAllocationInput
} from "../src/modules/commerce/domain/booking-refund-allocation";

const c = (
  goods: number,
  shipping = 0,
  insurance = 0,
  tax = 0
): BookingComponents => ({
  goods: BigInt(goods),
  shipping: BigInt(shipping),
  insurance: BigInt(insurance),
  tax: BigInt(tax)
});

function allocate(over: Partial<BookingRefundAllocationInput>) {
  return allocateBookingRefunds({
    components: c(1_000_000, 0, 0, 100_000),
    exact: ZERO_COMPONENTS,
    lumpCents: 0n,
    paidBackCents: 0n,
    paidInCents: 1_100_000n,
    uncollectedCents: 0n,
    ...over
  });
}

const total = (a: ReturnType<typeof allocate>) => ({
  refunded: sumComponents(a.paidBack) + sumComponents(a.payable),
  uncollected: sumComponents(a.uncollected)
});

describe("full and partial refunds", () => {
  test("a full refund of a taxed order takes every component to zero", () => {
    const a = allocate({ lumpCents: 1_100_000n, paidBackCents: 1_100_000n });
    expect(a.paidBack).toEqual(c(1_000_000, 0, 0, 100_000));
    expect(sumComponents(a.payable)).toBe(0n);
    expect(a.payableCents).toBe(0n);
    expect(a.decidedCents).toBe(1_100_000n);
  });

  test("a partial refund is pro rata: 550,000 of 1,100,000 is 500,000 goods and 50,000 tax", () => {
    const a = allocate({ lumpCents: 550_000n, paidBackCents: 550_000n });
    expect(a.paidBack).toEqual(c(500_000, 0, 0, 50_000));
  });

  test("no refund and nothing uncollected allocates nothing", () => {
    const a = allocate({});
    expect(total(a)).toEqual({ refunded: 0n, uncollected: 0n });
    expect(a.decidedCents).toBe(0n);
  });

  test("decided but not paid out is payable, with the same split; paying it moves cents between the two parts only", () => {
    const decided = allocate({ lumpCents: 550_000n });
    const paid = allocate({ lumpCents: 550_000n, paidBackCents: 550_000n });
    expect(decided.payable).toEqual(c(500_000, 0, 0, 50_000));
    expect(decided.payableCents).toBe(550_000n);
    expect(sumComponents(decided.paidBack)).toBe(0n);
    // goods share of paid back + payable is the same before and after.
    expect(decided.paidBack.goods + decided.payable.goods).toBe(
      paid.paidBack.goods + paid.payable.goods
    );
    expect(decided.paidBack.tax + decided.payable.tax).toBe(
      paid.paidBack.tax + paid.payable.tax
    );
  });

  test("a half-paid leg splits the decided shares between paid back and payable", () => {
    const a = allocate({ lumpCents: 550_000n, paidBackCents: 220_000n });
    expect(sumComponents(a.paidBack)).toBe(220_000n);
    expect(sumComponents(a.payable)).toBe(330_000n);
    expect(a.payableCents).toBe(330_000n);
    expect(a.paidBack.goods + a.payable.goods).toBe(500_000n);
    expect(a.paidBack.tax + a.payable.tax).toBe(50_000n);
  });
});

describe("the uncollected balance", () => {
  test("is allocated pro rata too: the taxed no-show of 3.9 leaves goods 2,100,000 and tax 231,000", () => {
    const a = allocate({
      components: c(3_000_000, 0, 0, 330_000),
      paidInCents: 999_000n,
      uncollectedCents: 2_331_000n
    });
    expect(a.uncollected).toEqual(c(2_100_000, 0, 0, 231_000));
  });

  test("a refund and an uncollected balance together never exceed a component", () => {
    const a = allocate({
      components: c(3_000_000, 0, 0, 330_000),
      paidInCents: 900_000n,
      lumpCents: 450_000n,
      paidBackCents: 450_000n,
      uncollectedCents: 2_430_000n
    });
    const goods = a.paidBack.goods + a.payable.goods + a.uncollected.goods;
    const tax = a.paidBack.tax + a.payable.tax + a.uncollected.tax;
    expect(goods <= 3_000_000n).toBe(true);
    expect(tax <= 330_000n).toBe(true);
    expect(sumComponents(a.uncollected)).toBe(2_430_000n);
  });
});

describe("shipping and insurance", () => {
  test("take their own share: 1,000,000 + 50,000 shipping + 10,000 insurance + 100,000 tax, refund 580,000", () => {
    const a = allocate({
      components: c(1_000_000, 50_000, 10_000, 100_000),
      paidInCents: 1_160_000n,
      lumpCents: 580_000n,
      paidBackCents: 580_000n
    });
    expect(a.paidBack).toEqual(c(500_000, 25_000, 5_000, 50_000));
  });
});

describe("the rounding remainder (largest remainder, ties by component order)", () => {
  test("1 cent over 4 equal components goes to goods; 2 cents to goods and shipping", () => {
    const equal = c(100, 100, 100, 100);
    const one = allocate({
      components: equal,
      paidInCents: 400n,
      lumpCents: 1n,
      paidBackCents: 1n
    });
    expect(one.paidBack).toEqual(c(1, 0, 0, 0));
    const two = allocate({
      components: equal,
      paidInCents: 400n,
      lumpCents: 2n,
      paidBackCents: 2n
    });
    expect(two.paidBack).toEqual(c(1, 1, 0, 0));
  });

  test("the shares always add up to the amount exactly, for awkward amounts and components", () => {
    const sets: BookingComponents[] = [
      c(333_333, 3_333, 333, 36_667),
      c(1, 1, 1, 1),
      c(7, 0, 0, 3),
      c(1_000_001, 0, 0, 99_999),
      c(0, 5, 0, 5)
    ];
    for (const components of sets) {
      const whole = sumComponents(components);
      for (let amount = 0n; amount <= whole; amount += whole / 13n + 1n) {
        const a = allocate({
          components,
          paidInCents: whole,
          lumpCents: amount,
          paidBackCents: amount / 2n
        });
        expect(total(a).refunded).toBe(amount);
        expect(a.payableCents).toBe(amount - amount / 2n);
        for (const part of [a.paidBack, a.payable, a.uncollected]) {
          for (const share of Object.values(part))
            expect(share >= 0n).toBe(true);
        }
        // never more than the component holds.
        expect(a.paidBack.goods + a.payable.goods <= components.goods).toBe(
          true
        );
        expect(a.paidBack.tax + a.payable.tax <= components.tax).toBe(true);
      }
    }
  });

  test("a prime amount over uneven components leaves no cent behind", () => {
    const a = allocate({
      components: c(999_983, 17, 0, 100_001),
      paidInCents: 1_100_001n,
      lumpCents: 654_321n,
      paidBackCents: 654_321n
    });
    expect(total(a).refunded).toBe(654_321n);
  });
});

describe("a currency with another scale", () => {
  // The projection is IDR-only today; the function is scale-agnostic because it
  // counts minor units. 3-decimal (KWD style) and 0-decimal (JPY style) amounts
  // allocate with the same arithmetic.
  test("three-decimal minor units: 1,000.000 goods + 100.000 tax, refund 550.000", () => {
    const a = allocate({
      components: c(1_000_000, 0, 0, 100_000),
      paidInCents: 1_100_000n,
      lumpCents: 550_000n,
      paidBackCents: 550_000n
    });
    expect(a.paidBack).toEqual(c(500_000, 0, 0, 50_000));
  });

  test("zero-decimal minor units: 1,001 goods + 99 tax, refund 7 gives 6 + 1", () => {
    const a = allocate({
      components: c(1_001, 0, 0, 99),
      paidInCents: 1_100n,
      lumpCents: 7n,
      paidBackCents: 7n
    });
    expect(total(a).refunded).toBe(7n);
    expect(a.paidBack.goods + a.paidBack.tax).toBe(7n);
  });
});

describe("an exact split wins over pro rata", () => {
  test("the record's own goods and tax are used as recorded", () => {
    const a = allocate({
      exact: c(400_000, 0, 0, 20_000),
      paidBackCents: 420_000n,
      paidInCents: 1_100_000n
    });
    expect(a.paidBack).toEqual(c(400_000, 0, 0, 20_000));
  });

  test("an exact split beyond what a component holds is clamped and the rest is spread", () => {
    const a = allocate({
      components: c(100, 0, 0, 10),
      paidInCents: 110n,
      exact: c(100, 0, 0, 30),
      paidBackCents: 110n
    });
    expect(total(a).refunded).toBe(110n);
    expect(a.paidBack).toEqual(c(100, 0, 0, 10));
  });

  test("an exact split that exceeds the cap is dropped for the cap, never allocated twice", () => {
    const a = allocate({
      components: c(1_000, 0, 0, 100),
      paidInCents: 500n,
      exact: c(900, 0, 0, 90)
    });
    expect(a.decidedCents).toBe(500n);
    expect(total(a).refunded).toBe(500n);
  });
});

describe("the cap and the surplus", () => {
  test("a refund decided beyond what came in is capped at paid in", () => {
    const a = allocate({ lumpCents: 2_000_000n, paidInCents: 900_000n });
    expect(a.decidedCents).toBe(900_000n);
    expect(a.payableCents).toBe(900_000n);
  });

  test("a reversal with no record counts as paid back, never below the ledger", () => {
    const a = allocate({ paidBackCents: 100_000n, paidInCents: 1_100_000n });
    expect(a.decidedCents).toBe(100_000n);
    expect(a.payableCents).toBe(0n);
    expect(total(a).refunded).toBe(100_000n);
  });

  test("a refund of money held above the total is not allocated to the components and leaves the surplus smaller", () => {
    const a = allocate({
      components: c(1_000, 0, 0, 0),
      paidInCents: 1_300n,
      lumpCents: 1_300n,
      paidBackCents: 1_300n
    });
    expect(total(a).refunded).toBe(1_000n);
    expect(a.decidedCents).toBe(1_300n);
    expect(bookingSurplusHeldCents(1_300n, 1_000n, 1_300n)).toBe(0n);
    expect(bookingSurplusHeldCents(1_300n, 1_000n, 0n)).toBe(300n);
    expect(bookingSurplusHeldCents(900n, 1_000n, 0n)).toBe(0n);
  });
});

describe("idempotent recompute", () => {
  test("the same facts give the same allocation, however often the sink runs", () => {
    const input: BookingRefundAllocationInput = {
      components: c(3_000_000, 25_000, 10_000, 330_000),
      exact: c(400_000, 0, 0, 40_000),
      lumpCents: 333_333n,
      paidBackCents: 500_000n,
      paidInCents: 2_000_000n,
      uncollectedCents: 1_000_000n
    };
    const first = allocateBookingRefunds(input);
    for (let i = 0; i < 5; i += 1) {
      expect(allocateBookingRefunds({ ...input })).toEqual(first);
    }
  });

  test("the input is never mutated", () => {
    const components = c(1_000_000, 0, 0, 100_000);
    const input: BookingRefundAllocationInput = {
      components,
      exact: ZERO_COMPONENTS,
      lumpCents: 550_000n,
      paidBackCents: 550_000n,
      paidInCents: 1_100_000n,
      uncollectedCents: 0n
    };
    const snapshot = JSON.stringify(input, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v
    );
    allocateBookingRefunds(input);
    expect(
      JSON.stringify(input, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v
      )
    ).toBe(snapshot);
  });
});
