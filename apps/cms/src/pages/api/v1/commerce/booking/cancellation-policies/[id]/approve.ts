/**
 * `POST /api/v1/commerce/booking/cancellation-policies/{id}/approve` - activate
 * a DRAFT policy version (Issue #381, ADR-0045 D6; access matrix sections 4 and
 * 8; UX flows 11.4). The scope's current active version is retired in the same
 * transaction and this one becomes active; from then on it decides the refund of
 * every NEW booking (a booking already made keeps the version in force when it
 * was made). The approver is recorded.
 *
 * Needs `commerce.booking_cancellation_policies.approve` (a high-risk verb, so a
 * tenant may forbid the author and the approver being one person through its
 * separation-of-duties rules), a FRESH step-up (`403 STEP_UP_REQUIRED`
 * otherwise, nothing written), the tenant's `booking` feature and an
 * `Idempotency-Key`. A version that is not a draft is `409 INVALID_STATE`.
 */
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import {
  idempotencyErrorResponse,
  requireBookingFeature,
  requireIdempotencyKey
} from "../../../../../../../modules/commerce/application/booking-adapter-http";
import { approvePolicy } from "../../../../../../../modules/commerce/application/booking-cancellation-policies";
import { requireStepUp } from "../../../../../../../modules/identity-access/application/mfa-session-assurance";
import { COMMERCE_BOOKING_CANCELLATION_POLICIES_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/booking-adapter-permissions";
import { isUuid } from "../../../../../../../modules/commerce/domain/register";

const APPROVE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_CANCELLATION_POLICIES_ACTIVITY_CODE,
  action: "approve"
} as const;

export const POST = defineTenantRoute<{ idempotencyKey: string }>({
  workClass: "interactive",
  prepare: ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return { idempotencyKey: key.key };
  },
  authorize: APPROVE_GUARD,
  handler: async ({
    tx,
    tenantId,
    auth,
    prepared,
    locals,
    params,
    tokenHash,
    now
  }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    const id = params.id;
    if (!isUuid(id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Policy version not found.");
    }
    const stepUp = await requireStepUp(tx, tenantId, tokenHash, now);
    if (!stepUp.ok) return stepUp.denied;

    try {
      const outcome = await approvePolicy(
        tx,
        tenantId,
        auth.context.tenantUserId,
        id,
        prepared.idempotencyKey,
        locals.correlationId
      );
      switch (outcome.kind) {
        case "not_found":
          return fail(404, "RESOURCE_NOT_FOUND", "Policy version not found.");
        case "not_a_draft":
          return fail(
            409,
            "INVALID_STATE",
            `Only a draft can be approved (this version is ${outcome.status}).`
          );
        case "windows_not_monotone":
          return fail(
            409,
            "POLICY_WINDOWS_INVALID",
            "A window with more notice must not refund less than one with less notice."
          );
        case "activated":
        case "replayed":
          return ok({
            replayed: outcome.kind === "replayed",
            policy: outcome.policy,
            retiredPolicyId: outcome.retiredPolicyId
          });
      }
    } catch (error) {
      // tx-swallow-ok: IdempotencyRaceLostError and
      // IdempotencyPayloadMismatchError are raised by application code after
      // statements that succeeded (a replay lookup), so the transaction is
      // healthy.
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
