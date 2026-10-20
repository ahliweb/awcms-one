/**
 * The HTTP plumbing the booking-adapter routes share (Issue #378, ADR-0045):
 * the `booking` feature gate and the one mapping of an adapter refusal to its
 * frozen error code (D14), declared once so four routes cannot drift into four
 * spellings. A mismatch or a foreign id is always the neutral `404`, never a more
 * specific code (control C-05).
 */
import { fail } from "../../_shared/api-response";
import {
  holdRefusalHttp,
  type HoldRefusal
} from "../domain/booking-hold-to-order";
import type { BookingReservationView } from "./booking-hold-to-order";
import { requireCommerceFeatureForOwnerRoute } from "./commerce-feature-gate";

export { readValidatedBody, requireIdempotencyKey } from "./register-http";
export { idempotencyErrorResponse } from "./register-http";

/** `409 FEATURE_DISABLED` while the tenant's `booking` feature is off, else `null`. */
export function requireBookingFeature(
  tx: Bun.SQL,
  tenantId: string
): Promise<Response | null> {
  return requireCommerceFeatureForOwnerRoute(tx, tenantId, "booking");
}

/** A refusal of an offering-link write. `created` and `replayed` are the successes. */
export type OfferingLinkRefusal =
  | "offering_not_found"
  | "product_not_found"
  | "offering_not_linkable"
  | "offering_already_linked"
  | "product_already_linked"
  | "product_not_service"
  | "quantity_basis_mismatch"
  | "service_actor_not_configured";

const REFUSALS: Record<
  OfferingLinkRefusal,
  { status: number; code: string; message: string }
> = {
  offering_not_found: {
    status: 404,
    code: "RESOURCE_NOT_FOUND",
    message: "Booking offering not found."
  },
  product_not_found: {
    status: 404,
    code: "RESOURCE_NOT_FOUND",
    message: "Product not found."
  },
  offering_not_linkable: {
    status: 409,
    code: "OFFERING_NOT_LINKABLE",
    message:
      "This offering confirms without payment (or is inactive) and cannot be sold. Use a hold-then-confirm offering."
  },
  offering_already_linked: {
    status: 409,
    code: "OFFERING_ALREADY_LINKED",
    message: "This offering already has an active product link."
  },
  product_already_linked: {
    status: 409,
    code: "PRODUCT_ALREADY_LINKED",
    message: "This product is already linked to an active offering."
  },
  product_not_service: {
    status: 409,
    code: "PRODUCT_NOT_SERVICE",
    message: "Only a service product can be linked to a Booking offering."
  },
  quantity_basis_mismatch: {
    status: 409,
    code: "QUANTITY_BASIS_MISMATCH",
    message:
      "quantityBasis must be nights for a stay offering and booking for a time-slot offering."
  },
  service_actor_not_configured: {
    status: 409,
    code: "BOOKING_SERVICE_ACTOR_NOT_CONFIGURED",
    message:
      "Name an active service-account user for bookings in the store settings before linking an offering."
  }
};

export function offeringLinkRefusalResponse(
  refusal: OfferingLinkRefusal
): Response {
  const entry = REFUSALS[refusal];
  return fail(entry.status, entry.code, entry.message);
}

/** Issue #380 - a hold-to-order refusal as its frozen HTTP code (ADR-0045 D14, contracts section 4). `CART_CHANGED` carries the fresh quote. */
export function holdRefusalResponse(
  refusal: HoldRefusal,
  headers?: Record<string, string>
): Response {
  const mapped = holdRefusalHttp(refusal);
  return fail(
    mapped.status,
    mapped.code,
    mapped.message,
    {},
    refusal.code === "CART_CHANGED" && refusal.quote !== undefined
      ? { quote: refusal.quote }
      : undefined,
    headers
  );
}

/** The `CommerceBookingReservationCreated` body. No customer field: the customer is derived through the order (X7). */
export function createdReservationBody(
  view: BookingReservationView,
  replayed: boolean
) {
  return {
    replayed,
    orderId: view.orderId,
    orderCode: view.orderCode,
    reservation: {
      id: view.reservationId,
      reservationNo: view.reservationNo,
      status: view.status,
      holdExpiresAt: view.holdExpiresAt,
      startsAt: view.startsAt,
      endsAt: view.endsAt
    },
    settlement: view.settlement
  };
}

/**
 * The `CommerceBookingReservationView` body. `attention` is the STAFF-only
 * flag; the shopper's view never carries it (contracts section 3.4). `refund`
 * stays `null` until the cancellation issue records decisions.
 */
export function reservationViewBody(
  view: BookingReservationView,
  attention: { reason: string | null; open: boolean } | null
) {
  return {
    reservationId: view.reservationId,
    reservationNo: view.reservationNo,
    orderId: view.orderId,
    orderCode: view.orderCode,
    orderStatus: view.orderStatus,
    status: view.status,
    linkStatus: view.linkStatus,
    holdExpiresAt: view.holdExpiresAt,
    startsAt: view.startsAt,
    endsAt: view.endsAt,
    settlement: view.settlement,
    ...(attention
      ? {
          attentionReason: attention.reason,
          attentionOpen: attention.open
        }
      : {}),
    refund: null
  };
}
