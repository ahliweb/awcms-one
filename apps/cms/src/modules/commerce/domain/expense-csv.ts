/**
 * The expense CSV (Issue #294, ADR-0031) — pure serialisation, no I/O.
 *
 * Formula injection is neutralised exactly as the cash-up CSV does
 * (`register-cash-up-csv.ts`'s `csvCell`/`csvNumber` are reused, not copied):
 * every tenant-typed free-text cell (description, payee, reversal reason,
 * category name) starting with `=`, `+`, `-`, `@`, a tab or a carriage return
 * is prefixed with `'`; an amount goes through `csvNumber`, which accepts only a
 * strict numeric shape. No receipt URL, media key or customer datum appears:
 * a receipt is reachable only through its own permission-gated route.
 */
import { csvCellForWrite } from "../../../lib/security/csv-formula";
import type { ExpenseStatus } from "./expense";

export const EXPENSE_CSV_COLUMNS = [
  "id",
  "occurred_on",
  "status",
  "category_code",
  "category_name",
  "amount",
  "tender",
  "register_session",
  "payee",
  "description",
  "created_by",
  "posted_at",
  "decision",
  "reversed_at",
  "reversal_reason",
  "has_receipt"
] as const;

export type ExpenseCsvRow = {
  id: string;
  occurredOn: string;
  status: ExpenseStatus;
  categoryCode: string;
  categoryName: string;
  amount: string;
  tenderType: string;
  registerSessionId: string | null;
  payeeName: string | null;
  description: string;
  createdByTenantUserId: string;
  postedAt: string | null;
  decision: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  hasReceipt: boolean;
};

export function serializeExpenseCsv(rows: readonly ExpenseCsvRow[]): string {
  const lines: string[] = [
    EXPENSE_CSV_COLUMNS.map((column) => csvCellForWrite(column)).join(",")
  ];
  for (const row of rows) {
    lines.push(
      [
        csvCellForWrite(row.id),
        csvCellForWrite(row.occurredOn),
        csvCellForWrite(row.status),
        csvCellForWrite(row.categoryCode),
        csvCellForWrite(row.categoryName),
        csvCellForWrite(row.amount, { numericText: true }),
        csvCellForWrite(row.tenderType),
        csvCellForWrite(row.registerSessionId),
        csvCellForWrite(row.payeeName),
        csvCellForWrite(row.description),
        csvCellForWrite(row.createdByTenantUserId),
        csvCellForWrite(row.postedAt),
        csvCellForWrite(row.decision),
        csvCellForWrite(row.reversedAt),
        csvCellForWrite(row.reversalReason),
        csvCellForWrite(row.hasReceipt)
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}
