import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchReturnsReport } from "../../../../../modules/commerce/application/operational-report-directory";
import {
  operationalCsvResponse,
  prepareOperationalRange,
  recordOperationalExportAudit
} from "../../../../../modules/commerce/application/operational-report-http";
import { COMMERCE_REPORT_RETURNS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import { serializeReturnsReportCsv } from "../../../../../modules/commerce/domain/operational-report-csv";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/operational-returns.csv?from&to` (Issue #316,
 * ADR-0035 D1) - the returns & refunds projection as one long CSV. Gated on
 * `commerce.report_returns.export` (high-risk `export`). The register code and
 * name are tenant-typed text, so every cell is formula-neutralised; no order,
 * customer, return or refund id appears (the per-return rows are
 * `commerce.returns.*`'s). Audited, bounded to 366 days.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_RETURNS_ACTIVITY_CODE,
    action: "export"
  },
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const report = await fetchReturnsReport(tx, tenantId, prepared);
    await recordOperationalExportAudit(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      family: "returns",
      range: prepared,
      rowCount: report.items.length,
      enabled: report.enabled,
      correlationId: locals.correlationId
    });
    return operationalCsvResponse(
      serializeReturnsReportCsv(report),
      "returns",
      prepared
    );
  }
});
