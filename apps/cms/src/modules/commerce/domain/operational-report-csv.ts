/**
 * CSV serialisation of the POS operational reports (Issue #296, ADR-0035; #316) -
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
  ReturnsReport,
  StoredValueReport,
  TenderReport
} from "../application/operational-report-directory";
import { csvCellForWrite } from "../../../lib/security/csv-formula";

/** One cell before it is written: raw, and whether it is a `numeric(14,2)` figure carried as text. */
type Cell = { value: string | null | undefined; numeric: boolean };

const text = (value: string | null | undefined): Cell => ({
  value,
  numeric: false
});
const num = (value: string | null | undefined): Cell => ({
  value,
  numeric: true
});

function serialise(
  columns: readonly string[],
  rows: readonly (readonly Cell[])[]
): string {
  return (
    [
      columns.map((column) => csvCellForWrite(column)).join(","),
      ...rows.map((row) =>
        row
          .map((cell) =>
            csvCellForWrite(cell.value, { numericText: cell.numeric })
          )
          .join(",")
      )
    ].join("\r\n") + "\r\n"
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
      text(row.day),
      text(row.registerCode),
      text(row.registerName),
      text(row.tenderType),
      num(String(row.paymentCount)),
      num(row.payments),
      num(String(row.reversalCount)),
      num(row.reversals),
      num(row.net)
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
      text(row.day),
      text(row.sessionId),
      text(row.registerCode),
      text(row.registerName),
      text(row.cashierTenantUserId),
      text(row.tenderType),
      num(row.expected),
      num(row.counted),
      num(row.adjustment),
      num(row.variance)
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
      text(row.day),
      text(row.categoryName),
      text(row.tenderType),
      num(String(row.postedCount)),
      num(row.posted),
      num(String(row.reversedCount)),
      num(row.reversed),
      num(row.net)
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
      text(row.day),
      text(row.bucket),
      num(String(row.entries)),
      num(row.points)
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
      text(row.day),
      text(row.accountKind),
      text(row.bucket),
      num(String(row.entries)),
      num(row.amount)
    ])
  );
}

/** One long file: `section` says what `bucket`/`detail`/`count`/`units`/`amount` mean on that row (see sql/945). */
export const RETURNS_REPORT_CSV_COLUMNS = [
  "day",
  "register_code",
  "register_name",
  "section",
  "bucket",
  "detail",
  "count",
  "units",
  "amount"
] as const;

export function serializeReturnsReportCsv(report: ReturnsReport): string {
  return serialise(
    RETURNS_REPORT_CSV_COLUMNS,
    report.items.map((row) => [
      text(row.day),
      text(row.registerCode),
      text(row.registerName),
      text(row.section),
      text(row.bucket),
      text(row.detail),
      num(String(row.count)),
      num(String(row.units)),
      num(row.amount)
    ])
  );
}
