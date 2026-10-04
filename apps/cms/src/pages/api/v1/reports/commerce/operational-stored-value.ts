import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchStoredValueDailyReport } from "../../../../../modules/commerce/application/operational-report-directory";
import { prepareOperationalRange } from "../../../../../modules/commerce/application/operational-report-http";
import { COMMERCE_REPORT_STORED_VALUE_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/operational-stored-value?from&to` (Issue #296,
 * ADR-0035) - gift-card and store-credit movement (issued, loaded, redeemed,
 * refunded, expired, adjusted) per day and account kind, with the outstanding
 * liability at the start and end of the range, read from the
 * `commerce.pos_stored_value_daily` projection. The live `stored-value` route
 * stays for the current-state splits a movement table cannot give (disabled
 * balances, lapsed-but-unreleased). Gated on `commerce.report_stored_value
 * .read`. While the tenant's `storedValue` feature is OFF the answer is `200`
 * with `enabled: false`.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_STORED_VALUE_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await fetchStoredValueDailyReport(tx, tenantId, prepared))
});
