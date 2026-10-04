import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchTenderReport } from "../../../../../modules/commerce/application/operational-report-directory";
import { prepareOperationalRange } from "../../../../../modules/commerce/application/operational-report-http";
import { COMMERCE_REPORT_TENDERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/operational-tenders?from&to` (Issue #296,
 * ADR-0035) - money movement per day, register and tender, read from the
 * `commerce.pos_tender_daily` projection (rebuildable from the payment-
 * allocation ledger, reconcilable, freshness-monitored). The live
 * `tender-mix` route stays as the drill-down and as the figure the
 * projection is tested against. Gated on `commerce.report_tenders.read`, a
 * permission of its own: neither `reporting.dashboard.read` nor
 * `commerce.payments.read` implies it. A tenant needs no feature for it
 * (payments exist everywhere). `reporting` work class like its siblings.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_TENDERS_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await fetchTenderReport(tx, tenantId, prepared))
});
