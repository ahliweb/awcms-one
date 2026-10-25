/**
 * `POST /api/v1/commerce/booking/reservations/{id}/reschedule` - move a Booking
 * reservation to new dates and carry the price difference through the order path
 * (Issue #382, ADR-0045 D7 as amended for #382, D18, contracts section 3.7;
 * threat controls C-37, C-38, C-39). `id` is BOOKING's reservation id.
 *
 * Staff only: needs `commerce.booking_reservation_links.update` (and, only when
 * the move would plan refund legs - fewer nights - also
 * `commerce.booking_refund_decisions.create`, `403` before any write: Issue
 * #448), the tenant's `booking` feature and an `Idempotency-Key` (the same key and body replays the
 * result, `200`; the same key with another body is `409 IDEMPOTENCY_CONFLICT`). A
 * customer or guest has no reschedule route (ADR-0045 D18, access matrix section
 * 4: the guest asks, staff move it).
 *
 * The body is exactly one of `startsAt` (a slot) and `stay`, optionally the
 * `resourceId` to move to and a short `reasonCode`. It never carries a price, a
 * difference or a refund (`400`): the server prices the difference in integer
 * cents - more nights become a supplementary order the customer pays through the
 * ordinary payment paths, fewer nights a policy-limited refund return (planned,
 * never settled here), the same length nothing - and the cancellation window
 * stays the ORIGINAL booking's across the whole chain of reschedules.
 *
 * One transaction: the order reference moves (the old reservation link is
 * superseded, a new one points at the same order and line, Booking carries its
 * own reference), then the difference; a Booking refusal (`SLOT_UNAVAILABLE`, ...)
 * or an unsellable supplement leaves the original untouched.
 */
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { authorizeInTransaction } from "../../../../../../../modules/identity-access/application/access-guard";
import { composedBookingPort } from "../../../../../../../lib/composition/booking-port";
import { mediaLibraryPortAdapter } from "../../../../../../../modules/media-library/application/media-library-port-adapter";
import {
  readValidatedBody,
  requireBookingFeature,
  requireIdempotencyKey,
  rescheduleRefusalResponse,
  rescheduledBody
} from "../../../../../../../modules/commerce/application/booking-adapter-http";
import { rescheduleBookingReservation } from "../../../../../../../modules/commerce/application/booking-reschedule";
import { fetchReservationLinkByReservationId } from "../../../../../../../modules/commerce/application/booking-reservation-links";
import {
  COMMERCE_BOOKING_REFUND_DECISIONS_ACTIVITY_CODE,
  COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE
} from "../../../../../../../modules/commerce/domain/booking-adapter-permissions";
import {
  validateRescheduleRequest,
  type RescheduleRequest
} from "../../../../../../../modules/commerce/domain/booking-reschedule";
import { isUuid } from "../../../../../../../modules/commerce/domain/register";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE,
  action: "update"
} as const;

const DECISION_CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_REFUND_DECISIONS_ACTIVITY_CODE,
  action: "create"
} as const;

type Prepared = { body: RescheduleRequest; idempotencyKey: string };

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
    const body = await readValidatedBody(request, validateRescheduleRequest);
    if (body instanceof Response) return body;
    return { body, idempotencyKey: key.key };
  },
  authorize: UPDATE_GUARD,
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

    // Issue #448: a shorter stay plans pending refund legs, the decision
    // authority of the access matrix. Resolved lazily (the permission machinery
    // is route-level) so only a reschedule that WOULD plan legs asks - a
    // same-length or longer move still needs `.update` alone and logs no
    // second decision.
    const canPlanRefund = async (): Promise<boolean> =>
      (
        await authorizeInTransaction(
          tx,
          tenantId,
          tokenHash,
          now,
          DECISION_CREATE_GUARD
        )
      ).allowed;

    const id = params.id;
    if (!isUuid(id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Reservation not found.");
    }
    const link = await fetchReservationLinkByReservationId(tx, tenantId, id);
    if (!link) return fail(404, "RESOURCE_NOT_FOUND", "Reservation not found.");

    const result = await rescheduleBookingReservation(
      tx,
      {
        tenantId,
        actor: { kind: "staff", tenantUserId: auth.context.tenantUserId },
        correlationId: locals.correlationId ?? crypto.randomUUID(),
        port: await composedBookingPort(),
        mediaPort: mediaLibraryPortAdapter,
        canPlanRefund,
        now
      },
      {
        link,
        idempotencyKey: prepared.idempotencyKey,
        request: prepared.body
      }
    );
    if (result.kind === "refused") {
      return rescheduleRefusalResponse(result.refusal);
    }
    return ok(rescheduledBody(result.view, result.kind === "replayed"));
  }
});
