/**
 * `GET /api/v1/commerce/booking/reservations/{id}` - a reservation's link, its
 * order code, Booking's status and dates, the ledger-derived settlement
 * ("deposit paid X, balance due Y") and the attention flag (Issue #380,
 * contracts section 3.4). `id` is BOOKING's reservation id, resolved to its
 * link; an unknown id and another tenant's id are the same `404`. Gated on
 * `commerce.booking_reservation_links.read` and the tenant's `booking` feature.
 * The customer is never a field of the response (X7).
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  requireBookingFeature,
  reservationViewBody
} from "../../../../../../modules/commerce/application/booking-adapter-http";
import { buildReservationView } from "../../../../../../modules/commerce/application/booking-hold-to-order";
import { fetchReservationLinkByReservationId } from "../../../../../../modules/commerce/application/booking-reservation-links";
import { COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/booking-adapter-permissions";
import { isUuid } from "../../../../../../modules/commerce/domain/register";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    const id = params.id;
    if (!isUuid(id))
      return fail(404, "RESOURCE_NOT_FOUND", "Reservation not found.");

    const link = await fetchReservationLinkByReservationId(tx, tenantId, id);
    if (!link) return fail(404, "RESOURCE_NOT_FOUND", "Reservation not found.");
    const view = await buildReservationView(tx, tenantId, link);
    if (!view) return fail(404, "RESOURCE_NOT_FOUND", "Reservation not found.");
    return ok(
      reservationViewBody(view, {
        reason: link.attentionReason,
        open: link.attentionReason !== null && link.attentionResolvedAt === null
      })
    );
  }
});
