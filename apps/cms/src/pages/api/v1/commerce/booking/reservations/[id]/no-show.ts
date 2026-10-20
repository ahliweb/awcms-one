/**
 * `POST /api/v1/commerce/booking/reservations/{id}/no-show` - mark a confirmed
 * reservation no-show and record what the policy retains (Issue #382, ADR-0045
 * D15, contracts section 3.8; threat control C-41). `id` is BOOKING's reservation
 * id.
 *
 * STAFF ONLY. Needs `commerce.booking_reservation_links.cancel` AND
 * `commerce.booking_refund_decisions.create` (the second is checked through the
 * same access chokepoint inside the handler - the two keys a cancel needs), the
 * tenant's `booking` feature and an `Idempotency-Key`. A cashier holds neither
 * key and a customer has no route at all. Booking measures the arrival plus the
 * tenant's grace: before it the answer is `409 NO_SHOW_TOO_EARLY` and nothing is
 * written.
 *
 * The body is only an optional short `reasonCode`; it never carries an amount.
 * What is retained is the `no_show_retention` rule of the policy version in force
 * when the booking was made, computed by the server, and NO refund leg is ever
 * created: the decision's refund is zero by a CHECK and a trigger forbids giving
 * it a return. The audit event records the retained amount and the policy
 * version.
 */
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { composedBookingPort } from "../../../../../../../lib/composition/booking-port";
import { authorizeInTransaction } from "../../../../../../../modules/identity-access/application/access-guard";
import {
  readValidatedBody,
  refundDecisionBody,
  requireBookingFeature,
  requireIdempotencyKey,
  rescheduleRefusalResponse
} from "../../../../../../../modules/commerce/application/booking-adapter-http";
import { recordBookingNoShow } from "../../../../../../../modules/commerce/application/booking-no-show";
import { fetchReservationLinkByReservationId } from "../../../../../../../modules/commerce/application/booking-reservation-links";
import {
  COMMERCE_BOOKING_REFUND_DECISIONS_ACTIVITY_CODE,
  COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE
} from "../../../../../../../modules/commerce/domain/booking-adapter-permissions";
import {
  validateNoShowRequest,
  type NoShowRequest
} from "../../../../../../../modules/commerce/domain/booking-no-show";
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

type Prepared = { body: NoShowRequest; idempotencyKey: string };

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
    const body = await readValidatedBody(request, validateNoShowRequest);
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
    // section 3): marking a no-show cancels the booking and records a decision,
    // and a holder of one alone gets nothing written.
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

    const result = await recordBookingNoShow(
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
        reasonCode: prepared.body.reasonCode
      }
    );
    if (result.kind === "refused") {
      return rescheduleRefusalResponse(result.refusal);
    }
    return ok({
      replayed: result.kind === "replayed",
      decision: refundDecisionBody(result.decision)
    });
  }
});
