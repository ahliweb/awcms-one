import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchStoredValueDailyReport } from "../../../../../modules/commerce/application/operational-report-directory";
import {
  operationalCsvResponse,
  prepareOperationalRange,
  recordOperationalExportAudit
} from "../../../../../modules/commerce/application/operational-report-http";
import { COMMERCE_REPORT_STORED_VALUE_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import { serializeStoredValueReportCsv } from "../../../../../modules/commerce/domain/operational-report-csv";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/operational-stored-value.csv?from&to` (Issue
 * #296, ADR-0035) - the stored-value movement projection as a CSV. Gated on
 * `commerce.report_stored_value.export` (high-risk `export`). Per-day bucket
 * sums only: no account number, code or holder. Audited, bounded to 366 days.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_STORED_VALUE_ACTIVITY_CODE,
    action: "export"
  },
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const report = await fetchStoredValueDailyReport(tx, tenantId, prepared);
    await recordOperationalExportAudit(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      family: "stored-value",
      range: prepared,
      rowCount: report.items.length,
      enabled: report.enabled,
      correlationId: locals.correlationId
    });
    return operationalCsvResponse(
      serializeStoredValueReportCsv(report),
      "stored-value",
      prepared
    );
  }
});
