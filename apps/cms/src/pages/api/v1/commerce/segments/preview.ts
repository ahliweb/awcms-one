/**
 * `POST /api/v1/commerce/segments/preview` - how many customers a segment rule
 * matches (Issue #360, ADR-0042, PRD S2). Body: `{ rules }` (an unsaved rule
 * tree) OR `{ segmentId, version? }` (a saved segment, the latest version by
 * default). Gated on `commerce.segment_previews.read` and the tenant's
 * `segments` feature.
 *
 * The answer is a COUNT, the server's `asOf` instant, and - only for a caller
 * who also holds `commerce.segment_members.read` and `commerce.customers.read`
 * - a bounded, masked sample (never pageable). A count below five is withheld
 * and reported as `{ suppressed: true, label: "fewer_than_5" }` (C-27). Every
 * evaluation is bounded (C-26): concurrency-limited (`429
 * SEGMENT_EVALUATION_BUSY`), time-limited (`422 SEGMENT_TOO_EXPENSIVE`) and
 * throttled per actor (`429 RATE_LIMITED`). A tenant id in the body is refused
 * by name; the tenant always comes from the authenticated context.
 */
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { resolveSegmentRules } from "../../../../../modules/commerce/application/segment-directory";
import { previewSegment } from "../../../../../modules/commerce/application/segment-evaluator";
import {
  evaluationRefusalResponse,
  holdsMemberVisibility,
  readValidatedBody,
  requireSegmentsFeature,
  segmentNotFoundResponse,
  throttlePreview
} from "../../../../../modules/commerce/application/segment-http";
import {
  validateSegmentPreviewRequest,
  type SegmentPreviewRequest
} from "../../../../../modules/commerce/domain/segment";
import { COMMERCE_SEGMENT_PREVIEWS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const PREVIEW_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SEGMENT_PREVIEWS_ACTIVITY_CODE,
  action: "read"
} as const;

export const POST = defineTenantRoute<SegmentPreviewRequest>({
  workClass: "reporting",
  prepare: ({ request }) =>
    readValidatedBody(request, validateSegmentPreviewRequest),
  authorize: PREVIEW_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, now, tokenHash }) => {
    const gate = await requireSegmentsFeature(tx, tenantId);
    if (gate) return gate;
    const throttled = throttlePreview(
      tenantId,
      auth.context.tenantUserId,
      now.getTime()
    );
    if (throttled) return throttled;

    let rules: Parameters<typeof previewSegment>[2];
    let segment: { id: string; version: number } | null = null;
    if (prepared.kind === "rules") {
      rules = { node: prepared.node, stats: prepared.stats };
    } else {
      const resolved = await resolveSegmentRules(
        tx,
        tenantId,
        prepared.segmentId,
        prepared.version
      );
      if (!resolved) return segmentNotFoundResponse();
      rules = { node: resolved.node, stats: resolved.stats };
      segment = { id: resolved.segmentId, version: resolved.version };
    }

    const includeSample = await holdsMemberVisibility(
      tx,
      tenantId,
      tokenHash,
      now
    );
    const outcome = await previewSegment(
      tx,
      { tenantId, actorTenantUserId: auth.context.tenantUserId, now },
      rules,
      { includeSample }
    );
    if (outcome.kind !== "ok") {
      return (
        evaluationRefusalResponse(outcome) ??
        fail(500, "INTERNAL_ERROR", "Segment evaluation failed.")
      );
    }
    return ok({
      segment,
      asOf: outcome.preview.asOf,
      count: outcome.preview.count,
      sample: outcome.preview.sample
    });
  }
});
