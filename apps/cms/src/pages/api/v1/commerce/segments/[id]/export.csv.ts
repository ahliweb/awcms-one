/**
 * `GET /api/v1/commerce/segments/{id}/export.csv?version=` - the members of a
 * segment version as CSV (Issue #360, ADR-0042, control C-27). Gated on
 * `commerce.segment_members.export` - the platform's high-risk `export` verb,
 * because the file leaves the system - AND `commerce.customers.read`, and on
 * the tenant's `segments` feature. Reading members grants no export. The file
 * is formula-neutralised, carries the same masked fields a list does, is
 * bounded (at most 10,000 rows, with `X-Export-Truncated: true` when more
 * existed - never a silent cut), and the export is audited at `warning`
 * severity with the actor, the version and the row count.
 */
import { fail } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  recordSegmentMemberAccess,
  resolveSegmentRules
} from "../../../../../../modules/commerce/application/segment-directory";
import { exportSegmentMembers } from "../../../../../../modules/commerce/application/segment-evaluator";
import {
  evaluationRefusalResponse,
  requireCustomersRead,
  requireSegmentsFeature,
  segmentNotFoundResponse
} from "../../../../../../modules/commerce/application/segment-http";
import {
  parseSegmentMembersQuery,
  SEGMENT_EVALUATION_LIMITS,
  serializeSegmentMembersCsv,
  type SegmentMembersQuery
} from "../../../../../../modules/commerce/domain/segment";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_SEGMENT_MEMBERS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const EXPORT_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SEGMENT_MEMBERS_ACTIVITY_CODE,
  action: "export"
} as const;

export const GET = defineTenantRoute<SegmentMembersQuery>({
  workClass: "reporting",
  prepare: ({ url }) => {
    const query = parseSegmentMembersQuery(url.searchParams);
    if (!query.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Query failed validation.",
        {},
        query.errors
      );
    }
    return query.value;
  },
  authorize: EXPORT_GUARD,
  handler: async ({
    tx,
    tenantId,
    auth,
    params,
    prepared,
    now,
    tokenHash,
    locals
  }) => {
    const gate = await requireSegmentsFeature(tx, tenantId);
    if (gate) return gate;
    const denied = await requireCustomersRead(tx, tenantId, tokenHash, now);
    if (denied) return denied;
    if (!isUuid(params.id)) return segmentNotFoundResponse();

    const resolved = await resolveSegmentRules(
      tx,
      tenantId,
      params.id,
      prepared.version
    );
    if (!resolved) return segmentNotFoundResponse();

    const outcome = await exportSegmentMembers(
      tx,
      { tenantId, actorTenantUserId: auth.context.tenantUserId, now },
      { node: resolved.node, stats: resolved.stats },
      SEGMENT_EVALUATION_LIMITS.maxExportRows
    );
    if (outcome.kind !== "ok") {
      return (
        evaluationRefusalResponse(outcome) ??
        fail(500, "INTERNAL_ERROR", "Segment evaluation failed.")
      );
    }
    await recordSegmentMemberAccess(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      segmentId: resolved.segmentId,
      version: resolved.version,
      action: "commerce.segment.exported",
      returned: outcome.members.length,
      truncated: outcome.truncated,
      correlationId: locals.correlationId
    });
    return new Response(serializeSegmentMembersCsv(outcome.members), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="segment-${resolved.segmentId}-v${resolved.version}.csv"`,
        "cache-control": "no-store",
        "x-export-truncated": outcome.truncated ? "true" : "false",
        "x-segment-as-of": outcome.asOf
      }
    });
  }
});
