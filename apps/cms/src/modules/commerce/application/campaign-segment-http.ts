/**
 * The HTTP plumbing a campaign route needs once a segment is involved (Issue
 * #362, ADR-0042 Amendment): the feature gate, the permission to AIM a campaign
 * at a segment, the pinning of a version to a draft, and the one mapping of a
 * count outcome to its refusal. Declared once so the create, update, preview
 * and send routes cannot drift into four slightly different answers.
 */
import { fail } from "../../_shared/api-response";
import { authorizeInTransaction } from "../../identity-access/application/access-guard";
import type { CampaignSegmentRequest } from "../domain/campaign-validation";
import {
  COMMERCE_SEGMENTS_ACTIVITY_CODE,
  COMMERCE_SEGMENT_PREVIEWS_ACTIVITY_CODE
} from "../domain/commerce-permissions";
import {
  requireCampaignSegmentAudienceFeature,
  resolveCampaignSegmentPin
} from "./campaign-segment-audience";
import { evaluationRefusalResponse } from "./segment-http";

const SEGMENTS_READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SEGMENTS_ACTIVITY_CODE,
  action: "read"
} as const;

const SEGMENT_PREVIEWS_READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SEGMENT_PREVIEWS_ACTIVITY_CODE,
  action: "read"
} as const;

/**
 * Whoever may edit a campaign may not thereby aim it at an arbitrary
 * segment: choosing one also needs `commerce.segments.read`, checked through
 * the one access chokepoint (and so written to the decision log).
 */
export async function requireSegmentsRead(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date
): Promise<Response | null> {
  const result = await authorizeInTransaction(
    tx,
    tenantId,
    tokenHash,
    now,
    SEGMENTS_READ_GUARD
  );
  return result.allowed ? null : result.denied;
}

/** The count of a segment campaign's audience needs the segment-preview permission, like a segment's own count. */
export async function requireSegmentPreviewsRead(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date
): Promise<Response | null> {
  const result = await authorizeInTransaction(
    tx,
    tenantId,
    tokenHash,
    now,
    SEGMENT_PREVIEWS_READ_GUARD
  );
  return result.allowed ? null : result.denied;
}

export type AttachSegmentResult =
  | { kind: "ok"; pin: { segmentId: string; version: number } }
  | { kind: "refused"; response: Response };

/**
 * Everything that must hold before a draft is pinned to a segment version:
 * the three feature flags, the permission to read segments, and a live segment
 * of this tenant at an existing version.
 */
export async function attachSegmentToDraft(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date,
  request: CampaignSegmentRequest
): Promise<AttachSegmentResult> {
  const gate = await requireCampaignSegmentAudienceFeature(tx, tenantId);
  if (gate) return { kind: "refused", response: gate };

  const denied = await requireSegmentsRead(tx, tenantId, tokenHash, now);
  if (denied) return { kind: "refused", response: denied };

  const outcome = await resolveCampaignSegmentPin(tx, tenantId, request);
  if (outcome.kind === "not_found") {
    return {
      kind: "refused",
      response: fail(404, "RESOURCE_NOT_FOUND", "Segment not found.")
    };
  }
  if (outcome.kind === "retired") {
    return {
      kind: "refused",
      response: fail(
        409,
        "SEGMENT_RETIRED",
        "A retired segment cannot be chosen as a campaign audience."
      )
    };
  }
  return {
    kind: "ok",
    pin: { segmentId: outcome.pin.segmentId, version: outcome.pin.version }
  };
}

/** The refusal for a count outcome that is not a number (busy, too expensive, segment gone), else `null`. */
export function audienceRefusalResponse(outcome: {
  kind: string;
}): Response | null {
  const evaluation = evaluationRefusalResponse(outcome);
  if (evaluation) return evaluation;
  if (outcome.kind === "segment_missing") {
    return fail(
      409,
      "SEGMENT_UNAVAILABLE",
      "The segment this campaign targets can no longer be read."
    );
  }
  return null;
}
