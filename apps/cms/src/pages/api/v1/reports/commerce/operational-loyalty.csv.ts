import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchLoyaltyReport } from "../../../../../modules/commerce/application/operational-report-directory";
import {
  operationalCsvResponse,
  prepareOperationalRange,
  recordOperationalExportAudit
} from "../../../../../modules/commerce/application/operational-report-http";
import { COMMERCE_REPORT_LOYALTY_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import { serializeLoyaltyReportCsv } from "../../../../../modules/commerce/domain/operational-report-csv";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/operational-loyalty.csv?from&to` (Issue #296,
 * ADR-0035) - the loyalty projection as a CSV. Gated on
 * `commerce.report_loyalty.export` (high-risk `export`). Per-day bucket sums
 * only: no account, customer or order id. Audited, bounded to 366 days.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_LOYALTY_ACTIVITY_CODE,
    action: "export"
  },
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const report = await fetchLoyaltyReport(tx, tenantId, prepared);
    await recordOperationalExportAudit(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      family: "loyalty",
      range: prepared,
      rowCount: report.items.length,
      enabled: report.enabled,
      correlationId: locals.correlationId
    });
    return operationalCsvResponse(
      serializeLoyaltyReportCsv(report),
      "loyalty",
      prepared
    );
  }
});
