import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { listSalesByProduct } from "../../../../../modules/commerce/application/sales-report-directory";
import {
  validateSalesByProductLimit,
  validateSalesReportRange,
  type SalesReportRange
} from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/sales-by-product?from&to&limit` (Issue #117,
 * contract #106's D7) — the `commerce.sales_by_product` projection grouped
 * over the inclusive day range, best-selling first, at most `limit` (default
 * 20, max 200) products. Gated on `reporting.dashboard.read`.
 */
export const GET = defineTenantRoute<SalesReportRange & { limit: number }>({
  workClass: "reporting",
  prepare: ({ url }) => {
    const range = validateSalesReportRange({
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to")
    });
    const limit = validateSalesByProductLimit(url.searchParams.get("limit"));
    const errors = [
      ...(range.valid ? [] : range.errors),
      ...(limit.valid ? [] : limit.errors)
    ];
    if (!range.valid || !limit.valid) {
      return fail(400, "VALIDATION_ERROR", "Invalid query.", {}, errors);
    }
    return { ...range.value, limit: limit.value };
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
      limit: prepared.limit,
      items: await listSalesByProduct(tx, tenantId, prepared, prepared.limit)
    })
});
