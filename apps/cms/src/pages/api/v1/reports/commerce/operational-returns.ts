import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchReturnsReport } from "../../../../../modules/commerce/application/operational-report-directory";
import { prepareOperationalRange } from "../../../../../modules/commerce/application/operational-report-http";
import { COMMERCE_REPORT_RETURNS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/operational-returns?from&to` (Issue #316,
 * ADR-0035 D1) - returns and exchanges recorded, returned lines by stock
 * disposition (restocked, written off, quarantined) and settled refund legs by
 * tender and destination, per day and register, read from the
 * `commerce.pos_returns_daily` projection. Gated on
 * `commerce.report_returns.read` (not `commerce.returns.read`, which opens
 * individual returns and refund legs; this opens only their sums). While the
 * tenant's `returns` feature is OFF the answer is `200` with `enabled: false`.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_RETURNS_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await fetchReturnsReport(tx, tenantId, prepared))
});
