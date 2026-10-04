import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchExpenseReport } from "../../../../../modules/commerce/application/operational-report-directory";
import { prepareOperationalRange } from "../../../../../modules/commerce/application/operational-report-http";
import { COMMERCE_REPORT_EXPENSES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/operational-expenses?from&to` (Issue #296,
 * ADR-0035) - posted and reversed expenses per business day, category and
 * tender, read from the `commerce.pos_expense_daily` projection. Gated on
 * `commerce.report_expenses.read` (not `commerce.expenses.read`, which opens
 * individual expense rows; this opens only their sums). While the tenant's
 * `expenses` feature is OFF the answer is `200` with `enabled: false`.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_EXPENSES_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await fetchExpenseReport(tx, tenantId, prepared))
});
