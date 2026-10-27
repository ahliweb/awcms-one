/**
 * The booking revenue waterfall CSV (Issue #478, metrics 3.9 D4) - PURE.
 * Columns match the screen, every cell goes through the formula-neutralising
 * writer, the file is aggregates only, and the paid-day basis is stated in the
 * first column. The route (permission, `enabled: false`, audit) is
 * `tests/integration/commerce-booking-revenue-routes.integration.test.ts`.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import type {
  BookingRevenueDay,
  BookingRevenueReport
} from "../src/modules/commerce/application/booking-revenue-report";
import {
  BOOKING_REVENUE_CSV_COLUMNS,
  serializeBookingRevenueCsv
} from "../src/modules/commerce/domain/booking-revenue-csv";
import {
  addBookingRevenueDaySums,
  deriveBookingOrderRow,
  bookingOrderDaySums,
  emptyBookingRevenueDaySums,
  shapeBookingRevenueFigures,
  NO_DECIDED_REFUNDS
} from "../src/modules/commerce/domain/booking-revenue";

const rp = (amount: number) => BigInt(amount) * 100n;

function dayFor(day: string, restated: boolean): BookingRevenueDay {
  const row = deriveBookingOrderRow({
    orderId: "o",
    sourceKind: "reservation",
    paidAt: new Date("2026-10-01T03:00:00Z"),
    status: "paid",
    subtotal: "3000000.00",
    shippingCost: "0.00",
    insuranceFee: "0.00",
    tax: "330000.00",
    total: "3330000.00",
    paidInCents: rp(999_000),
    paidBackCents: 0n,
    refunds: NO_DECIDED_REFUNDS,
    stays: 1,
    noShows: 1,
    noShowRetainedCents: rp(999_000),
    cancellations: 0
  })!;
  const sums = emptyBookingRevenueDaySums();
  addBookingRevenueDaySums(sums, bookingOrderDaySums(row));
  return {
    day,
    ...shapeBookingRevenueFigures(sums),
    restated,
    restatedAt: restated ? "2026-11-20T01:02:03.000Z" : null
  };
}

function report(days: BookingRevenueDay[]): BookingRevenueReport {
  return {
    enabled: true,
    basis: "paid_day",
    timeZone: "Asia/Jakarta",
    restatementWindowDays: 35,
    asOf: "2026-11-30T00:00:00.000Z",
    from: "2026-10-01",
    to: "2026-10-31",
    currency: "IDR",
    days,
    totals: shapeBookingRevenueFigures(emptyBookingRevenueDaySums())
  };
}

describe("serializeBookingRevenueCsv", () => {
  test("a header row with the screen's columns, then one row per day, CRLF terminated", () => {
    const csv = serializeBookingRevenueCsv(
      report([dayFor("2026-10-01", false), dayFor("2026-10-02", true)])
    );
    const lines = csv.split("\r\n");
    expect(lines.at(-1)).toBe("");
    expect(lines[0]).toBe(BOOKING_REVENUE_CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(4);
    for (const column of [
      "gross",
      "discounts",
      "refunds",
      "refunds_paid_back",
      "refunds_payable",
      "refunds_uncollected",
      "net",
      "shipping",
      "insurance",
      "tax",
      "balance_outstanding",
      "refund_payable_balance",
      "restated"
    ]) {
      expect(BOOKING_REVENUE_CSV_COLUMNS).toContain(column as never);
    }
  });

  test("the taxed no-show row reads gross 3,000,000, refunds 2,100,000 (uncollected), net 900,000, tax 99,000", () => {
    const csv = serializeBookingRevenueCsv(
      report([dayFor("2026-10-01", false)])
    );
    const [header, row] = csv.split("\r\n") as [string, string];
    const cells = Object.fromEntries(
      header.split(",").map((name, index) => [name, row.split(",")[index]])
    );
    expect(cells.basis).toBe("paid_day");
    expect(cells.day).toBe("2026-10-01");
    expect(cells.gross).toBe("3000000.00");
    expect(cells.refunds).toBe("2100000.00");
    expect(cells.refunds_uncollected).toBe("2100000.00");
    expect(cells.refunds_paid_back).toBe("0.00");
    expect(cells.refunds_payable).toBe("0.00");
    expect(cells.net).toBe("900000.00");
    expect(cells.tax).toBe("99000.00");
    expect(cells.restated).toBe("false");
    expect(cells.restated_at).toBe("");
  });

  test("the restatement flag and instant are written for a restated day", () => {
    const csv = serializeBookingRevenueCsv(
      report([dayFor("2026-10-02", true)])
    );
    expect(csv).toContain(",true,2026-11-20T01:02:03.000Z\r\n");
  });

  test("a feature-off report is the header row only", () => {
    const csv = serializeBookingRevenueCsv({ ...report([]), enabled: false });
    expect(csv).toBe(`${BOOKING_REVENUE_CSV_COLUMNS.join(",")}\r\n`);
  });

  test("a text cell that could be read as a formula is neutralised; a signed figure is not", () => {
    const hostile = {
      ...dayFor('=HYPERLINK("http://evil.example","x")', false),
      restatedAt: "@SUM(1+1)"
    };
    const csv = serializeBookingRevenueCsv(report([hostile]));
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(csv).toContain(",'@SUM(1+1)\r\n");
    const negative = { ...dayFor("2026-10-03", false), net: "-5.50" };
    expect(serializeBookingRevenueCsv(report([negative]))).toContain(",-5.50,");
  });

  test("no order, customer or contact column exists in the file", () => {
    for (const column of BOOKING_REVENUE_CSV_COLUMNS) {
      expect(column).not.toMatch(/order_id|customer|phone|email|name|contact/);
    }
  });
});

describe("the CSV is gated on its own export permission (Issue #478, sql/1062)", () => {
  test("the route authorises commerce.report_booking_revenue.export, not reporting.dashboard.read", async () => {
    const source = await readFile(
      "src/pages/api/v1/reports/commerce/booking-revenue.csv.ts",
      "utf8"
    );
    expect(source).toContain('moduleKey: "commerce"');
    expect(source).toContain(
      "activityCode: COMMERCE_REPORT_BOOKING_REVENUE_ACTIVITY_CODE"
    );
    expect(source).toContain('action: "export"');
    expect(source).not.toContain('activityCode: "dashboard"');
  });

  test("the key is declared by the module and seeded by the migration", async () => {
    const { commerceModule } = await import("../src/modules/commerce/module");
    const declared = (commerceModule.permissions ?? []).some(
      (p) =>
        p.activityCode === "report_booking_revenue" && p.action === "export"
    );
    expect(declared).toBe(true);
    const sql = await readFile(
      "sql/1062_awcms_commerce_booking_revenue_export_permission.sql",
      "utf8"
    );
    expect(sql).toContain("'commerce', 'report_booking_revenue', 'export'");
  });
});
