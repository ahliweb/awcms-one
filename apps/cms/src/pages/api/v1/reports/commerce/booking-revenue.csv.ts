import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchBookingRevenueReport } from "../../../../../modules/commerce/application/booking-revenue-report";
import { prepareOperationalRange } from "../../../../../modules/commerce/application/operational-report-http";
import { COMMERCE_REPORT_BOOKING_REVENUE_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import { serializeBookingRevenueCsv } from "../../../../../modules/commerce/domain/booking-revenue-csv";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";
import { recordAuditEvent } from "../../../../../modules/logging/application/audit-log";

/**
 * `GET /api/v1/reports/commerce/booking-revenue.csv?from&to` (Issue #478, metrics
 * 3.9 D4) - the booking revenue waterfall of `booking-revenue` as a CSV, one row
 * per Asia/Jakarta PAID day with the same columns as the screen: gross,
 * discounts, refunds with its three parts (paid back, payable, uncollected), net,
 * the shipping / insurance / tax companions after their refunded share, the
 * balance outstanding, the refund payable, the stay and no-show figures and the
 * restatement flag. Gated on `commerce.report_booking_revenue.export` (migration
 * 1054), a dedicated high-risk export key like the operational and retention
 * CSVs, NOT implied by `reporting.dashboard.read` (the screen and the JSON route's
 * permission): a file leaves the system. Aggregates only; every cell is formula-neutralised.
 * Audited (`booking_revenue_report.export`: the range and the row count, never a
 * cell), `Cache-Control: no-store`, bounded to 366 days. While the tenant's
 * `booking` feature is OFF the answer is `200` with the header row only.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_BOOKING_REVENUE_ACTIVITY_CODE,
    action: "export"
  },
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const report = await fetchBookingRevenueReport(tx, tenantId, prepared);
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "commerce",
      action: "booking_revenue_report.export",
      resourceType: "booking_revenue_report",
      message: `Booking revenue report exported: ${report.from} to ${report.to}, ${report.days.length} rows.`,
      attributes: {
        from: report.from,
        to: report.to,
        rowCount: report.days.length,
        featureEnabled: report.enabled
      },
      correlationId: locals.correlationId
    });
    return new Response(serializeBookingRevenueCsv(report), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="booking-revenue-${report.from}-${report.to}.csv"`,
        "cache-control": "no-store"
      }
    });
  }
});
