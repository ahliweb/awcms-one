import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchExpenseReport } from "../../../../../modules/commerce/application/operational-report-directory";
import {
  operationalCsvResponse,
  prepareOperationalRange,
  recordOperationalExportAudit
} from "../../../../../modules/commerce/application/operational-report-http";
import { COMMERCE_REPORT_EXPENSES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import { serializeExpenseReportCsv } from "../../../../../modules/commerce/domain/operational-report-csv";
import type { SalesReportRange } from "../../../../../modules/commerce/domain/sales-report-query";

/**
 * `GET /api/v1/reports/commerce/operational-expenses.csv?from&to` (Issue #296,
 * ADR-0035) - the expense projection as a CSV. Gated on
 * `commerce.report_expenses.export` (high-risk `export`). The category NAME is
 * tenant-typed text, so every cell is formula-neutralised; no payee,
 * description or receipt appears (the per-expense export is
 * `commerce.expenses.export`'s). Audited, bounded to 366 days.
 */
export const GET = defineTenantRoute<SalesReportRange>({
  workClass: "reporting",
  prepare: prepareOperationalRange,
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_EXPENSES_ACTIVITY_CODE,
    action: "export"
  },
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const report = await fetchExpenseReport(tx, tenantId, prepared);
    await recordOperationalExportAudit(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      family: "expenses",
      range: prepared,
      rowCount: report.items.length,
      enabled: report.enabled,
      correlationId: locals.correlationId
    });
    return operationalCsvResponse(
      serializeExpenseReportCsv(report),
      "expenses",
      prepared
    );
  }
});
