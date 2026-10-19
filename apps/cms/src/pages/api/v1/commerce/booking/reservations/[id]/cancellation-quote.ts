/**
 * `GET /api/v1/commerce/booking/reservations/{id}/cancellation-quote` - the
 * non-binding refund quote of a reservation (Issue #381, ADR-0045 D6, contracts
 * section 3.5): which policy version applies, how many whole hours before the
 * ORIGINAL arrival the decision falls, the amount paid and the refund the policy
 * computes. Writes nothing. `id` is BOOKING's reservation id. Gated on
 * `commerce.booking_reservation_links.read` and the tenant's `booking` feature.
 * An unknown id and another tenant's id are the same `404`; a reservation that
 * is already decided, released or past cancelling is `409 INVALID_STATE`.
 */
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { composedBookingPort } from "../../../../../../../lib/composition/booking-port";
import {
  cancelRefusalResponse,
  cancellationQuoteBody,
  requireBookingFeature
} from "../../../../../../../modules/commerce/application/booking-adapter-http";
import { computeCancellationQuote } from "../../../../../../../modules/commerce/application/booking-cancellation";
import { fetchReservationLinkByReservationId } from "../../../../../../../modules/commerce/application/booking-reservation-links";
import { COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/booking-adapter-permissions";
import { isUuid } from "../../../../../../../modules/commerce/domain/register";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params, now }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    const id = params.id;
    if (!isUuid(id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Reservation not found.");
    }
    const link = await fetchReservationLinkByReservationId(tx, tenantId, id);
    if (!link) return fail(404, "RESOURCE_NOT_FOUND", "Reservation not found.");

    const outcome = await computeCancellationQuote(
      tx,
      tenantId,
      link,
      await composedBookingPort(),
      { now, staff: true }
    );
    if (!outcome.ok) return cancelRefusalResponse(outcome.refusal);
    return ok(cancellationQuoteBody(outcome.value.quote));
  }
});
