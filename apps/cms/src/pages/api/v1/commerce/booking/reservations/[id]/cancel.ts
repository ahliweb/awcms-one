/**
 * `POST /api/v1/commerce/booking/reservations/{id}/cancel` - cancel a Booking
 * reservation and record the refund decision (Issue #381, ADR-0045 D4/D8/D9/D12,
 * contracts section 3.5; threat controls C-10, C-11, C-40). `id` is BOOKING's
 * reservation id.
 *
 * Needs `commerce.booking_reservation_links.cancel` AND
 * `commerce.booking_refund_decisions.create` (the second is checked through the
 * same access chokepoint inside the handler), the tenant's `booking` feature and
 * an `Idempotency-Key` (the same key and body replays the decision, `200`; the
 * same key with another body is `409 IDEMPOTENCY_CONFLICT`).
 *
 * The refund is the one the server computes from the policy version in force
 * when the booking was made, the original arrival and the ledger - the body
 * never carries an amount (`amount`, `final_refund`, ... are a `400`). The only
 * way to differ from it is the inline `override { finalRefund, reason }`, which
 * is honoured ONLY for a caller who also holds
 * `commerce.booking_refund_overrides.approve` and has a FRESH step-up (`403
 * STEP_UP_REQUIRED` otherwise, nothing written), with a reason of 10 to 500
 * characters, and never above the amount paid (`409 REFUND_EXCEEDS_PAID`). It is
 * a different authority from the offline refund approval. The refund legs are
 * planned under the tenant's service-account user; settling them stays with the
 * existing returns / refunds routes.
 */
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { composedBookingPort } from "../../../../../../../lib/composition/booking-port";
import { authorizeInTransaction } from "../../../../../../../modules/identity-access/application/access-guard";
import {
  cancelRefusalResponse,
  readValidatedBody,
  refundDecisionBody,
  requireBookingFeature,
  requireIdempotencyKey
} from "../../../../../../../modules/commerce/application/booking-adapter-http";
import { cancelBookingReservation } from "../../../../../../../modules/commerce/application/booking-cancellation";
import { authorizeRefundOverride } from "../../../../../../../modules/commerce/application/booking-refund-override";
import { fetchReservationLinkByReservationId } from "../../../../../../../modules/commerce/application/booking-reservation-links";
import {
  validateStaffCancelRequest,
  type StaffCancelRequest
} from "../../../../../../../modules/commerce/domain/booking-cancellation";
import {
  COMMERCE_BOOKING_REFUND_DECISIONS_ACTIVITY_CODE,
  COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE
} from "../../../../../../../modules/commerce/domain/booking-adapter-permissions";
import { isUuid } from "../../../../../../../modules/commerce/domain/register";

const CANCEL_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE,
  action: "cancel"
} as const;

const DECISION_CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_REFUND_DECISIONS_ACTIVITY_CODE,
  action: "create"
} as const;

type Prepared = { body: StaffCancelRequest; idempotencyKey: string };

export const POST = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<Prepared | Response> => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    if (key.key.length > 255) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Idempotency-Key must be at most 255 characters."
      );
    }
    const body = await readValidatedBody(request, validateStaffCancelRequest);
    if (body instanceof Response) return body;
    return { body, idempotencyKey: key.key };
  },
  authorize: CANCEL_GUARD,
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

    // The decision permission is a second, separate key (access matrix
    // section 3): cancelling a reservation and recording its refund are two
    // powers, and a holder of one alone gets nothing written.
    const decisionRight = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      DECISION_CREATE_GUARD
    );
    if (!decisionRight.allowed) return decisionRight.denied;

    const id = params.id;
    if (!isUuid(id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Reservation not found.");
    }
    const link = await fetchReservationLinkByReservationId(tx, tenantId, id);
    if (!link) return fail(404, "RESOURCE_NOT_FOUND", "Reservation not found.");

    // An override is honoured only after ITS permission and a fresh step-up -
    // checked before the first write, so a refusal leaves nothing behind.
    let override = null;
    if (prepared.body.override) {
      const authorised = await authorizeRefundOverride(
        tx,
        tenantId,
        tokenHash,
        now,
        prepared.body.override,
        auth.context.tenantUserId
      );
      if (!authorised.ok) return authorised.denied;
      override = authorised.override;
    }

    const result = await cancelBookingReservation(
      tx,
      {
        tenantId,
        actor: { kind: "staff", tenantUserId: auth.context.tenantUserId },
        correlationId: locals.correlationId ?? crypto.randomUUID(),
        port: await composedBookingPort(),
        now
      },
      {
        link,
        idempotencyKey: prepared.idempotencyKey,
        reasonCode: prepared.body.reasonCode,
        acknowledgedRefund: null,
        override
      }
    );
    if (result.kind === "refused") return cancelRefusalResponse(result.refusal);
    return ok({
      replayed: result.kind === "replayed",
      decision: refundDecisionBody(result.decision)
    });
  }
});
