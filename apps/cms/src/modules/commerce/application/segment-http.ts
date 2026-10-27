/**
 * The HTTP plumbing every CRM segment route shares (Issue #360, ADR-0042): the
 * `segments` feature gate, the second permission the member routes require,
 * the preview throttle, and the one mapping of an evaluation outcome to its
 * response - declared once so seven routes cannot drift into seven slightly
 * different answers.
 */
import { fail } from "../../_shared/api-response";
import { checkRateLimit } from "../../../lib/security/rate-limit";
import { authorizeInTransaction } from "../../identity-access/application/access-guard";
import { COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE } from "../domain/booking-adapter-permissions";
import {
  COMMERCE_CUSTOMERS_ACTIVITY_CODE,
  COMMERCE_SEGMENT_MEMBERS_ACTIVITY_CODE
} from "../domain/commerce-permissions";
import { SEGMENT_EVALUATION_LIMITS } from "../domain/segment";
import { usesBookingFields, type SegmentNode } from "../domain/segment-rules";
import { requireCommerceFeatureForOwnerRoute } from "./commerce-feature-gate";

export { readValidatedBody } from "./register-http";

/** `409 FEATURE_DISABLED` while the tenant's `segments` feature is off, else `null`. */
export function requireSegmentsFeature(
  tx: Bun.SQL,
  tenantId: string
): Promise<Response | null> {
  return requireCommerceFeatureForOwnerRoute(tx, tenantId, "segments");
}

const BOOKING_LINKS_READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE,
  action: "read"
} as const;

/**
 * Booking-derived rules (rule schema 2, ADR-0052 D5) are a separate power: a
 * count of "people who no-showed" is booking behaviour, so a segment editor who
 * may not read bookings must not be able to define, count, list or export one.
 * `null` when the rule reads no booking fact or the caller holds
 * `commerce.booking_reservation_links.read` (checked through the one access
 * chokepoint, so the decision is logged), the finished denial otherwise.
 *
 * `requireFeature` additionally demands the tenant's `booking` feature - for
 * DEFINING a rule (create, edit, an unsaved preview): a tenant that never
 * enabled the booking adapter has nothing to derive. Reading the result of a
 * rule already saved does not re-check the flag, because the facts are history
 * that outlives it.
 */
export async function requireBookingRuleAccess(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date,
  node: SegmentNode,
  options: { requireFeature: boolean }
): Promise<Response | null> {
  if (!usesBookingFields(node)) return null;
  if (options.requireFeature) {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "booking"
    );
    if (gate) return gate;
  }
  const result = await authorizeInTransaction(
    tx,
    tenantId,
    tokenHash,
    now,
    BOOKING_LINKS_READ_GUARD
  );
  return result.allowed ? null : result.denied;
}

const CUSTOMERS_READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CUSTOMERS_ACTIVITY_CODE,
  action: "read"
} as const;

/**
 * Listing or exporting members shows customers, so it additionally needs the
 * customer-read permission (S4): a marketer who may define and count segments
 * cannot read people through them. Checked through the one chokepoint (and so
 * written to the decision log) after the route's own permission. `null` when
 * the caller holds it, the finished denial otherwise.
 */
export async function requireCustomersRead(
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
    CUSTOMERS_READ_GUARD
  );
  return result.allowed ? null : result.denied;
}

/** Whether the caller holds customer-read, for a response that degrades (the preview sample) instead of refusing. */
export async function holdsCustomersRead(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date
): Promise<boolean> {
  return (await requireCustomersRead(tx, tenantId, tokenHash, now)) === null;
}

const MEMBERS_READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SEGMENT_MEMBERS_ACTIVITY_CODE,
  action: "read"
} as const;

/**
 * Whether the caller may see MEMBERS (both `commerce.segment_members.read` and
 * `commerce.customers.read`), for a response that degrades to count-only
 * instead of refusing - the preview sample.
 */
export async function holdsMemberVisibility(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date
): Promise<boolean> {
  const members = await authorizeInTransaction(
    tx,
    tenantId,
    tokenHash,
    now,
    MEMBERS_READ_GUARD
  );
  if (!members.allowed) return false;
  return holdsCustomersRead(tx, tenantId, tokenHash, now);
}

/**
 * Per-actor throttle on previews (an in-process counter on top of the
 * concurrency cap): repeated near-identical previews are how a narrow count is
 * differenced into a person. `null` when allowed.
 */
export function throttlePreview(
  tenantId: string,
  actorTenantUserId: string,
  now: number
): Response | null {
  const result = checkRateLimit(
    `commerce-segment-preview:${tenantId}:${actorTenantUserId}`,
    {
      windowMs: 60_000,
      maxAttempts: SEGMENT_EVALUATION_LIMITS.previewsPerMinutePerActor
    },
    now
  );
  if (result.allowed) return null;
  return fail(
    429,
    "RATE_LIMITED",
    "Too many segment previews. Wait a moment and try again.",
    {},
    undefined,
    { "retry-after": String(result.retryAfterSec) }
  );
}

/** The stable answers for a refused evaluation (C-26). `null` when the outcome is not a refusal. */
export function evaluationRefusalResponse(outcome: {
  kind: string;
}): Response | null {
  if (outcome.kind === "busy") {
    return fail(
      429,
      "SEGMENT_EVALUATION_BUSY",
      "Too many segment evaluations are running. Try again shortly.",
      {},
      undefined,
      { "retry-after": "2" }
    );
  }
  if (outcome.kind === "too_expensive") {
    return fail(
      422,
      "SEGMENT_TOO_EXPENSIVE",
      "This segment is too expensive to evaluate. Narrow the rule (fewer conditions or shorter windows) and try again."
    );
  }
  return null;
}

export function segmentNotFoundResponse(): Response {
  return fail(404, "RESOURCE_NOT_FOUND", "Segment not found.");
}
