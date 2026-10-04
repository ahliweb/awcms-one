/**
 * `GET /api/v1/commerce/expenses/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD` — the
 * expense CSV of a date range (Issue #294, ADR-0031). Gated on
 * `commerce.expenses.export` - the platform's high-risk `export` verb, because
 * the file leaves the system; the permission to READ expenses grants no export.
 * Every cell is spreadsheet-formula-neutralised (`domain/expense-csv.ts`,
 * reusing the cash-up CSV's `csvCell`/`csvNumber`), no receipt URL, media key or
 * customer datum appears, and the file is bounded: at most 10,000 rows over a
 * range of at most 366 days, with `X-Export-Truncated: true` (never a silent
 * cut) when the range held more. `reporting` work class.
 */
import { fail } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { listExpensesForExport } from "../../../../../modules/commerce/application/expense-directory";
import { requireExpenseFeature } from "../../../../../modules/commerce/application/expense-http";
import {
  MAX_EXPENSE_EXPORT_ROWS,
  parseExpenseReportRange
} from "../../../../../modules/commerce/domain/expense";
import { serializeExpenseCsv } from "../../../../../modules/commerce/domain/expense-csv";
import { COMMERCE_EXPENSES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const EXPORT_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSES_ACTIVITY_CODE,
  action: "export"
} as const;

export const GET = defineTenantRoute<{ from: string; to: string }>({
  workClass: "reporting",
  prepare: ({ url }) => {
    const range = parseExpenseReportRange(url.searchParams);
    if (!range.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Query failed validation.",
        {},
        range.errors
      );
    }
    return range.value;
  },
  authorize: EXPORT_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireExpenseFeature(tx, tenantId);
    if (gate) return gate;
    const exported = await listExpensesForExport(
      tx,
      tenantId,
      prepared,
      MAX_EXPENSE_EXPORT_ROWS
    );
    return new Response(serializeExpenseCsv(exported.rows), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="expenses-${prepared.from}-${prepared.to}.csv"`,
        "cache-control": "no-store",
        "x-export-truncated": exported.truncated ? "true" : "false"
      }
    });
  }
});
