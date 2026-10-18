/**
 * The cash-up CSV (Issue #284, ADR-0028) — pure serialisation, no I/O.
 *
 * ## Formula injection
 *
 * A spreadsheet treats a cell that starts with `=`, `+`, `-`, `@`, a tab or a
 * carriage return as a FORMULA. Several cells here are tenant-typed free text
 * (a movement's reference and note, the variance reason, a correction's
 * reason), so {@link csvCell} neutralises every one: a cell whose first
 * character is one of those is prefixed with a single quote, which every major
 * spreadsheet renders as literal text. Quoting for `,` `"` and line breaks is
 * applied on top. A SIGNED AMOUNT is the one legitimate leading `-` (a
 * negative variance): amounts are passed through {@link csvNumber}, which
 * accepts only a strict numeric shape and is therefore never neutralised —
 * anything that is not strictly numeric goes through {@link csvCell} instead,
 * so a "number" column can never smuggle a formula.
 *
 * One file, one section per `section` column value, so the whole cash-up of a
 * session reads top to bottom in a spreadsheet and is unambiguous to a parser:
 * `summary`, `tender`, `movement`, `correction`.
 */
import { csvCellForWrite } from "../../../lib/security/csv-formula";
import type { RegisterCashUpReport } from "./register";

/**
 * One CSV cell of arbitrary text: formula-neutralised, then quoted if it needs
 * it. The rule lives in the shared writer (`csvCellForWrite`, issue #978); this
 * is the name the commerce tests and callers know it by.
 */
export function csvCell(
  value: string | number | boolean | null | undefined
): string {
  return csvCellForWrite(value);
}

/** A strictly numeric cell (a `numeric(14,2)` string): never neutralised, never free text. */
export function csvNumber(value: string | null | undefined): string {
  return csvCellForWrite(value, { numericText: true });
}

export const CASH_UP_CSV_COLUMNS = [
  "section",
  "key",
  "tender",
  "amount",
  "expected",
  "counted",
  "variance",
  "count",
  "at",
  "actor",
  "text"
] as const;

type Row = Partial<
  Record<(typeof CASH_UP_CSV_COLUMNS)[number], string | null | undefined>
>;

/** The columns that carry a `numeric(14,2)` figure as text; every other cell is free text. */
const NUMERIC_COLUMNS: ReadonlySet<string> = new Set([
  "amount",
  "expected",
  "counted",
  "variance"
]);

/** Cells are RAW values here: the one escape happens in this function, never twice. */
function line(row: Row): string {
  return CASH_UP_CSV_COLUMNS.map((column) =>
    csvCellForWrite(row[column], { numericText: NUMERIC_COLUMNS.has(column) })
  ).join(",");
}

/**
 * Serialises a session's cash-up report. Reads only fields the report already
 * carries (no customer name/phone ever appears: a sale is a count and a
 * total here, never a person).
 */
export function serializeCashUpCsv(report: RegisterCashUpReport): string {
  const lines: string[] = [
    CASH_UP_CSV_COLUMNS.map((column) => csvCellForWrite(column)).join(",")
  ];

  const summary = (
    key: string,
    amount: string | null,
    text?: string | null
  ): void => {
    lines.push(
      line({
        section: "summary",
        key: key,
        amount: amount,
        text: text ?? null
      })
    );
  };
  summary("register_code", null, report.register.code);
  summary("register_name", null, report.register.name);
  summary("session_id", null, report.session.id);
  summary("status", null, report.session.status);
  summary("opened_at", null, report.session.openedAt);
  summary("closed_at", null, report.session.closedAt);
  summary("opening_float", report.openingFloat);
  summary("sales_count", String(report.sales.count));
  summary("sales_total", report.sales.total);
  summary("movements_in", report.movementTotals.in);
  summary("movements_out", report.movementTotals.out);
  summary("variance_total", report.variance?.total ?? null);
  summary("variance_gross", report.variance?.gross ?? null);
  summary("variance_reason", null, report.variance?.reason ?? null);
  summary("approval_threshold", report.variance?.approvalThreshold ?? null);
  summary("approval_decision", null, report.variance?.decision ?? null);

  for (const tender of report.tenders) {
    lines.push(
      line({
        section: "tender",
        key: "tender",
        tender: tender.tenderType,
        amount: tender.payments,
        expected: tender.expected,
        counted: tender.counted,
        variance: tender.variance,
        text:
          `payments=${tender.payments};reversals=${tender.reversals}` +
          (tender.correction !== "0.00"
            ? `;correction=${tender.correction};effective_counted=${tender.effectiveCounted}`
            : "")
      })
    );
  }

  for (const movement of report.movements) {
    lines.push(
      line({
        section: "movement",
        key: movement.movementType,
        tender: "cash",
        amount:
          movement.direction === "out"
            ? `-${movement.amount}`
            : movement.amount,
        at: movement.createdAt,
        actor: movement.actorTenantUserId,
        text: [movement.reference, movement.note].filter(Boolean).join(" | ")
      })
    );
  }

  for (const correction of report.corrections) {
    lines.push(
      line({
        section: "correction",
        key: correction.correctionId,
        tender: correction.tenderType,
        amount: correction.adjustment,
        at: correction.createdAt,
        actor: correction.actorTenantUserId,
        text: correction.reason
      })
    );
  }

  return lines.join("\n") + "\n";
}
