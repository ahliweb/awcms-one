import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchLoyaltyReport } from "../../../../../modules/commerce/application/operational-report-directory";
import { prepareOperationalRange } from "../../../../../modules/commerce/application/operational-report-http";
import { COMMERCE_REPORT_LOYALTY_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/operational-loyalty?from&to` (Issue #296,
 * ADR-0035) - loyalty points earned, redeemed, expired, adjusted and
 * reversed per day, with the outstanding points (the liability) at the start
 * and end of the range, read from the `commerce.pos_loyalty_daily`
 * projection. Gated on `commerce.report_loyalty.read`. No account or customer
 * appears. While the tenant's `loyalty` feature is OFF the answer is `200`
 * with `enabled: false`.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_LOYALTY_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await fetchLoyaltyReport(tx, tenantId, prepared))
});
