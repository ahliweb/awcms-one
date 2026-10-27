import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchBookingCashRefundReport } from "../../../../../modules/commerce/application/booking-cash-view";
import { prepareOperationalRange } from "../../../../../modules/commerce/application/operational-report-http";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/booking-revenue-cash?from&to` (Issue #478,
 * metrics 3.6 and 3.9 D4) - the CASH view of the booking slice's refunds: the
 * succeeded reversal legs of the payment ledger of the booking-sourced orders,
 * grouped by the Asia/Jakarta day each leg SETTLED. This is where the cash
 * reading of a refund lives now that the waterfall counts a refund when it is
 * decided; the payload says `basis: "cash"` and the two views are never mixed in
 * one chart. A leg that is planned, processing or failed moved no money and is the
 * waterfall's "refund payable", not a row here. Aggregates only (no order,
 * customer, name, contact or provider reference). Gated on
 * `reporting.dashboard.read`, the waterfall route's own permission; while the
 * tenant's `booking` feature is OFF the answer is `200` with `enabled: false` and
 * no days.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "reporting",
    activityCode: "dashboard",
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await fetchBookingCashRefundReport(tx, tenantId, prepared))
});
