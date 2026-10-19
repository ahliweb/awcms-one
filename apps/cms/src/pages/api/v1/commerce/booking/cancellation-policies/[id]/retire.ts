/**
 * `POST /api/v1/commerce/booking/cancellation-policies/{id}/retire` - end the
 * ACTIVE version of a scope without a successor (Issue #381, ADR-0045 D6; access
 * matrix section 3). The scope then falls back to the tenant default and, with
 * none, to no refund (D6). A booking already made keeps the version in force
 * when it was made. Same authority as approving: needs
 * `commerce.booking_cancellation_policies.approve`, a FRESH step-up, the
 * tenant's `booking` feature and an `Idempotency-Key`. A version that is not
 * active is `409 INVALID_STATE`.
 */
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import {
  idempotencyErrorResponse,
  requireBookingFeature,
  requireIdempotencyKey
} from "../../../../../../../modules/commerce/application/booking-adapter-http";
import { retirePolicy } from "../../../../../../../modules/commerce/application/booking-cancellation-policies";
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
      const outcome = await retirePolicy(
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
        case "not_active":
          return fail(
            409,
            "INVALID_STATE",
            `Only an active version can be retired (this version is ${outcome.status}).`
          );
        case "retired":
        case "replayed":
          return ok({
            replayed: outcome.kind === "replayed",
            policy: outcome.policy
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
