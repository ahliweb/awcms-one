/**
 * The HTTP plumbing the ten POS operational-report routes share (Issue #296,
 * ADR-0035): the range query, the CSV response and the export audit event,
 * declared once so the five JSON routes and five CSV routes cannot drift into
 * ten slightly different answers. Each route file still declares its OWN
 * `authorize` literal - the guard is the part a reviewer (and
 * `access:permissions:enforcement:check`) must be able to read in the file
 * that enforces it.
 */
import { fail } from "../../_shared/api-response";
import type { TenantRouteRequestContext } from "../../_shared/tenant-route";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  validateSalesReportRange,
  type SalesReportRange
} from "../domain/sales-report-query";
import type { OperationalReportFamily } from "../domain/operational-report-keys";

/** `prepare` for every operational-report route: the same `from`/`to` window and bounds the sales reports use, or a `400 VALIDATION_ERROR`. */
export function prepareOperationalRange({
  url
}: Pick<TenantRouteRequestContext, "url">): SalesReportRange | Response {
  const range = validateSalesReportRange({
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to")
  });
  if (!range.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid date range.",
      {},
      range.errors
    );
  }
  return range.value;
}

export function operationalCsvResponse(
  body: string,
  family: OperationalReportFamily,
  range: SalesReportRange
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="pos-${family}-${range.from}-${range.to}.csv"`,
      "cache-control": "no-store"
    }
  });
}

/**
 * A CSV leaves the system, so every export is audited: who, which family, the
 * range and how many rows - never a cell. The authorization decision itself is
 * already in the decision log; this is the business-level record.
 */
export async function recordOperationalExportAudit(
  tx: Bun.SQL,
  input: {
    tenantId: string;
    actorTenantUserId: string;
    family: OperationalReportFamily;
    range: SalesReportRange;
    rowCount: number;
    enabled: boolean;
    correlationId?: string;
  }
): Promise<void> {
  await recordAuditEvent(tx, {
    tenantId: input.tenantId,
    actorTenantUserId: input.actorTenantUserId,
    moduleKey: "commerce",
    action: "operational_report.export",
    resourceType: "operational_report",
    message: `Operational report exported: ${input.family}, ${input.range.from} to ${input.range.to}, ${input.rowCount} rows.`,
    attributes: {
      family: input.family,
      from: input.range.from,
      to: input.range.to,
      rowCount: input.rowCount,
      featureEnabled: input.enabled
    },
    correlationId: input.correlationId
  });
}
