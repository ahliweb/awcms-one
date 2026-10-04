/**
 * CSV serialisation of the POS operational reports (Issue #296, ADR-0035) -
 * pure, no I/O. Every cell goes through the cash-up CSV's `csvCell`
 * (formula-neutralising: a leading `=`, `+`, `-`, `@`, tab or carriage return
 * is prefixed with a single quote, then RFC 4180 quoting) and every strictly
 * numeric amount through `csvNumber` (the one legitimate leading `-` is a
 * negative variance, and only a strictly numeric shape is exempt - anything
 * else falls back to `csvCell`). Tenant-typed free text reaches these files
 * only as an expense category's NAME and a register's code/name, which is why
 * neutralisation is not optional here.
 *
 * No customer, account, order or document id ever appears: the reports are
 * aggregates, and the cash-up file names the cashier of record by uuid only
 * (a staff stamp, never a name).
 */
import type {
  CashUpReport,
  ExpenseReport,
  LoyaltyReport,
  StoredValueReport,
  TenderReport
} from "../application/operational-report-directory";
import { csvCell, csvNumber } from "./register-cash-up-csv";

function serialise(
  columns: readonly string[],
  rows: readonly (readonly string[])[]
): string {
  return (
    [columns.join(","), ...rows.map((row) => row.join(","))].join("\r\n") +
    "\r\n"
  );
}

export const TENDER_CSV_COLUMNS = [
  "day",
  "register_code",
  "register_name",
  "tender_type",
  "payment_count",
  "payments",
  "reversal_count",
  "reversals",
  "net"
] as const;

export function serializeTenderCsv(report: TenderReport): string {
  return serialise(
    TENDER_CSV_COLUMNS,
    report.items.map((row) => [
      csvCell(row.day),
      csvCell(row.registerCode),
      csvCell(row.registerName),
      csvCell(row.tenderType),
      csvNumber(String(row.paymentCount)),
      csvNumber(row.payments),
      csvNumber(String(row.reversalCount)),
      csvNumber(row.reversals),
      csvNumber(row.net)
    ])
  );
}

export const CASH_UP_CSV_COLUMNS_V2 = [
  "day",
  "session_id",
  "register_code",
  "register_name",
  "cashier_tenant_user_id",
  "tender_type",
  "expected",
  "counted",
  "adjustment",
  "variance"
] as const;

export function serializeCashUpVarianceCsv(report: CashUpReport): string {
  return serialise(
    CASH_UP_CSV_COLUMNS_V2,
    report.items.map((row) => [
      csvCell(row.day),
      csvCell(row.sessionId),
      csvCell(row.registerCode),
      csvCell(row.registerName),
      csvCell(row.cashierTenantUserId),
      csvCell(row.tenderType),
      csvNumber(row.expected),
      csvNumber(row.counted),
      csvNumber(row.adjustment),
      csvNumber(row.variance)
    ])
  );
}

export const EXPENSE_REPORT_CSV_COLUMNS = [
  "day",
  "category_name",
  "tender_type",
  "posted_count",
  "posted",
  "reversed_count",
  "reversed",
  "net"
] as const;

export function serializeExpenseReportCsv(report: ExpenseReport): string {
  return serialise(
    EXPENSE_REPORT_CSV_COLUMNS,
    report.items.map((row) => [
      csvCell(row.day),
      csvCell(row.categoryName),
      csvCell(row.tenderType),
      csvNumber(String(row.postedCount)),
      csvNumber(row.posted),
      csvNumber(String(row.reversedCount)),
      csvNumber(row.reversed),
      csvNumber(row.net)
    ])
  );
}

export const LOYALTY_REPORT_CSV_COLUMNS = [
  "day",
  "bucket",
  "entries",
  "points"
] as const;

export function serializeLoyaltyReportCsv(report: LoyaltyReport): string {
  return serialise(
    LOYALTY_REPORT_CSV_COLUMNS,
    report.items.map((row) => [
      csvCell(row.day),
      csvCell(row.bucket),
      csvNumber(String(row.entries)),
      csvNumber(row.points)
    ])
  );
}

export const STORED_VALUE_REPORT_CSV_COLUMNS = [
  "day",
  "account_kind",
  "bucket",
  "entries",
  "amount"
] as const;

export function serializeStoredValueReportCsv(
  report: StoredValueReport
): string {
  return serialise(
    STORED_VALUE_REPORT_CSV_COLUMNS,
    report.items.map((row) => [
      csvCell(row.day),
      csvCell(row.accountKind),
      csvCell(row.bucket),
      csvNumber(String(row.entries)),
      csvNumber(row.amount)
    ])
  );
}
