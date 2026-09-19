import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { listSalesDaily } from "../../../../../modules/commerce/application/sales-report-directory";
import {
  validateSalesReportRange,
  type SalesReportRange
} from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/sales-daily?from&to` (Issue #117, contract
 * #106's D7) — one row per projection day in the inclusive range (default:
 * the last 30 days) from the `commerce.sales_daily` projection. Gated on
 * `reporting.dashboard.read`, the same permission the generic report views
 * under `/api/v1/reports/*` use; freshness/rebuild/reconcile of the
 * underlying projection live on `GET /api/v1/reports/projections/{key}`.
 * A read of a materialised table — `reporting` work class like its
 * siblings, never competing with interactive traffic for pool slots.
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
      items: await listSalesDaily(tx, tenantId, prepared)
    })
});
