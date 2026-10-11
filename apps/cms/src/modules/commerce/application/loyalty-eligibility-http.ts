/**
 * The HTTP plumbing for restricting a loyalty program version to a CRM segment
 * (Issue #361, ADR-0042 amendment): what a request that names a segment must
 * additionally satisfy, in one place so the create and edit routes cannot
 * drift.
 *
 * Clearing a restriction (`eligibilitySegmentId: null`) or not mentioning one
 * needs nothing beyond the route's own `commerce.loyalty.manage`. SETTING one
 * additionally needs:
 *
 *   1. the tenant's `loyaltySegments` feature (default OFF) and its
 *      `segments` feature - `409 FEATURE_DISABLED` otherwise;
 *   2. `commerce.segments.read` - a loyalty manager who may not see segments
 *      cannot aim a program at one (the permission checked through the one
 *      access chokepoint, so the decision is logged);
 *   3. a live segment of THIS tenant and an existing version - `422
 *      SEGMENT_NOT_FOUND`, the same answer for an unknown, foreign, retired or
 *      non-existent version (no existence oracle across tenants).
 *
 * The version stored is the one resolved here (the segment's latest at this
 * instant when the request omitted it), so a later edit of the segment never
 * moves what the program recorded.
 */
import { fail } from "../../_shared/api-response";
import { authorizeInTransaction } from "../../identity-access/application/access-guard";
import { COMMERCE_SEGMENTS_ACTIVITY_CODE } from "../domain/commerce-permissions";
import { requireCommerceFeatureForOwnerRoute } from "./commerce-feature-gate";
import { resolveEligibilityReference } from "./loyalty-program-directory";

const SEGMENTS_READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SEGMENTS_ACTIVITY_CODE,
  action: "read"
} as const;

export type EligibilityRequest = {
  eligibilitySegmentId?: string | null;
  eligibilitySegmentVersion?: number | null;
};

export type EligibilityResolution =
  | { kind: "refused"; response: Response }
  | {
      kind: "ok";
      /** `undefined` = leave as is; `null` = clear; else the pinned reference. */
      reference: { segmentId: string; version: number } | null | undefined;
    };

export async function resolveEligibilityRequest(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date,
  request: EligibilityRequest
): Promise<EligibilityResolution> {
  if (request.eligibilitySegmentId === undefined) {
    return { kind: "ok", reference: undefined };
  }
  if (request.eligibilitySegmentId === null) {
    return { kind: "ok", reference: null };
  }

  for (const feature of ["loyaltySegments", "segments"] as const) {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      feature
    );
    if (gate) return { kind: "refused", response: gate };
  }

  const access = await authorizeInTransaction(
    tx,
    tenantId,
    tokenHash,
    now,
    SEGMENTS_READ_GUARD
  );
  if (!access.allowed) return { kind: "refused", response: access.denied };

  const reference = await resolveEligibilityReference(
    tx,
    tenantId,
    request.eligibilitySegmentId,
    request.eligibilitySegmentVersion ?? null
  );
  if (!reference) {
    return {
      kind: "refused",
      response: fail(
        422,
        "SEGMENT_NOT_FOUND",
        "The segment (or the version asked for) does not exist or has been retired."
      )
    };
  }
  return { kind: "ok", reference };
}
