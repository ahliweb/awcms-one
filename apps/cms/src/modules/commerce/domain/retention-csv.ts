/**
 * CSV serialisation of the customer-retention report (Issue #364, ADR-0044) -
 * pure, no I/O. Cells go through the cash-up CSV's `csvCell` (formula
 * neutralising) and strictly numeric ones through `csvNumber`, exactly as the
 * POS operational reports do. The file is cohort AGGREGATES: month, counts and
 * a rate - never a customer id, name, contact or order. A cohort under the
 * small-number threshold carries an empty `retention_percent` (counts only),
 * so the export cannot be used to read a rate the screen withholds.
 */
import { csvCellForWrite } from "../../../lib/security/csv-formula";
import type { RetentionReport } from "../application/retention-report-directory";

export const RETENTION_CSV_COLUMNS = [
  "cohort_month",
  "customers",
  "repeaters_within_90_days",
  "retention_percent",
  "status",
  "matures_at",
  "restated_at"
] as const;

export function serializeRetentionReportCsv(report: RetentionReport): string {
  const rows = report.cohorts.map((cohort) =>
    [
      csvCellForWrite(cohort.cohortMonth),
      csvCellForWrite(String(cohort.size), { numericText: true }),
      csvCellForWrite(String(cohort.repeaters), { numericText: true }),
      csvCellForWrite(cohort.ratePercent, { numericText: true }),
      csvCellForWrite(cohort.mature ? "final" : "to_date"),
      csvCellForWrite(cohort.maturesAt),
      csvCellForWrite(cohort.restatedAt)
    ].join(",")
  );
  return (
    [
      RETENTION_CSV_COLUMNS.map((column) => csvCellForWrite(column)).join(","),
      ...rows
    ].join("\r\n") + "\r\n"
  );
}
