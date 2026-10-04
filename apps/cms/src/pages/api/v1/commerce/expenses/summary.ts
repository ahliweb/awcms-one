/**
 * `GET /api/v1/commerce/expenses/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` — the
 * expense summary of a date range (Issue #294, ADR-0031). Gated on
 * `commerce.expenses.read` and the tenant's `expenses` feature. Only POSTED
 * expenses count as spent; REVERSED ones are reported beside them (never netted
 * away) and drafts / pending approvals are counted but belong to no total. All
 * sums are exact (`numeric(14,2)` strings, integer cents). The range is
 * required and spans at most 366 days (`400 VALIDATION_ERROR` otherwise), so the
 * aggregate is bounded by construction.
 */
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchExpenseSummary } from "../../../../../modules/commerce/application/expense-directory";
import { requireExpenseFeature } from "../../../../../modules/commerce/application/expense-http";
import { parseExpenseReportRange } from "../../../../../modules/commerce/domain/expense";
import { COMMERCE_EXPENSES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSES_ACTIVITY_CODE,
  action: "read"
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
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireExpenseFeature(tx, tenantId);
    if (gate) return gate;
    return ok(await fetchExpenseSummary(tx, tenantId, prepared));
  }
});
