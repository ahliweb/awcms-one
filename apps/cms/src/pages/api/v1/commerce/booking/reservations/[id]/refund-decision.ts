/**
 * `GET /api/v1/commerce/booking/reservations/{id}/refund-decision` - the refund
 * decision of a cancelled reservation and the state of its refund legs (Issue
 * #381, ADR-0045 D8). `id` is BOOKING's reservation id. Gated on
 * `commerce.booking_refund_decisions.read` and the tenant's `booking` feature.
 * The body carries every figure, whether the refund was overridden and the
 * return that carries the legs - never the override reason or the actor, and no
 * customer (X7). An unknown id, another tenant's id and a reservation with no
 * decision are the same `404`.
 */
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import {
  refundDecisionBody,
  requireBookingFeature
} from "../../../../../../../modules/commerce/application/booking-adapter-http";
import {
  fetchDecisionForReservation,
  fetchDecisionReturn
} from "../../../../../../../modules/commerce/application/booking-cancellation";
import { COMMERCE_BOOKING_REFUND_DECISIONS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/booking-adapter-permissions";
import { isUuid } from "../../../../../../../modules/commerce/domain/register";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_REFUND_DECISIONS_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    const id = params.id;
    if (!isUuid(id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Refund decision not found.");
    }
    const decision = await fetchDecisionForReservation(tx, tenantId, id);
    if (!decision) {
      return fail(404, "RESOURCE_NOT_FOUND", "Refund decision not found.");
    }
    const carried = await fetchDecisionReturn(tx, tenantId, decision);
    return ok({
      ...refundDecisionBody(decision),
      return: carried
        ? {
            id: carried.id,
            status: carried.status,
            refundTotal: carried.refundTotal,
            legs: carried.refunds.map((leg) => ({
              id: leg.id,
              tenderType: leg.tenderType,
              amount: leg.amount,
              status: leg.status
            }))
          }
        : null
    });
  }
});
