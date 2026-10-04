import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchCashUpReport } from "../../../../../modules/commerce/application/operational-report-directory";
import {
  operationalCsvResponse,
  prepareOperationalRange,
  recordOperationalExportAudit
} from "../../../../../modules/commerce/application/operational-report-http";
import { COMMERCE_REPORT_CASH_UPS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import { serializeCashUpVarianceCsv } from "../../../../../modules/commerce/domain/operational-report-csv";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/operational-cash-ups.csv?from&to` (Issue #296,
 * ADR-0035) - the cash-up variance projection as a CSV. Gated on
 * `commerce.report_cash_ups.export` (high-risk `export`). The cashier appears
 * as a tenant-user uuid only - never a name. Formula-neutralised, audited,
 * bounded to 366 days.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_CASH_UPS_ACTIVITY_CODE,
    action: "export"
  },
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const report = await fetchCashUpReport(tx, tenantId, prepared);
    await recordOperationalExportAudit(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      family: "cash-ups",
      range: prepared,
      rowCount: report.items.length,
      enabled: report.enabled,
      correlationId: locals.correlationId
    });
    return operationalCsvResponse(
      serializeCashUpVarianceCsv(report),
      "cash-ups",
      prepared
    );
  }
});
