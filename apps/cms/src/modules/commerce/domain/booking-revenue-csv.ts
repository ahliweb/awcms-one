/**
 * CSV serialisation of the booking revenue waterfall (Issue #478, metrics
 * 3.9 D4) - pure, no I/O. One row per Asia/Jakarta paid day, with the SAME figures
 * as the screen: gross, discounts, the Refunds step with its three parts, net,
 * the three companion columns (each after its refunded share), the balance
 * outstanding, the refund payable, the stay and no-show figures and the
 * restatement flag. Every cell goes through the shared `csvCellForWrite`
 * (formula neutralising: a leading `=`, `+`, `-`, `@`, tab or carriage return is
 * defused) and strictly numeric ones through `numericText`, exactly as the other
 * report exports do. The file is AGGREGATES per day - never an order id, customer,
 * name or contact - and it is the paid-day (attribution) view: the cash view by
 * refund day is its own route and file (`booking-revenue-cash`).
 *
 * The first column is `basis`, always `paid_day`, so a file that finance merges
 * with a cash export cannot be read as the same thing.
 */
import { csvCellForWrite } from "../../../lib/security/csv-formula";
import type { BookingRevenueReport } from "../application/booking-revenue-report";

export const BOOKING_REVENUE_CSV_COLUMNS = [
  "basis",
  "day",
  "orders",
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
  "stays",
  "no_shows",
  "no_show_retained",
  "no_show_rate_percent",
  "restated",
  "restated_at"
] as const;

export function serializeBookingRevenueCsv(
  report: BookingRevenueReport
): string {
  const rows = report.days.map((day) =>
    [
      csvCellForWrite(report.basis),
      csvCellForWrite(day.day),
      csvCellForWrite(day.orders, { numericText: true }),
      csvCellForWrite(day.gross, { numericText: true }),
      csvCellForWrite(day.discounts, { numericText: true }),
      csvCellForWrite(day.refunds, { numericText: true }),
      csvCellForWrite(day.refundsPaidBack, { numericText: true }),
      csvCellForWrite(day.refundsPayable, { numericText: true }),
      csvCellForWrite(day.refundsUncollected, { numericText: true }),
      csvCellForWrite(day.net, { numericText: true }),
      csvCellForWrite(day.shipping, { numericText: true }),
      csvCellForWrite(day.insurance, { numericText: true }),
      csvCellForWrite(day.tax, { numericText: true }),
      csvCellForWrite(day.balanceOutstanding, { numericText: true }),
      csvCellForWrite(day.refundPayableBalance, { numericText: true }),
      csvCellForWrite(day.stays, { numericText: true }),
      csvCellForWrite(day.noShows, { numericText: true }),
      csvCellForWrite(day.noShowRetained, { numericText: true }),
      csvCellForWrite(day.noShowRatePercent, { numericText: true }),
      csvCellForWrite(day.restated ? "true" : "false"),
      csvCellForWrite(day.restatedAt)
    ].join(",")
  );
  return (
    [
      BOOKING_REVENUE_CSV_COLUMNS.map((column) => csvCellForWrite(column)).join(
        ","
      ),
      ...rows
    ].join("\r\n") + "\r\n"
  );
}
