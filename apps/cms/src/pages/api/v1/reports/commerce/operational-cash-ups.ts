import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchCashUpReport } from "../../../../../modules/commerce/application/operational-report-directory";
import { prepareOperationalRange } from "../../../../../modules/commerce/application/operational-report-http";
import { COMMERCE_REPORT_CASH_UPS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/operational-cash-ups?from&to` (Issue #296,
 * ADR-0035) - the cash-up variance of every register session that closed in
 * the range, per tender, with the register and the cashier of record, read
 * from the `commerce.pos_cash_up_variance` projection. Gated on
 * `commerce.report_cash_ups.read`: who was short at close is a supervisor's
 * question, so it is its own permission (not `commerce.register_sessions.read`,
 * which a cashier holds). While the tenant's `register` feature is OFF the
 * answer is `200` with `enabled: false` and nothing else.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_CASH_UPS_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await fetchCashUpReport(tx, tenantId, prepared))
});
