import { fail } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { fetchRetentionReport } from "../../../../../modules/commerce/application/retention-report-directory";
import { COMMERCE_REPORT_RETENTION_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import {
  validateRetentionRange,
  type RetentionRange
} from "../../../../../modules/commerce/domain/retention";
import { serializeRetentionReportCsv } from "../../../../../modules/commerce/domain/retention-csv";
import { recordAuditEvent } from "../../../../../modules/logging/application/audit-log";

/**
 * `GET /api/v1/reports/commerce/retention.csv?months=` (Issue #364, ADR-0044) -
 * the cohort table as a CSV. Gated on `commerce.report_retention.export` (the
 * high-risk `export` verb). The file is aggregates only - month, counts, a rate
 * withheld below 20 customers - and every cell is formula-neutralised. Audited
 * (`retention_report.export`: the month span and row count, never a cell),
 * `Cache-Control: no-store`. A tenant whose `retention` feature is off gets a
 * header row only.
 */
export const GET = defineTenantRoute<RetentionRange>({
  workClass: "reporting",
  prepare: ({ url }) => {
    const range = validateRetentionRange({
      months: url.searchParams.get("months")
    });
    if (!range.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Invalid retention range.",
        {},
        range.errors
      );
    }
    return range.value;
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_REPORT_RETENTION_ACTIVITY_CODE,
    action: "export"
  },
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const report = await fetchRetentionReport(tx, tenantId, prepared);
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "commerce",
      action: "retention_report.export",
      resourceType: "retention_report",
      message: `Retention report exported: cohorts ${report.from} to ${report.to}, ${report.cohorts.length} rows.`,
      attributes: {
        from: report.from,
        to: report.to,
        rowCount: report.cohorts.length,
        featureEnabled: report.enabled
      },
      correlationId: locals.correlationId
    });
    return new Response(serializeRetentionReportCsv(report), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="retention-${report.from}-${report.to}.csv"`,
        "cache-control": "no-store"
      }
    });
  }
});
