/**
 * Sales-report delta rules and query validation (Issue #117, contract #106 /
 * ADR-0017 D7) — pure, no database. Pins the rules the three
 * `commerce.sales_*` projections are built on: `-> paid` adds, `-> cancelled`
 * / `-> refunded` after a paid state subtracts, everything else is a no-op;
 * the add and the subtract of one order are exact negatives; day attribution
 * follows `paid_at` in the report time zone; signed cents render as a
 * `numeric(14,2)` string.
 */
import { describe, expect, test } from "bun:test";

import {
  accumulateSalesControlTotals,
  computeSalesByCategoryDeltas,
  computeSalesByProductDeltas,
  computeSalesDailyDelta,
  emptySalesControlTotals,
  formatCentsDelta,
  resolveSalesAttributionDay,
  resolveSalesDeltaDirection,
  resolveSalesReportDay,
  SALES_REPORT_UNCATEGORISED_ID,
  SALES_REPORT_UNCATEGORISED_NAME,
  type SalesOrderEvent,
  type SalesOrderSnapshot
} from "../src/modules/commerce/domain/sales-report-deltas";
import {
  DEFAULT_SALES_BY_PRODUCT_LIMIT,
  DEFAULT_SALES_REPORT_RANGE_DAYS,
  MAX_SALES_REPORT_RANGE_DAYS,
  validateSalesByProductLimit,
  validateSalesReportRange
} from "../src/modules/commerce/domain/sales-report-query";
import type { ProjectionCursorStream } from "../src/modules/_shared/module-contract";
import { validateProjectionRegistry } from "../src/modules/reporting/domain/projection-registry";
import { commerceModule } from "../src/modules/commerce/module";

const ORDER: SalesOrderSnapshot = {
  orderId: "11111111-1111-4111-8111-111111111111",
  // 2026-09-18 23:30 UTC is 2026-09-19 06:30 WIB — the day must follow WIB.
  paidAt: new Date("2026-09-18T23:30:00Z"),
  subtotal: "150000.00",
  discount: "5000.00",
  voucherDiscount: "10000.00",
  shippingCost: "20000.00",
  total: "155000.00",
  items: [
    {
      productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      productName: "Kopi Arabika 250g",
      quantity: 2,
      lineTotal: "100000.00",
      categoryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      categoryName: "Kopi"
    },
    {
      productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      productName: "Kopi Arabika 250g",
      quantity: 1,
      lineTotal: "25000.00",
      categoryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      categoryName: "Kopi"
    },
    {
      productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      productName: "Gula Aren",
      quantity: 1,
      lineTotal: "25000.00",
      categoryId: null,
      categoryName: null
    }
  ]
};

function event(
  fromStatus: string | null,
  toStatus: string,
  createdAt = new Date("2026-09-19T01:00:00Z")
): SalesOrderEvent {
  return { orderId: ORDER.orderId, fromStatus, toStatus, createdAt };
}

describe("resolveSalesDeltaDirection", () => {
  test("pending_payment -> paid adds", () => {
    expect(resolveSalesDeltaDirection(event("pending_payment", "paid"))).toBe(
      1
    );
  });

  test("cancelled / refunded after a paid state subtracts", () => {
    expect(resolveSalesDeltaDirection(event("paid", "cancelled"))).toBe(-1);
    expect(resolveSalesDeltaDirection(event("processing", "cancelled"))).toBe(
      -1
    );
    expect(resolveSalesDeltaDirection(event("paid", "refunded"))).toBe(-1);
    expect(resolveSalesDeltaDirection(event("completed", "refunded"))).toBe(-1);
  });

  test("a cancellation or expiry of an order that was never paid contributes nothing", () => {
    expect(
      resolveSalesDeltaDirection(event("pending_payment", "cancelled"))
    ).toBe(0);
    expect(
      resolveSalesDeltaDirection(event("pending_payment", "expired"))
    ).toBe(0);
  });

  test("creation and fulfilment steps contribute nothing", () => {
    expect(resolveSalesDeltaDirection(event(null, "pending_payment"))).toBe(0);
    expect(resolveSalesDeltaDirection(event("paid", "processing"))).toBe(0);
    expect(resolveSalesDeltaDirection(event("processing", "shipped"))).toBe(0);
    expect(resolveSalesDeltaDirection(event("shipped", "completed"))).toBe(0);
  });

  test("a refund after a cancellation never subtracts twice, and a second paid event never adds twice", () => {
    expect(resolveSalesDeltaDirection(event("cancelled", "refunded"))).toBe(0);
    expect(resolveSalesDeltaDirection(event("paid", "paid"))).toBe(0);
  });
});

describe("day attribution", () => {
  test("buckets in the report time zone (WIB), not UTC", () => {
    expect(resolveSalesReportDay(new Date("2026-09-18T23:30:00Z"))).toBe(
      "2026-09-19"
    );
    expect(resolveSalesReportDay(new Date("2026-09-18T16:59:59Z"))).toBe(
      "2026-09-18"
    );
  });

  test("follows paid_at, so a later reversal lands on the payment's day", () => {
    const reversal = event(
      "paid",
      "cancelled",
      new Date("2026-09-25T10:00:00Z")
    );
    expect(resolveSalesAttributionDay(ORDER, reversal)).toBe("2026-09-19");
  });

  test("falls back to the event's own timestamp when paid_at is missing", () => {
    expect(
      resolveSalesAttributionDay(
        { paidAt: null },
        event("pending_payment", "paid", new Date("2026-09-20T02:00:00Z"))
      )
    ).toBe("2026-09-20");
  });
});

describe("delta computation", () => {
  test("paid adds the order header figures in cents", () => {
    const delta = computeSalesDailyDelta(ORDER, 1, "2026-09-19")!;
    expect(delta).toEqual({
      day: "2026-09-19",
      ordersPaid: 1,
      grossCents: 15_000_000n,
      discountCents: 1_500_000n,
      shippingCents: 2_000_000n,
      netCents: 15_500_000n
    });
  });

  test("cancel after paid is the exact negative of the add", () => {
    const add = computeSalesDailyDelta(ORDER, 1, "2026-09-19")!;
    const subtract = computeSalesDailyDelta(ORDER, -1, "2026-09-19")!;
    expect(subtract.ordersPaid).toBe(-add.ordersPaid);
    expect(subtract.grossCents).toBe(-add.grossCents);
    expect(subtract.discountCents).toBe(-add.discountCents);
    expect(subtract.shippingCents).toBe(-add.shippingCents);
    expect(subtract.netCents).toBe(-add.netCents);
  });

  test("direction 0 yields nothing for all three projections", () => {
    expect(computeSalesDailyDelta(ORDER, 0, "2026-09-19")).toBeNull();
    expect(computeSalesByProductDeltas(ORDER, 0, "2026-09-19")).toEqual([]);
    expect(computeSalesByCategoryDeltas(ORDER, 0, "2026-09-19")).toEqual([]);
  });

  test("by-product folds two lines of the same product into one row", () => {
    const lines = computeSalesByProductDeltas(ORDER, 1, "2026-09-19");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      day: "2026-09-19",
      productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      productName: "Kopi Arabika 250g",
      qty: 3,
      grossCents: 12_500_000n
    });
    expect(lines[1]!.qty).toBe(1);
    expect(lines[1]!.grossCents).toBe(2_500_000n);
  });

  test("by-category sends an uncategorised product to the sentinel bucket", () => {
    const lines = computeSalesByCategoryDeltas(ORDER, -1, "2026-09-19");
    expect(lines).toEqual([
      {
        day: "2026-09-19",
        categoryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        categoryName: "Kopi",
        qty: -3,
        grossCents: -12_500_000n
      },
      {
        day: "2026-09-19",
        categoryId: SALES_REPORT_UNCATEGORISED_ID,
        categoryName: SALES_REPORT_UNCATEGORISED_NAME,
        qty: -1,
        grossCents: -2_500_000n
      }
    ]);
  });

  test("control totals over paid then cancelled net to zero; paid alone equals the add", () => {
    const paidOnly = accumulateSalesControlTotals(
      emptySalesControlTotals(),
      event("pending_payment", "paid"),
      ORDER
    );
    expect(paidOnly.ordersPaid).toBe(1);
    expect(paidOnly.netCents).toBe(15_500_000n);
    expect(paidOnly.itemQty).toBe(4);
    expect(paidOnly.itemGrossCents).toBe(15_000_000n);

    const netted = accumulateSalesControlTotals(
      paidOnly,
      event("paid", "cancelled"),
      ORDER
    );
    expect(netted).toEqual(emptySalesControlTotals());
  });
});

describe("formatCentsDelta", () => {
  test("renders signed numeric(14,2) strings", () => {
    expect(formatCentsDelta(0n)).toBe("0.00");
    expect(formatCentsDelta(150n)).toBe("1.50");
    expect(formatCentsDelta(-150n)).toBe("-1.50");
    expect(formatCentsDelta(-5n)).toBe("-0.05");
    expect(formatCentsDelta(15_500_000n)).toBe("155000.00");
  });
});

describe("validateSalesReportRange", () => {
  const now = new Date("2026-09-19T05:00:00Z"); // 12:00 WIB, 2026-09-19

  test("defaults to the last 30 report-zone days ending today", () => {
    const result = validateSalesReportRange({}, now);
    expect(result).toEqual({
      valid: true,
      value: { from: "2026-08-21", to: "2026-09-19" }
    });
    expect(DEFAULT_SALES_REPORT_RANGE_DAYS).toBe(30);
  });

  test("rejects malformed and impossible dates", () => {
    expect(validateSalesReportRange({ from: "2026-9-1" }, now).valid).toBe(
      false
    );
    expect(validateSalesReportRange({ to: "2026-02-30" }, now).valid).toBe(
      false
    );
  });

  test("rejects from after to, and a range beyond the maximum", () => {
    const inverted = validateSalesReportRange(
      { from: "2026-09-20", to: "2026-09-19" },
      now
    );
    expect(inverted.valid).toBe(false);

    const tooLong = validateSalesReportRange(
      { from: "2025-01-01", to: "2026-09-19" },
      now
    );
    expect(tooLong.valid).toBe(false);
    expect(MAX_SALES_REPORT_RANGE_DAYS).toBe(366);
  });

  test("a single day is a valid range", () => {
    expect(
      validateSalesReportRange({ from: "2026-09-19", to: "2026-09-19" }, now)
    ).toEqual({ valid: true, value: { from: "2026-09-19", to: "2026-09-19" } });
  });
});

describe("validateSalesByProductLimit", () => {
  test("defaults, bounds, and rejects garbage", () => {
    expect(validateSalesByProductLimit(undefined)).toEqual({
      valid: true,
      value: DEFAULT_SALES_BY_PRODUCT_LIMIT
    });
    expect(validateSalesByProductLimit("50")).toEqual({
      valid: true,
      value: 50
    });
    expect(validateSalesByProductLimit("0").valid).toBe(false);
    expect(validateSalesByProductLimit("201").valid).toBe(false);
    expect(validateSalesByProductLimit("ten").valid).toBe(false);
  });
});

describe("registry pairing of dimensional sinks and hooks (Issue #117)", () => {
  test("the three commerce descriptors validate as registered", () => {
    const result = validateProjectionRegistry([commerceModule]);
    expect(result.issues).toEqual([]);
    expect(result.descriptors.map((descriptor) => descriptor.key)).toEqual([
      "commerce.sales_daily",
      "commerce.sales_by_product",
      "commerce.sales_by_category"
    ]);
  });

  test("a stream with a sink but no descriptor-level contract is refused, and vice versa", () => {
    const [daily] = commerceModule.reportingProjections!;
    const { dimensional: _dropped, ...withoutContract } = daily!;

    const missingContract = validateProjectionRegistry([
      { ...commerceModule, reportingProjections: [withoutContract] }
    ]);
    expect(
      missingContract.issues.some((issue) =>
        issue.message.includes("must also declare `dimensional`")
      )
    ).toBe(true);

    const stripSink = (
      stream: ProjectionCursorStream
    ): ProjectionCursorStream => {
      const { dimensional: _sink, ...rest } = stream;
      return rest;
    };
    const sinkless = validateProjectionRegistry([
      {
        ...commerceModule,
        reportingProjections: [
          {
            ...daily!,
            source: {
              strategy: "cursor_table",
              streams: (daily!.source.strategy === "cursor_table"
                ? daily!.source.streams
                : []
              ).map(stripSink)
            },
            rebuildSource: {
              streams: daily!.rebuildSource.streams.map(stripSink)
            }
          }
        ]
      }
    ]);
    expect(
      sinkless.issues.some((issue) =>
        issue.message.includes("no source/rebuildSource stream declares")
      )
    ).toBe(true);
  });
});
