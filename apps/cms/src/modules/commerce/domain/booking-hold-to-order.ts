/**
 * Pure rules of the hold-to-order path (Issue #380, ADR-0045 G2/G4/G5/G10;
 * contracts section 3.2). No database, no clock, no I/O.
 *
 * ## What a request may say
 *
 * `offeringId`, `resourceId`, EXACTLY ONE of `startsAt` (a slot) and `stay`
 * (`checkInDate`/`checkOutDate`, local dates), `partySize`, the guest's contact
 * (anonymous and staff calls; ignored for a signed-in shopper), a payment
 * `method` and optional `notes`. It NEVER says a price, an amount, a deposit or
 * a customer id: the price comes from the product, the deposit from its policy,
 * the customer from the bearer session or the guest's phone. A body naming one
 * of those fields is a `400`, exactly as the offering-link body does.
 *
 * ## Refusals
 *
 * Every refusal of the path is a value of {@link HoldRefusal}; the route maps
 * it to an HTTP code with {@link holdRefusalHttp} AFTER the transaction, so a
 * refusal never rides a `4xx` out of `withTenant` with a half-written order.
 * Booking's own refusals keep Booking's code (contracts section 4).
 */
import type { BookingRefusal } from "../../_shared/ports/booking-port";
import { isRecord, type ValidationError } from "./payment-allocation";
import { isUuid } from "./register";
import type { PaymentMethod } from "./commerce-order-types";

export type { ValidationError };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

/** The payment methods a booking order may name (the storefront allow-list; `cash` is the POS check-in of a later issue). */
export const BOOKING_PAYMENT_METHODS: readonly PaymentMethod[] = [
  "manual_bank",
  "manual_qris",
  "dp",
  "gateway"
];

export type BookingGuestInput = {
  name: string;
  phone: string;
  email: string | null;
};

export type BookingReservationRequest = {
  offeringId: string;
  resourceId: string;
  /** Exactly one of the two. */
  startsAt: string | null;
  stay: { checkInDate: string; checkOutDate: string } | null;
  partySize: number;
  guest: BookingGuestInput | null;
  paymentMethod: PaymentMethod;
  notes: string | null;
};

const FORBIDDEN_KEYS = [
  "amount",
  "price",
  "total",
  "deposit",
  "dpAmount",
  "expectedAmount",
  "customerId",
  "customer",
  "orderId",
  "status"
] as const;

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** A defensive ceiling on nights, above Booking's own `max_nights` (a refusal there is the real limit). */
export const MAX_STAY_NIGHTS = 366;

function dayNumber(date: string): number | null {
  if (!LOCAL_DATE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  // Date.parse rolls 2031-02-30 over; round-trip to refuse it.
  if (new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return Math.round(ms / 86_400_000);
}

/**
 * Nights between two local dates (check-out exclusive), or `null` when either
 * is not a real calendar date or the range is empty/reversed/over the ceiling.
 * A night is a calendar concept (ADR-0135): plain date arithmetic, no zone.
 */
export function nightsBetween(
  checkInDate: string,
  checkOutDate: string
): number | null {
  const from = dayNumber(checkInDate);
  const to = dayNumber(checkOutDate);
  if (from === null || to === null) return null;
  const nights = to - from;
  return nights >= 1 && nights <= MAX_STAY_NIGHTS ? nights : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/**
 * Validates the shared body. `guestRequired` is true for the anonymous
 * storefront call (the bearer branch ignores the guest block, so the route
 * decides after authenticating) and for the staff call.
 */
export function validateBookingReservationRequest(
  body: unknown
): ValidationResult<BookingReservationRequest> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const allowed = [
    "offeringId",
    "resourceId",
    "startsAt",
    "stay",
    "partySize",
    "guest",
    "payment",
    "notes"
  ];
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    errors.push({
      field: key,
      message: (FORBIDDEN_KEYS as readonly string[]).includes(key)
        ? `${key} is not accepted: the server derives it.`
        : `${key} is not a known field.`
    });
  }

  if (!isUuid(record.offeringId)) {
    errors.push({ field: "offeringId", message: "offeringId must be a uuid." });
  }
  if (!isUuid(record.resourceId)) {
    errors.push({
      field: "resourceId",
      message: "resourceId must be a uuid (a pool is not offered in v1)."
    });
  }

  const hasStarts = record.startsAt !== undefined && record.startsAt !== null;
  const hasStay = record.stay !== undefined && record.stay !== null;
  let startsAt: string | null = null;
  let stay: BookingReservationRequest["stay"] = null;
  if (hasStarts === hasStay) {
    errors.push({
      field: hasStarts ? "stay" : "startsAt",
      message: "Send exactly one of startsAt (a slot) and stay (a night range)."
    });
  } else if (hasStarts) {
    if (typeof record.startsAt !== "string" || !INSTANT.test(record.startsAt)) {
      errors.push({
        field: "startsAt",
        message: "startsAt must be an RFC 3339 UTC instant ending in Z."
      });
    } else {
      startsAt = record.startsAt;
    }
  } else if (isRecord(record.stay)) {
    const checkIn = record.stay.checkInDate;
    const checkOut = record.stay.checkOutDate;
    if (
      typeof checkIn !== "string" ||
      typeof checkOut !== "string" ||
      nightsBetween(checkIn, checkOut) === null
    ) {
      errors.push({
        field: "stay",
        message:
          "stay needs real local dates checkInDate < checkOutDate (YYYY-MM-DD)."
      });
    } else {
      stay = { checkInDate: checkIn, checkOutDate: checkOut };
    }
  } else {
    errors.push({ field: "stay", message: "stay must be an object." });
  }

  const partySize = record.partySize;
  if (
    typeof partySize !== "number" ||
    !Number.isInteger(partySize) ||
    partySize < 1 ||
    partySize > 500
  ) {
    errors.push({
      field: "partySize",
      message: "partySize must be a whole number from 1 to 500."
    });
  }

  let guest: BookingGuestInput | null = null;
  if (record.guest !== undefined && record.guest !== null) {
    if (!isRecord(record.guest)) {
      errors.push({ field: "guest", message: "guest must be an object." });
    } else {
      const name = text(record.guest.name, 200);
      const phone = text(record.guest.phone, 30);
      const email =
        record.guest.email === undefined || record.guest.email === null
          ? null
          : text(record.guest.email, 320);
      if (!name)
        errors.push({
          field: "guest.name",
          message: "guest.name is required."
        });
      if (!phone)
        errors.push({
          field: "guest.phone",
          message: "guest.phone is required."
        });
      if (record.guest.email !== undefined && record.guest.email !== null) {
        if (email === null) {
          errors.push({
            field: "guest.email",
            message: "guest.email must be at most 320 characters."
          });
        }
      }
      if (name && phone) guest = { name, phone, email };
    }
  }

  let paymentMethod: PaymentMethod = "manual_bank";
  if (!isRecord(record.payment)) {
    errors.push({
      field: "payment.method",
      message: "payment.method is required."
    });
  } else {
    const method = record.payment.method;
    if (
      typeof method !== "string" ||
      !(BOOKING_PAYMENT_METHODS as readonly string[]).includes(method)
    ) {
      errors.push({
        field: "payment.method",
        message: `payment.method must be one of ${BOOKING_PAYMENT_METHODS.join(", ")}.`
      });
    } else {
      paymentMethod = method as PaymentMethod;
    }
  }

  let notes: string | null = null;
  if (record.notes !== undefined && record.notes !== null) {
    notes = text(record.notes, 500);
    if (notes === null) {
      errors.push({
        field: "notes",
        message: "notes must be 1 to 500 characters."
      });
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      offeringId: record.offeringId as string,
      resourceId: record.resourceId as string,
      startsAt,
      stay,
      partySize: partySize as number,
      guest,
      paymentMethod,
      notes
    }
  };
}

/** Who is asking, as the idempotency namespace needs to know it (G5). */
export type BookingRequestActor =
  | { kind: "staff"; tenantUserId: string }
  | { kind: "customer"; customerId: string }
  | { kind: "guest"; phoneKey: string };

/**
 * The namespace tag of a client key: a different actor with the same
 * `Idempotency-Key` addresses a different key, so a colleague or a stranger can
 * neither claim nor replay another actor's hold (G5, ADR-0145's lesson).
 */
export function actorNamespace(actor: BookingRequestActor): string {
  switch (actor.kind) {
    case "staff":
      return `staff:${actor.tenantUserId}`;
    case "customer":
      return `cust:${actor.customerId}`;
    case "guest":
      return `anon:${actor.phoneKey}`;
  }
}

/** A closed, serialisable description of the request, hashed (keyed) into the link's `request_hash`. */
export function requestFingerprint(
  actorTag: string,
  request: BookingReservationRequest
): Record<string, unknown> {
  return {
    scope: "commerce.booking_reservations.create",
    actor: actorTag,
    offeringId: request.offeringId,
    resourceId: request.resourceId,
    startsAt: request.startsAt,
    stay: request.stay,
    partySize: request.partySize,
    // A signed-in shopper's guest block is ignored, so it is not part of what was asked.
    guest: request.guest,
    paymentMethod: request.paymentMethod,
    notes: request.notes
  };
}

/** The refusals of the whole path; the route maps them with {@link holdRefusalHttp}. */
export type HoldRefusal =
  | { code: "FEATURE_DISABLED" }
  | { code: "SERVICE_ACTOR_NOT_CONFIGURED" }
  | { code: "OFFERING_NOT_LINKED" }
  | { code: "OFFERING_NOT_LINKABLE" }
  | { code: "QUANTITY_BASIS_MISMATCH" }
  | { code: "IDEMPOTENCY_CONFLICT" }
  | { code: "INVALID_PHONE" }
  | { code: "ACCOUNT_BLOCKED" }
  | { code: "CART_CHANGED"; quote?: unknown }
  | { code: "PAYMENT_METHOD_UNAVAILABLE" }
  | { code: "BOOKING"; reason: BookingRefusal };

/** Booking refusals that are a malformed request, not a state of the world. */
const BOOKING_BAD_REQUEST: ReadonlySet<BookingRefusal> = new Set([
  "VALIDATION_ERROR",
  "PAYMENT_FIELD_NOT_ACCEPTED",
  "RESOURCE_REQUIRED"
]);
const BOOKING_NOT_FOUND: ReadonlySet<BookingRefusal> = new Set([
  "RESOURCE_NOT_FOUND",
  "OFFERING_NOT_FOUND",
  "RESERVATION_NOT_FOUND"
]);

export function holdRefusalHttp(refusal: HoldRefusal): {
  status: number;
  code: string;
  message: string;
} {
  switch (refusal.code) {
    case "FEATURE_DISABLED":
      return {
        status: 409,
        code: "FEATURE_DISABLED",
        message: 'The "booking" feature is disabled for this tenant.'
      };
    case "SERVICE_ACTOR_NOT_CONFIGURED":
      return {
        status: 409,
        code: "BOOKING_SERVICE_ACTOR_NOT_CONFIGURED",
        message:
          "Name an active service-account user for bookings in the store settings."
      };
    case "OFFERING_NOT_LINKED":
      return {
        status: 409,
        code: "OFFERING_NOT_LINKED",
        message: "This offering is not linked to a product for sale."
      };
    case "OFFERING_NOT_LINKABLE":
      return {
        status: 409,
        code: "OFFERING_NOT_LINKABLE",
        message:
          "This offering confirms without payment (or is inactive) and cannot be sold."
      };
    case "QUANTITY_BASIS_MISMATCH":
      return {
        status: 409,
        code: "QUANTITY_BASIS_MISMATCH",
        message:
          "Send stay for a night-based offering and startsAt for a time-slot offering."
      };
    case "IDEMPOTENCY_CONFLICT":
      return {
        status: 409,
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency-Key was already used with a different request."
      };
    case "INVALID_PHONE":
      return {
        status: 400,
        code: "VALIDATION_ERROR",
        message: "guest.phone is not a valid Indonesian phone number."
      };
    case "ACCOUNT_BLOCKED":
      return {
        status: 403,
        code: "ACCOUNT_BLOCKED",
        message: "This account is blocked."
      };
    case "CART_CHANGED":
      return {
        status: 409,
        code: "CART_CHANGED",
        message:
          "The product is no longer available as priced; check it and try again."
      };
    case "PAYMENT_METHOD_UNAVAILABLE":
      return {
        status: 409,
        code: "PAYMENT_METHOD_UNAVAILABLE",
        message: "That payment method is not available for this booking."
      };
    case "BOOKING": {
      const reason = refusal.reason;
      if (reason === "HOLD_LIMIT_EXCEEDED") {
        return {
          status: 429,
          code: "HOLD_LIMIT_EXCEEDED",
          message: "Too many live holds. Complete or release one first."
        };
      }
      if (BOOKING_BAD_REQUEST.has(reason)) {
        return {
          status: 400,
          code: "VALIDATION_ERROR",
          message: `Booking refused the request (${reason}).`
        };
      }
      if (BOOKING_NOT_FOUND.has(reason)) {
        return {
          status: 404,
          code: "RESOURCE_NOT_FOUND",
          message: "Booking resource or offering not found."
        };
      }
      // Issue #382 - the two timing refusals of BookingPort 1.1.0 keep their own
      // code (and a message that says what to wait for) instead of the generic one.
      if (reason === "NO_SHOW_TOO_EARLY") {
        return {
          status: 409,
          code: "NO_SHOW_TOO_EARLY",
          message:
            "A no-show can be marked only after the arrival time plus the grace period."
        };
      }
      if (reason === "CHECK_IN_TOO_EARLY") {
        return {
          status: 409,
          code: "CHECK_IN_TOO_EARLY",
          message: "The guest cannot be checked in before the check-in date."
        };
      }
      return {
        status: 409,
        code: reason,
        message: `Booking refused the request (${reason}).`
      };
    }
  }
}
