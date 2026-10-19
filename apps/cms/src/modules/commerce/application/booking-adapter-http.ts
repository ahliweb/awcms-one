/**
 * The HTTP plumbing the booking-adapter routes share (Issue #378, ADR-0045):
 * the `booking` feature gate and the one mapping of an adapter refusal to its
 * frozen error code (D14), declared once so four routes cannot drift into four
 * spellings. A mismatch or a foreign id is always the neutral `404`, never a more
 * specific code (control C-05).
 */
import { fail } from "../../_shared/api-response";
import {
  cancelRefusalHttp,
  type CancelRefusal
} from "../domain/booking-cancellation";
import {
  holdRefusalHttp,
  type HoldRefusal
} from "../domain/booking-hold-to-order";
import {
  rescheduleRefusalHttp,
  type RescheduleRefusal
} from "../domain/booking-reschedule";
import type { CancellationQuote, DecisionView } from "./booking-cancellation";
import type { BookingReservationView } from "./booking-hold-to-order";
import type { RescheduleQuote, RescheduleView } from "./booking-reschedule";
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

/** The recorded refund of a cancelled reservation as the view carries it. */
export type ReservationRefundSummary = {
  finalRefund: string;
  /** A manager or finance override made the refund differ from the policy's; the guest sees only that, never why or by whom. */
  adjusted: boolean;
  /** STAFF only. */
  computedRefund?: string;
  /** STAFF only. */
  decisionId?: string;
};

/** The refund summary a view carries: the shopper's is the amount and `adjusted`; the staff's adds the policy figure and the decision id. */
export function reservationRefundSummary(
  decision: DecisionView | null,
  audience: "staff" | "shopper"
): ReservationRefundSummary | null {
  if (!decision) return null;
  return audience === "staff"
    ? {
        finalRefund: decision.finalRefund,
        adjusted: decision.overridden,
        computedRefund: decision.computedRefund,
        decisionId: decision.id
      }
    : { finalRefund: decision.finalRefund, adjusted: decision.overridden };
}

/**
 * The `CommerceBookingReservationView` body. `attention` is the STAFF-only
 * flag; the shopper's view never carries it (contracts section 3.4). `refund`
 * is `null` until the reservation is cancelled (Issue #381).
 */
export function reservationViewBody(
  view: BookingReservationView,
  attention: { reason: string | null; open: boolean } | null,
  refund: ReservationRefundSummary | null = null
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
    refund
  };
}

/** Issue #381 - a cancellation / quote refusal as its HTTP code (ADR-0045 D14; `QUOTE_CHANGED` carries the fresh figure). */
export function cancelRefusalResponse(
  refusal: CancelRefusal,
  headers?: Record<string, string>
): Response {
  const mapped = cancelRefusalHttp(refusal);
  return fail(
    mapped.status,
    mapped.code,
    mapped.message,
    {},
    mapped.details,
    headers
  );
}

/** The `CommerceBookingCancellationQuote` body. No customer field, no actor (X7). */
export function cancellationQuoteBody(quote: CancellationQuote) {
  return {
    quotedAt: quote.quotedAt,
    startsAt: quote.startsAt,
    hoursBeforeStart: quote.hoursBeforeStart,
    reservationStatus: quote.reservationStatus,
    policySource: quote.policySource,
    policyId: quote.policyId,
    policyVersion: quote.policyVersion,
    refundBasis: quote.refundBasis,
    refundablePercent: quote.refundablePercent,
    amountPaid: quote.amountPaid,
    computedRefund: quote.computedRefund
  };
}

/** The STAFF body of a recorded decision: every figure and whether it was overridden (never the reason or the actor). */
export function refundDecisionBody(decision: DecisionView) {
  return {
    id: decision.id,
    triggerKind: decision.triggerKind,
    policySource: decision.policySource,
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    hoursBeforeStart: decision.hoursBeforeStart,
    refundablePercent: decision.refundablePercent,
    amountPaid: decision.amountPaid,
    computedRefund: decision.computedRefund,
    finalRefund: decision.finalRefund,
    overridden: decision.overridden,
    // Issue #382 - a no-show: what the policy retained (a cancellation: null).
    retainedAmount: decision.retainedAmount,
    returnId: decision.returnId,
    createdAt: decision.createdAt
  };
}

/** The SHOPPER's body: the status and the amount only (contracts 3.5; never the policy internals, the reason or the actor). */
export function shopperDecisionBody(decision: DecisionView) {
  return { status: "cancelled" as const, finalRefund: decision.finalRefund };
}

/** The anonymous namespace tag of a guest: a digest of the normalised phone (the raw number is not written into a key). */
export function guestPhoneKey(phone: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(phone)
    .digest("hex")
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// Issue #382 - reschedule and no-show
// ---------------------------------------------------------------------------

/** A reschedule / no-show refusal as its HTTP code (ADR-0045 D14; `NO_SHOW_TOO_EARLY` keeps Booking's code). */
export function rescheduleRefusalResponse(
  refusal: RescheduleRefusal,
  headers?: Record<string, string>
): Response {
  const mapped = rescheduleRefusalHttp(refusal);
  return fail(
    mapped.status,
    mapped.code,
    mapped.message,
    {},
    mapped.details,
    headers
  );
}

/**
 * The `CommerceBookingRescheduleQuote` body: how the night count changes, how
 * the difference would be carried and every figure the SERVER computed. No
 * customer field (X7).
 */
export function rescheduleQuoteBody(quote: RescheduleQuote, now: Date) {
  return {
    serverNow: now.toISOString(),
    currentNights: quote.currentNights,
    newNights: quote.newNights,
    direction: quote.direction,
    vehicle: quote.vehicle,
    pricedAmount: quote.pricedAmount,
    refundAmount: quote.refundAmount,
    policySource: quote.policySource,
    policyId: quote.policyId,
    policyVersion: quote.policyVersion,
    hoursBeforeStart: quote.hoursBeforeStart,
    refundablePercent: quote.refundablePercent,
    availability: quote.availability
  };
}

/**
 * The `CommerceBookingRescheduled` body: the replacement reservation on the
 * SAME order, the superseded reservation, and the difference with the order it
 * created (a supplementary order, whose code the customer pays) or the return
 * that carries the refund. No customer field (X7).
 */
export function rescheduledBody(view: RescheduleView, replayed: boolean) {
  const record = view.record;
  return {
    replayed,
    rescheduleId: record.id,
    orderId: view.reservation.orderId,
    orderCode: view.reservation.orderCode,
    reservation: {
      id: view.reservation.reservationId,
      reservationNo: view.reservation.reservationNo,
      status: view.reservation.status,
      startsAt: view.reservation.startsAt,
      endsAt: view.reservation.endsAt
    },
    supersededReservationId: view.supersededReservationId,
    fromNights: record.fromNights,
    toNights: record.toNights,
    priceDifference: {
      direction: record.direction,
      vehicle:
        record.direction === "charge"
          ? ("supplementary_order" as const)
          : record.returnId !== null
            ? ("refund_return" as const)
            : null,
      pricedAmount: record.pricedAmount,
      refundAmount: record.refundAmount,
      supplementOrder: view.supplementOrder
        ? {
            orderId: view.supplementOrder.orderId,
            orderCode: view.supplementOrder.orderCode,
            status: view.supplementOrder.status,
            total: view.supplementOrder.total
          }
        : null,
      returnId: record.returnId,
      policySource: record.policySource,
      policyVersion: record.policyVersion,
      hoursBeforeStart: record.hoursBeforeStart,
      refundablePercent: record.refundablePercent
    },
    settlement: view.reservation.settlement
  };
}
