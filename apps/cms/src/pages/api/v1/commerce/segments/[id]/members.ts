/**
 * `GET /api/v1/commerce/segments/{id}/members?version=&cursor=&limit=` - the
 * customers a segment version matches (Issue #360, ADR-0042, PRD S4). Gated on
 * `commerce.segment_members.read` AND `commerce.customers.read` (a marketer
 * who may define segments cannot read people through them) and on the
 * tenant's `segments` feature. A keyset page (at most 100) of masked fields -
 * name, masked phone, masked e-mail, price level - ordered by customer id;
 * walk-in, blocked and erased customers are never members. Every page is
 * audited (who, which version, how many - never who they saw) and bounded like
 * a preview (`429 SEGMENT_EVALUATION_BUSY`, `422 SEGMENT_TOO_EXPENSIVE`).
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  recordSegmentMemberAccess,
  resolveSegmentRules
} from "../../../../../../modules/commerce/application/segment-directory";
import { listSegmentMembersPage } from "../../../../../../modules/commerce/application/segment-evaluator";
import {
  evaluationRefusalResponse,
  requireCustomersRead,
  requireSegmentsFeature,
  segmentNotFoundResponse
} from "../../../../../../modules/commerce/application/segment-http";
import {
  encodeMemberCursor,
  parseSegmentMembersQuery,
  type SegmentMembersQuery
} from "../../../../../../modules/commerce/domain/segment";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_SEGMENT_MEMBERS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SEGMENT_MEMBERS_ACTIVITY_CODE,
  action: "read"
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
  authorize: READ_GUARD,
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

    const outcome = await listSegmentMembersPage(
      tx,
      { tenantId, actorTenantUserId: auth.context.tenantUserId, now },
      { node: resolved.node, stats: resolved.stats },
      prepared.cursor,
      prepared.limit
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
      action: "commerce.segment.members_listed",
      returned: outcome.page.items.length,
      correlationId: locals.correlationId
    });
    return ok({
      segmentId: resolved.segmentId,
      version: resolved.version,
      asOf: outcome.page.asOf,
      items: outcome.page.items,
      nextCursor:
        outcome.page.hasMore && outcome.page.lastId
          ? encodeMemberCursor(outcome.page.lastId)
          : null
    });
  }
});
