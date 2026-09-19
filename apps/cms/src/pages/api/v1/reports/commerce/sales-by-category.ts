import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { listSalesByCategory } from "../../../../../modules/commerce/application/sales-report-directory";
import {
  validateSalesReportRange,
  type SalesReportRange
} from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/sales-by-category?from&to` (Issue #117,
 * contract #106's D7) — the `commerce.sales_by_category` projection grouped
 * over the inclusive day range, largest gross first; the uncategorised bucket
 * is returned with `categoryId: null`. Gated on `reporting.dashboard.read`.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: ({ url }) => {
    const range = validateSalesReportRange({
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to")
    });
    if (!range.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Invalid date range.",
        {},
        range.errors
      );
    }
    return range.value;
  },
  authorize: {
    moduleKey: "reporting",
    activityCode: "dashboard",
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) =>
    ok({
      from: prepared.from,
      to: prepared.to,
      items: await listSalesByCategory(tx, tenantId, prepared)
    })
});
