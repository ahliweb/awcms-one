/**
 * `GET /api/v1/commerce/booking/reservations/{id}/reschedule-quote` - the
 * non-binding price of a reschedule (Issue #382, ADR-0045 D7, contracts section
 * 3.7; threat control C-39): how the night count changes, how the difference
 * would be carried (a supplementary order, a policy-limited refund, nothing), and
 * every figure the SERVER computed. Writes nothing. `id` is BOOKING's
 * reservation id. The query is exactly one of `startsAt` and
 * `checkInDate` + `checkOutDate`, plus an optional `resourceId` that makes the
 * answer carry Booking's availability for those dates on that resource; it can
 * never name a price (`400`). The answer also carries the server's clock
 * (`serverNow`), which the staff dialog uses for its earliest date instead of the
 * browser's.
 *
 * Gated on `commerce.booking_reservation_links.update` (the reschedule's own
 * key: a viewer who cannot move a booking does not probe prices for moving it)
 * and the tenant's `booking` feature. An unknown id and another tenant's id are
 * the same `404`; a reservation that is not confirmed or not active is `409
 * INVALID_STATE`. The reschedule itself prices again under the order lock, so
 * the quote is a preview, never a promise.
 */
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { composedBookingPort } from "../../../../../../../lib/composition/booking-port";
import { mediaLibraryPortAdapter } from "../../../../../../../modules/media-library/application/media-library-port-adapter";
import {
  requireBookingFeature,
  rescheduleQuoteBody,
  rescheduleRefusalResponse
} from "../../../../../../../modules/commerce/application/booking-adapter-http";
import { computeRescheduleQuote } from "../../../../../../../modules/commerce/application/booking-reschedule";
import { fetchReservationLinkByReservationId } from "../../../../../../../modules/commerce/application/booking-reservation-links";
import { COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/booking-adapter-permissions";
import { validateRescheduleQuoteQuery } from "../../../../../../../modules/commerce/domain/booking-reschedule";
import { isUuid } from "../../../../../../../modules/commerce/domain/register";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE,
  action: "update"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, params, url, now }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    const id = params.id;
    if (!isUuid(id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Reservation not found.");
    }
    const query = validateRescheduleQuoteQuery(url.searchParams);
    if (!query.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Request query failed validation.",
        {},
        query.errors
      );
    }
    const link = await fetchReservationLinkByReservationId(tx, tenantId, id);
    if (!link) return fail(404, "RESOURCE_NOT_FOUND", "Reservation not found.");

    const outcome = await computeRescheduleQuote(
      tx,
      tenantId,
      link,
      await composedBookingPort(),
      mediaLibraryPortAdapter,
      query.value,
      now
    );
    if (!outcome.ok) return rescheduleRefusalResponse(outcome.refusal);
    return ok(rescheduleQuoteBody(outcome.value.quote, now));
  }
});
