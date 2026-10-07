/**
 * Returns, refunds and exchanges - the pure half (Issue #287, ADR-0033).
 * No database: the cents-exact value of a partial return, the refund plan, the
 * proportional compensations, the validators, and the sales-report netting
 * functions.
 */
import { describe, expect, test } from "bun:test";

import {
  MAX_RETURN_LINES,
  allocateOrderDiscount,
  allocateOrderTax,
  computeReturnValue,
  isReturnableOrderStatus,
  planRefundLegs,
  proportionalCents,
  proportionalPoints,
  remainingEligibleQuantity,
  sumUnitCents,
  unitValueCents,
  validateCreateReturnInput,
  validateExecuteRefundInput,
  validateLinkExchangeOrderInput,
  validateOfflineRefundInput,
  type RefundablePayment
} from "../src/modules/commerce/domain/returns";
import {
  computeSalesDailyDelta,
  computeSalesReturnCategoryDeltas,
  computeSalesReturnDailyDelta,
  computeSalesReturnProductDeltas,
  emptySalesControlTotals,
  accumulateSalesReturnControlTotals,
  netOfPriorReturns,
  resolveSalesDeltaDirection,
  type SalesOrderSnapshot,
  type SalesReturnSnapshot
} from "../src/modules/commerce/domain/sales-report-deltas";
import {
  computeRefundReversalPoints,
  computeReversalPoints,
  pointsReversedFromLot
} from "../src/modules/commerce/domain/loyalty-lots";
import type { ReplayEntry } from "../src/modules/commerce/domain/loyalty-lots";

const ITEM = "11111111-1111-4111-8111-111111111111";
const ITEM_2 = "22222222-2222-4222-8222-222222222222";

describe("per-unit decomposition", () => {
  test("units of a total add up to the total, first units carrying the leftover cents", () => {
    // 100.00 over 3 units = 33.34 + 33.33 + 33.33
    expect(unitValueCents(10000n, 3, 1)).toBe(3334n);
    expect(unitValueCents(10000n, 3, 2)).toBe(3333n);
    expect(unitValueCents(10000n, 3, 3)).toBe(3333n);
    expect(sumUnitCents(10000n, 3, 0, 3)).toBe(10000n);
  });

  test("a range sum equals the sum of its units, for every split (property)", () => {
    for (let n = 1; n <= 9; n += 1) {
      for (const total of [0n, 1n, 7n, 99n, 10001n, 123457n]) {
        let running = 0n;
        for (let from = 0; from < n; from += 1) {
          for (let count = 1; from + count <= n; count += 1) {
            let expected = 0n;
            for (let i = from + 1; i <= from + count; i += 1) {
              expected += unitValueCents(total, n, i);
            }
            expect(sumUnitCents(total, n, from, count)).toBe(expected);
          }
          running += unitValueCents(total, n, from + 1);
        }
        expect(running).toBe(total);
      }
    }
  });

  test("rejects an impossible range", () => {
    expect(() => sumUnitCents(100n, 3, 2, 2)).toThrow(RangeError);
    expect(() => sumUnitCents(100n, 0, 0, 0)).toThrow(RangeError);
  });
});

describe("order discount allocation", () => {
  test("shares sum to the discount exactly (largest remainder) and never exceed a line", () => {
    const lines = [3333n, 3333n, 3334n];
    const shares = allocateOrderDiscount(lines, 1000n);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(1000n);
    shares.forEach((share, index) => expect(share <= lines[index]!).toBe(true));
  });

  test("a discount above the subtotal is capped at the subtotal; none means zeros", () => {
    expect(allocateOrderDiscount([500n, 500n], 9999n)).toEqual([500n, 500n]);
    expect(allocateOrderDiscount([500n, 500n], 0n)).toEqual([0n, 0n]);
    expect(allocateOrderDiscount([0n, 0n], 100n)).toEqual([0n, 0n]);
  });
});

describe("tax refund decomposition (Issue #323)", () => {
  test("the order tax is allocated over line values by largest remainder and sums exactly", () => {
    const shares = allocateOrderTax([10_000n, 3_333n, 1n], 1_234n);
    expect(shares.reduce((sum, v) => sum + v, 0n)).toBe(1_234n);
    expect(allocateOrderTax([5_000n, 5_000n], 0n)).toEqual([0n, 0n]);
    expect(allocateOrderTax([5_000n, 5_000n], -50n)).toEqual([0n, 0n]);
    expect(allocateOrderTax([0n, 0n], 100n)).toEqual([0n, 0n]);
  });

  test("returns of a line in any split refund exactly the line's tax once every unit is back, and never more before", () => {
    const lineTax = 11_000n; // 110.00 over 3 units
    const parts = [1, 1, 1].map(
      (returning, index) =>
        computeReturnValue({
          lineTotalCents: 99_999n,
          lineDiscountCents: 0n,
          lineTaxCents: lineTax,
          quantity: 3,
          alreadyReturned: index,
          returning
        }).taxCents
    );
    expect(parts).toEqual([3_667n, 3_667n, 3_666n]);
    expect(parts.reduce((sum, v) => sum + v, 0n)).toBe(lineTax);

    // Splitting 1 + 2 or 2 + 1 gives the same total.
    const oneTwo =
      computeReturnValue({
        lineTotalCents: 99_999n,
        lineDiscountCents: 0n,
        lineTaxCents: lineTax,
        quantity: 3,
        alreadyReturned: 0,
        returning: 1
      }).taxCents +
      computeReturnValue({
        lineTotalCents: 99_999n,
        lineDiscountCents: 0n,
        lineTaxCents: lineTax,
        quantity: 3,
        alreadyReturned: 1,
        returning: 2
      }).taxCents;
    expect(oneTwo).toBe(lineTax);
  });

  test("no lineTaxCents means no tax refund; goods and discount are unchanged", () => {
    const value = computeReturnValue({
      lineTotalCents: 10_000n,
      lineDiscountCents: 1_000n,
      quantity: 2,
      alreadyReturned: 0,
      returning: 1
    });
    expect(value.taxCents).toBe(0n);
    expect(value.refundCents).toBe(
      value.goodsGrossCents - value.discountShareCents
    );
  });
});

describe("computeReturnValue", () => {
  test("several partial returns of one line add up to the line's value to the cent", () => {
    const base = {
      lineTotalCents: 10000n,
      lineDiscountCents: 1000n,
      quantity: 3
    };
    const first = computeReturnValue({
      ...base,
      alreadyReturned: 0,
      returning: 1
    });
    const second = computeReturnValue({
      ...base,
      alreadyReturned: 1,
      returning: 1
    });
    const third = computeReturnValue({
      ...base,
      alreadyReturned: 2,
      returning: 1
    });
    expect(
      first.goodsGrossCents + second.goodsGrossCents + third.goodsGrossCents
    ).toBe(10000n);
    expect(
      first.discountShareCents +
        second.discountShareCents +
        third.discountShareCents
    ).toBe(1000n);
    expect(first.refundCents + second.refundCents + third.refundCents).toBe(
      9000n
    );
    expect(first.refundCents).toBe(
      first.goodsGrossCents - first.discountShareCents
    );
  });

  test("the value of a return does not depend on how the units were split into returns", () => {
    const base = {
      lineTotalCents: 99999n,
      lineDiscountCents: 12345n,
      quantity: 7
    };
    const oneShot = computeReturnValue({
      ...base,
      alreadyReturned: 0,
      returning: 7
    });
    let refund = 0n;
    for (let returned = 0; returned < 7; returned += 1) {
      refund += computeReturnValue({
        ...base,
        alreadyReturned: returned,
        returning: 1
      }).refundCents;
    }
    expect(refund).toBe(oneShot.refundCents);
    expect(oneShot.refundCents).toBe(99999n - 12345n);
  });

  test("a refund is never negative, even when the discount is nearly the whole line (property)", () => {
    for (const quantity of [2, 3, 5, 7]) {
      for (const total of [100n, 101n, 997n]) {
        for (const discount of [0n, 1n, total - 1n, total]) {
          for (let before = 0; before < quantity; before += 1) {
            const value = computeReturnValue({
              lineTotalCents: total,
              lineDiscountCents: discount,
              quantity,
              alreadyReturned: before,
              returning: 1
            });
            expect(value.refundCents >= 0n).toBe(true);
            expect(value.discountShareCents >= 0n).toBe(true);
          }
        }
      }
    }
  });

  test("returning more than remains, or a non-integer, is refused", () => {
    const input = {
      lineTotalCents: 100n,
      lineDiscountCents: 0n,
      quantity: 2,
      alreadyReturned: 1
    };
    expect(() => computeReturnValue({ ...input, returning: 2 })).toThrow(
      RangeError
    );
    expect(() => computeReturnValue({ ...input, returning: 0 })).toThrow(
      RangeError
    );
    expect(() => computeReturnValue({ ...input, returning: 0.5 })).toThrow(
      RangeError
    );
    expect(remainingEligibleQuantity(5, 2)).toBe(3);
    expect(remainingEligibleQuantity(5, 9)).toBe(0);
  });

  test("only an order whose sale is paid (or beyond) is returnable", () => {
    for (const status of ["paid", "processing", "shipped", "completed"]) {
      expect(isReturnableOrderStatus(status)).toBe(true);
    }
    for (const status of [
      "pending_payment",
      "cancelled",
      "expired",
      "refunded"
    ]) {
      expect(isReturnableOrderStatus(status)).toBe(false);
    }
  });
});

function payment(
  id: string,
  amount: bigint,
  at: string,
  seq: number,
  overrides: Partial<RefundablePayment> = {}
): RefundablePayment {
  return {
    allocationId: id,
    tenderType: "cash",
    amountCents: amount,
    reversedCents: 0n,
    promisedCents: 0n,
    createdAt: at,
    entrySeq: seq,
    ...overrides
  };
}

describe("planRefundLegs", () => {
  test("goes back along the newest payment first, each capped at what it can still give", () => {
    const plan = planRefundLegs(
      [
        payment("old", 5000n, "2026-01-01T00:00:00.000Z", 1),
        payment("new", 3000n, "2026-01-02T00:00:00.000Z", 2)
      ],
      4000n
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.legs.map((l) => [l.allocationId, l.amountCents])).toEqual([
      ["new", 3000n],
      ["old", 1000n]
    ]);
  });

  test("ties on time break on the insertion sequence; reversed and promised amounts are not refundable", () => {
    const plan = planRefundLegs(
      [
        payment("a", 1000n, "2026-01-01T00:00:00.000Z", 1),
        payment("b", 1000n, "2026-01-01T00:00:00.000Z", 2, {
          reversedCents: 400n,
          promisedCents: 100n
        })
      ],
      1200n
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // b has 500 left, a has 1000; the newer (b) is used first.
    expect(plan.legs.map((l) => [l.allocationId, l.amountCents])).toEqual([
      ["b", 500n],
      ["a", 700n]
    ]);
  });

  test("more than the payments can give is refused with the refundable total, never a partial plan", () => {
    const plan = planRefundLegs(
      [
        payment("a", 1000n, "2026-01-01T00:00:00.000Z", 1, {
          reversedCents: 300n
        })
      ],
      800n
    );
    expect(plan).toEqual({ ok: false, refundableCents: 700n });
  });

  test("planning nothing is a plan of no legs", () => {
    const plan = planRefundLegs(
      [payment("a", 1000n, "2026-01-01T00:00:00.000Z", 1)],
      0n
    );
    expect(plan.ok && plan.legs).toEqual([]);
  });
});

describe("proportional compensations", () => {
  test("cumulative targets add up exactly at 100% and never exceed the amount", () => {
    const total = 7n * 100n;
    let compensated = 0n;
    let refunded = 0n;
    for (const step of [100n, 133n, 267n, 200n]) {
      refunded += step;
      const target = proportionalCents(1001n, refunded, total);
      expect(target >= compensated).toBe(true);
      compensated = target;
    }
    expect(refunded).toBe(total);
    expect(compensated).toBe(1001n);
  });

  test("zero or empty inputs compensate nothing; over-refunding caps at the amount", () => {
    expect(proportionalCents(100n, 0n, 100n)).toBe(0n);
    expect(proportionalCents(0n, 50n, 100n)).toBe(0n);
    expect(proportionalCents(100n, 50n, 0n)).toBe(0n);
    expect(proportionalCents(100n, 500n, 100n)).toBe(100n);
    expect(proportionalPoints(75, 50n, 100n)).toBe(37);
  });
});

describe("loyalty lot reversal arithmetic", () => {
  const earn: ReplayEntry = {
    id: "earn-1",
    accountSeq: 1,
    kind: "earn",
    points: 100,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: null,
    reversesEntryId: null,
    sourceId: "order-1"
  };
  const reversal = (seq: number, points: number): ReplayEntry => ({
    id: `rev-${seq}`,
    accountSeq: seq,
    kind: "reversal",
    points,
    createdAt: new Date("2026-01-02T00:00:00Z"),
    expiresAt: null,
    reversesEntryId: "earn-1",
    sourceId: "refund-x"
  });

  test("a refund takes back its proportion, then only what is left", () => {
    expect(computeRefundReversalPoints([earn], "earn-1", 50n, 100n)).toBe(50);
    const afterHalf = [earn, reversal(2, -50)];
    expect(pointsReversedFromLot(afterHalf, "earn-1")).toBe(50);
    // Cumulative 75% -> target 75, already 50 -> 25 more.
    expect(computeRefundReversalPoints(afterHalf, "earn-1", 75n, 100n)).toBe(
      25
    );
    // Fully refunded -> the rest.
    expect(computeRefundReversalPoints(afterHalf, "earn-1", 100n, 100n)).toBe(
      50
    );
    // Replaying the same cumulative figure takes back nothing more.
    const afterThreeQuarters = [...afterHalf, reversal(3, -25)];
    expect(
      computeRefundReversalPoints(afterThreeQuarters, "earn-1", 75n, 100n)
    ).toBe(0);
  });

  test("a later cancellation reverses only what the refunds left", () => {
    expect(computeReversalPoints([earn], "earn-1")).toBe(100);
    expect(computeReversalPoints([earn, reversal(2, -40)], "earn-1")).toBe(60);
    expect(computeReversalPoints([earn, reversal(2, -100)], "earn-1")).toBe(0);
  });
});

describe("validators", () => {
  const line = {
    orderItemId: ITEM,
    quantity: 2,
    reason: "defective",
    disposition: "restock"
  };

  test("a minimal valid return", () => {
    const result = validateCreateReturnInput({ lines: [line] }, "key-1");
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value.kind).toBe("return");
    expect(result.value.refund).toBeNull();
    expect(result.value.lines[0]!.note).toBeNull();
  });

  test("reason and disposition are mandatory and closed vocabularies", () => {
    for (const bad of [
      { ...line, reason: undefined },
      { ...line, reason: "whim" },
      { ...line, disposition: undefined },
      { ...line, disposition: "resell" },
      { ...line, quantity: 0 },
      { ...line, quantity: 1.5 },
      { ...line, quantity: "2" },
      { ...line, orderItemId: "nope" }
    ]) {
      expect(validateCreateReturnInput({ lines: [bad] }, "k").valid).toBe(
        false
      );
    }
  });

  test("lines: non-empty, bounded, no duplicate order line", () => {
    expect(validateCreateReturnInput({ lines: [] }, "k").valid).toBe(false);
    expect(validateCreateReturnInput({}, "k").valid).toBe(false);
    expect(validateCreateReturnInput({ lines: [line, line] }, "k").valid).toBe(
      false
    );
    const many = Array.from({ length: MAX_RETURN_LINES + 1 }, (_, i) => ({
      ...line,
      orderItemId: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`
    }));
    expect(validateCreateReturnInput({ lines: many }, "k").valid).toBe(false);
  });

  test("the Idempotency-Key is required", () => {
    expect(validateCreateReturnInput({ lines: [line] }, "").valid).toBe(false);
    expect(validateExecuteRefundInput({}, "  ").valid).toBe(false);
  });

  test("refund: destination vocabulary, money as a string, ids as UUIDs", () => {
    const base = { lines: [line] };
    expect(
      validateCreateReturnInput(
        { ...base, refund: { destination: "cash" } },
        "k"
      ).valid
    ).toBe(false);
    expect(
      validateCreateReturnInput(
        { ...base, refund: { shippingRefund: 5000 } },
        "k"
      ).valid
    ).toBe(false);
    expect(
      validateCreateReturnInput(
        { ...base, refund: { registerSessionId: "x" } },
        "k"
      ).valid
    ).toBe(false);
    expect(
      validateCreateReturnInput(
        {
          ...base,
          refund: {
            destination: "original_tender",
            storeCreditAccountId: ITEM_2
          }
        },
        "k"
      ).valid
    ).toBe(false);
    const ok = validateCreateReturnInput(
      {
        ...base,
        refund: {
          destination: "store_credit",
          shippingRefund: "5000.5",
          storeCreditAccountId: ITEM_2
        }
      },
      "k"
    );
    expect(ok.valid && ok.value.refund).toEqual({
      destination: "store_credit",
      shippingRefund: "5000.50",
      registerSessionId: null,
      storeCreditAccountId: ITEM_2
    });
  });

  test("an exchange order is valid only for an exchange", () => {
    expect(
      validateCreateReturnInput({ lines: [line], exchangeOrderId: ITEM_2 }, "k")
        .valid
    ).toBe(false);
    const ok = validateCreateReturnInput(
      { lines: [line], kind: "exchange", exchangeOrderId: ITEM_2 },
      "k"
    );
    expect(ok.valid && ok.value.exchangeOrderId).toBe(ITEM_2);
    expect(validateLinkExchangeOrderInput({ orderId: "x" }, "k").valid).toBe(
      false
    );
    expect(validateLinkExchangeOrderInput({ orderId: ITEM_2 }, "k").valid).toBe(
      true
    );
  });

  test("an offline settlement needs a stated reason", () => {
    expect(validateOfflineRefundInput({}, "k").valid).toBe(false);
    expect(validateOfflineRefundInput({ reason: "   " }, "k").valid).toBe(
      false
    );
    const ok = validateOfflineRefundInput({ reason: "Bank transfer BCA" }, "k");
    expect(ok.valid && ok.value.reason).toBe("Bank transfer BCA");
  });
});

// ---------------------------------------------------------------------------
// Sales-report netting
// ---------------------------------------------------------------------------

const ORDER: SalesOrderSnapshot = {
  orderId: "o1",
  paidAt: new Date("2026-03-01T03:00:00Z"),
  subtotal: "175000.00",
  discount: "5000.00",
  voucherDiscount: "10000.00",
  shippingCost: "20000.00",
  total: "180000.00",
  items: [
    {
      orderItemId: ITEM,
      productId: "p-kopi",
      productName: "Kopi",
      quantity: 3,
      lineTotal: "150000.00",
      categoryId: "c1",
      categoryName: "Kopi"
    },
    {
      orderItemId: ITEM_2,
      productId: "p-gula",
      productName: "Gula",
      quantity: 1,
      lineTotal: "25000.00",
      categoryId: null,
      categoryName: null
    }
  ]
};

const RETURN: SalesReturnSnapshot = {
  returnId: "r1",
  orderId: "o1",
  paidAt: ORDER.paidAt,
  goodsGross: "50000.00",
  discountShare: "5000.00",
  shippingRefund: "2000.00",
  refundTotal: "47000.00",
  lines: [
    {
      productId: "p-kopi",
      productName: "Kopi",
      quantity: 1,
      goodsGross: "50000.00",
      categoryId: "c1",
      categoryName: "Kopi"
    }
  ]
};

describe("sales-report netting", () => {
  test("a `returned` row is not a status transition", () => {
    expect(
      resolveSalesDeltaDirection({ fromStatus: "paid", toStatus: "returned" })
    ).toBe(0);
  });

  test("a return subtracts goods, discount, shipping and money; it removes no paid order", () => {
    const daily = computeSalesReturnDailyDelta(RETURN, "2026-03-01");
    expect(daily).toEqual({
      day: "2026-03-01",
      ordersPaid: 0,
      grossCents: -5000000n,
      discountCents: -500000n,
      shippingCents: -200000n,
      netCents: -4700000n
    });
    expect(computeSalesReturnProductDeltas(RETURN, "d")).toEqual([
      {
        day: "d",
        productId: "p-kopi",
        productName: "Kopi",
        qty: -1,
        grossCents: -5000000n
      }
    ]);
    expect(computeSalesReturnCategoryDeltas(RETURN, "d")[0]!.qty).toBe(-1);
  });

  test("paid + return + (cancel netted over the return) = nothing left", () => {
    const paid = computeSalesDailyDelta(ORDER, 1, "d")!;
    const ret = computeSalesReturnDailyDelta(RETURN, "d");
    const netted = netOfPriorReturns(ORDER, {
      goodsGrossCents: 5000000n,
      discountShareCents: 500000n,
      shippingRefundCents: 200000n,
      refundTotalCents: 4700000n,
      byItem: new Map([[ITEM, { quantity: 1, goodsGrossCents: 5000000n }]])
    });
    const cancel = computeSalesDailyDelta(netted, -1, "d")!;
    expect(paid.grossCents + ret.grossCents + cancel.grossCents).toBe(0n);
    expect(paid.discountCents + ret.discountCents + cancel.discountCents).toBe(
      0n
    );
    expect(paid.shippingCents + ret.shippingCents + cancel.shippingCents).toBe(
      0n
    );
    expect(paid.netCents + ret.netCents + cancel.netCents).toBe(0n);
    expect(paid.ordersPaid + ret.ordersPaid + cancel.ordersPaid).toBe(0);
    // And the per-item quantities.
    expect(netted.items[0]!.quantity).toBe(2);
    expect(netted.items[0]!.lineTotal).toBe("100000.00");
    expect(netted.items[1]).toEqual(ORDER.items[1]!);
  });

  test("netting never produces a negative figure", () => {
    const netted = netOfPriorReturns(ORDER, {
      goodsGrossCents: 99999999n,
      discountShareCents: 99999999n,
      shippingRefundCents: 99999999n,
      refundTotalCents: 99999999n,
      byItem: new Map()
    });
    for (const field of [
      netted.subtotal,
      netted.discount,
      netted.voucherDiscount,
      netted.shippingCost,
      netted.total
    ]) {
      expect(field.startsWith("-")).toBe(false);
    }
  });

  test("control totals fold a return the same way the sinks do", () => {
    const totals = emptySalesControlTotals();
    accumulateSalesReturnControlTotals(totals, RETURN, "d");
    expect(totals.grossCents).toBe(-5000000n);
    expect(totals.netCents).toBe(-4700000n);
    expect(totals.itemQty).toBe(-1);
    expect(totals.itemGrossCents).toBe(-5000000n);
    expect(totals.ordersPaid).toBe(0);
  });
});
