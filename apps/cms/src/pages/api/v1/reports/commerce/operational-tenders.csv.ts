import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchTenderReport } from "../../../../../modules/commerce/application/operational-report-directory";
import {
  operationalCsvResponse,
  prepareOperationalRange,
  recordOperationalExportAudit
} from "../../../../../modules/commerce/application/operational-report-http";
import { COMMERCE_REPORT_TENDERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import { serializeTenderCsv } from "../../../../../modules/commerce/domain/operational-report-csv";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/operational-tenders.csv?from&to` (Issue #296,
 * ADR-0035) - the tender-mix projection as a CSV. Gated on
 * `commerce.report_tenders.export`, the platform's high-risk `export` verb,
 * because the file leaves the system; reading the report grants no export.
 * Every cell is spreadsheet-formula-neutralised
 * (`domain/operational-report-csv.ts`), the export is audited, and the range
 * is bounded (366 days) by the same validator the JSON route uses.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_TENDERS_ACTIVITY_CODE,
    action: "export"
  },
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const report = await fetchTenderReport(tx, tenantId, prepared);
    await recordOperationalExportAudit(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      family: "tenders",
      range: prepared,
      rowCount: report.items.length,
      enabled: report.enabled,
      correlationId: locals.correlationId
    });
    return operationalCsvResponse(
      serializeTenderCsv(report),
      "tenders",
      prepared
    );
  }
});
