/**
 * The authority to override a booking refund (Issue #381, ADR-0045 D8/D10,
 * owner answer Q10, access matrix section 6, threat control C-40).
 *
 * An override sets the final refund to an amount other than the one the policy
 * computed. Four things must hold before the cancel service may honour it, and
 * this is the one place that checks the first two, so the route cannot reach the
 * service with an unchecked override (the service accepts only the
 * {@link AuthorizedOverride} type this function returns):
 *
 *   1. The caller holds `commerce.booking_refund_overrides.approve`, checked
 *      through the same access chokepoint as every other permission (so the
 *      decision log, deny rules and tenant separation-of-duties rules apply),
 *      IN ADDITION to the cancel permissions the route already required. It is
 *      NOT `commerce.refunds_offline.approve`: that approves how a leg was
 *      settled off-platform (C-11); holding it alone does not allow an override.
 *   2. The session has a FRESH step-up: aal2 and within the platform step-up
 *      TTL (`requireStepUp`, never a commerce-owned TTL - ADR-0045 D10). A
 *      stale or absent proof is `403 STEP_UP_REQUIRED`, never a silent allow,
 *      and nothing has been written. The time the proof was accepted is carried
 *      on the result and stored as `override_stepup_at`.
 *   3. (service) a reason of 10 to 500 characters - validated by the request
 *      schema, stored on the decision.
 *   4. (service) the amount never exceeds what was paid and not yet refunded.
 */
import { fail } from "../../_shared/api-response";
import { authorizeInTransaction } from "../../identity-access/application/access-guard";
import { requireStepUp } from "../../identity-access/application/mfa-session-assurance";
import { COMMERCE_BOOKING_REFUND_OVERRIDES_ACTIVITY_CODE } from "../domain/booking-adapter-permissions";
import type { AuthorizedOverride } from "./booking-cancellation";

const OVERRIDE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_REFUND_OVERRIDES_ACTIVITY_CODE,
  action: "approve"
} as const;

export type OverrideAuthorization =
  { ok: true; override: AuthorizedOverride } | { ok: false; denied: Response };

export async function authorizeRefundOverride(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date,
  request: { finalRefund: string; reason: string },
  actorTenantUserId: string
): Promise<OverrideAuthorization> {
  const allowed = await authorizeInTransaction(
    tx,
    tenantId,
    tokenHash,
    now,
    OVERRIDE_GUARD
  );
  if (!allowed.allowed) return { ok: false, denied: allowed.denied };

  const stepUp = await requireStepUp(tx, tenantId, tokenHash, now);
  if (!stepUp.ok) return { ok: false, denied: stepUp.denied };
  // `requireStepUp` is satisfied only with a stamp, but the type allows null.
  const stepUpAt = stepUp.session.steppedUpAt;
  if (stepUpAt === null) {
    return { ok: false, denied: stepUpRequiredResponse() };
  }

  return {
    ok: true,
    override: {
      authorizedBy: "refund_override_permission_and_step_up",
      finalRefund: request.finalRefund,
      reason: request.reason,
      actorTenantUserId,
      stepUpAt
    }
  };
}

function stepUpRequiredResponse(): Response {
  return fail(
    403,
    "STEP_UP_REQUIRED",
    "This action requires recent multi-factor verification. Complete a step-up and retry."
  );
}
