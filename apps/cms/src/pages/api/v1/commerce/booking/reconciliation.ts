/**
 * `GET /api/v1/commerce/booking/reconciliation` - the read-only booking
 * reconciliation report (Issue #380, threat control C-09): the active
 * reservation links whose order's LEDGER and whose Booking reservation disagree.
 *
 *   - `paid_without_confirm`: the ledger holds at least the release threshold
 *     but the reservation is `held` (the confirm is pending or failed) or
 *     already `expired` / `cancelled` (the deposit arrived after the hold lapsed);
 *   - `confirmed_without_deposit`: the reservation is confirmed or beyond but the
 *     ledger holds less than the threshold.
 *
 * It writes and repairs nothing - the attention flag is the work queue, this is
 * the audit that nothing slipped past it - and is bounded (200 rows,
 * `truncated` says when it cut). A route and not a script because it is a
 * tenant-scoped, permission-checked read an operator or a monitor can call on
 * demand under RLS; a scheduled job can call the same function later. Gated on
 * `commerce.booking_reservation_links.read` and the tenant's `booking` feature.
 */
import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { requireBookingFeature } from "../../../../../modules/commerce/application/booking-adapter-http";
import { reconcileBookingOrders } from "../../../../../modules/commerce/application/booking-reservation-reads";
import { COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/booking-adapter-permissions";

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    return ok(await reconcileBookingOrders(tx, tenantId));
  }
});
