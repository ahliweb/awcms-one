/**
 * Pure rules of the booking reschedule (Issue #382, ADR-0045 D7 as amended by the
 * coordinator for #382, contracts section 3.7; threat controls C-37, C-38, C-39).
 * No database, no clock, no I/O.
 *
 * ## What a request may say
 *
 * EXACTLY ONE of `startsAt` (a slot) and `stay` (`checkInDate` / `checkOutDate`,
 * local dates), optionally the `resourceId` to move to and a short lowercase
 * `reasonCode` for the audit row. It NEVER says a price, a difference, a refund,
 * a total or an order: the difference is computed by the server in integer cents
 * (control C-39) and a body naming one of those fields is a `400`, exactly as the
 * hold-to-order and cancel bodies refuse theirs.
 *
 * ## The price difference is the night difference, priced by the order path
 *
 * Price is the linked product's price times the nights (Q1), so the difference
 * between two reschedules exists only when the stay changes LENGTH:
 *
 *   - the same number of nights (or any slot): nothing is priced, only the
 *     reference moves;
 *   - MORE nights: the extra nights are a supplementary ORDER created by the
 *     ordinary order path (priced by the cart quote, paid by the ordinary payment
 *     paths). The paid order, its lines and its allocations are never edited;
 *   - FEWER nights: the value of the removed nights is refunded as pending legs
 *     of a return of kind `cancellation`, but only as far as the cancellation
 *     policy of the ORIGINAL booking allows from the ORIGINAL start (a reschedule
 *     can never buy a better window than a cancel would) and never above what
 *     was paid.
 *
 * The value of removed nights is a share of the order total, cumulative over the
 * order's earlier reductions (`nightsValueCents`), so a chain of reductions can
 * never refund more than the order is worth and rounding never drifts.
 */
import type { BookingRefusal } from "../../_shared/ports/booking-port";
import { isRecord, type ValidationError } from "./payment-allocation";
import { isUuid } from "./register";
import { holdRefusalHttp, nightsBetween } from "./booking-hold-to-order";

export type { ValidationError };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const REASON_CODE = /^[a-z][a-z0-9_]{2,39}$/;

/** The reason recorded when a request names none. */
export const DEFAULT_RESCHEDULE_REASON_CODE = "staff_reschedule";

/** Names no reschedule body may carry: every figure is the server's (C-39). */
const MONEY_KEYS = [
  "amount",
  "price",
  "total",
  "difference",
  "priceDifference",
  "pricedAmount",
  "refund",
  "refundAmount",
  "finalRefund",
  "final_refund",
  "supplement",
  "supplementOrder",
  "orderId",
  "orderCode",
  "paymentMethod",
  "deposit"
] as const;

export type RescheduleRequest = {
  /** Exactly one of the two. */
  startsAt: string | null;
  stay: { checkInDate: string; checkOutDate: string } | null;
  /** Move elsewhere; `null` = where the reservation is. */
  resourceId: string | null;
  reasonCode: string;
};

export function validateRescheduleRequest(
  body: unknown
): ValidationResult<RescheduleRequest> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const allowed = ["startsAt", "stay", "resourceId", "reasonCode"];
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    errors.push({
      field: key,
      message: (MONEY_KEYS as readonly string[]).includes(key)
        ? `${key} is not accepted: the server prices the difference.`
        : `${key} is not a known field.`
    });
  }

  const hasStarts = record.startsAt !== undefined && record.startsAt !== null;
  const hasStay = record.stay !== undefined && record.stay !== null;
  let startsAt: string | null = null;
  let stay: RescheduleRequest["stay"] = null;
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
    const extra = Object.keys(record.stay).filter(
      (key) => key !== "checkInDate" && key !== "checkOutDate"
    );
    for (const key of extra) {
      errors.push({
        field: `stay.${key}`,
        message: `${key} is not a known field.`
      });
    }
    const checkIn = record.stay.checkInDate;
    const checkOut = record.stay.checkOutDate;
    if (
      typeof checkIn !== "string" ||
      typeof checkOut !== "string" ||
      !LOCAL_DATE.test(checkIn) ||
      !LOCAL_DATE.test(checkOut) ||
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

  let resourceId: string | null = null;
  if (record.resourceId !== undefined && record.resourceId !== null) {
    if (!isUuid(record.resourceId)) {
      errors.push({
        field: "resourceId",
        message: "resourceId must be a uuid."
      });
    } else {
      resourceId = record.resourceId;
    }
  }

  let reasonCode = DEFAULT_RESCHEDULE_REASON_CODE;
  if (record.reasonCode !== undefined && record.reasonCode !== null) {
    if (
      typeof record.reasonCode !== "string" ||
      !REASON_CODE.test(record.reasonCode)
    ) {
      errors.push({
        field: "reasonCode",
        message:
          "reasonCode must be a short lowercase code (letters, digits, underscore), never free text."
      });
    } else {
      reasonCode = record.reasonCode;
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { startsAt, stay, resourceId, reasonCode }
  };
}

/**
 * The query of the reschedule quote (`GET ...`): the same "exactly one of
 * startsAt and checkInDate+checkOutDate", from the URL's search parameters, and
 * an optional `resourceId` (only to ask Booking whether that resource is free).
 */
export function validateRescheduleQuoteQuery(
  query: URLSearchParams
): ValidationResult<
  Pick<RescheduleRequest, "startsAt" | "stay" | "resourceId">
> {
  const errors: ValidationError[] = [];
  for (const key of query.keys()) {
    if (
      !["startsAt", "checkInDate", "checkOutDate", "resourceId"].includes(key)
    ) {
      errors.push({
        field: key,
        message: (MONEY_KEYS as readonly string[]).includes(key)
          ? `${key} is not accepted: the server prices the difference.`
          : `${key} is not a known parameter.`
      });
    }
  }
  const startsAt = query.get("startsAt");
  const checkIn = query.get("checkInDate");
  const checkOut = query.get("checkOutDate");
  const resourceId = query.get("resourceId");
  const body: Record<string, unknown> = {};
  if (resourceId !== null) body.resourceId = resourceId;
  if (startsAt !== null) body.startsAt = startsAt;
  if (checkIn !== null || checkOut !== null) {
    body.stay = { checkInDate: checkIn, checkOutDate: checkOut };
  }
  const parsed = validateRescheduleRequest(body);
  if (!parsed.valid) errors.push(...parsed.errors);
  if (errors.length > 0 || !parsed.valid) return { valid: false, errors };
  return {
    valid: true,
    value: {
      startsAt: parsed.value.startsAt,
      stay: parsed.value.stay,
      resourceId: parsed.value.resourceId
    }
  };
}

// ---------------------------------------------------------------------------
// The night difference and its value
// ---------------------------------------------------------------------------

export type DifferenceDirection = "none" | "charge" | "refund";

/** The direction is the sign of the night difference, nothing else. */
export function differenceDirection(
  fromNights: number,
  toNights: number
): DifferenceDirection {
  if (toNights > fromNights) return "charge";
  if (toNights < fromNights) return "refund";
  return "none";
}

/** The nights a request asks for: a stay's night count, or 1 for a slot. */
export function requestedNights(
  request: Pick<RescheduleRequest, "startsAt" | "stay">
): number | null {
  if (request.stay) {
    return nightsBetween(request.stay.checkInDate, request.stay.checkOutDate);
  }
  return request.startsAt ? 1 : null;
}

/**
 * The value, in cents, of `removing` nights taken off an order that sold
 * `soldNights` for `totalCents`, when `alreadyRemoved` nights were taken off
 * before: a CUMULATIVE share (`floor(total * n / sold)`), so the values of a
 * chain of reductions add up to the share of the nights removed in all, never
 * to more, and never drift by a cent per step. Never above the order total.
 */
export function nightsValueCents(
  totalCents: bigint,
  soldNights: number,
  alreadyRemoved: number,
  removing: number
): bigint {
  if (
    totalCents <= 0n ||
    soldNights < 1 ||
    removing < 1 ||
    alreadyRemoved < 0
  ) {
    return 0n;
  }
  const sold = BigInt(soldNights);
  const share = (nights: number): bigint =>
    (totalCents * BigInt(Math.min(nights, soldNights))) / sold;
  const value = share(alreadyRemoved + removing) - share(alreadyRemoved);
  return value > 0n ? value : 0n;
}

/**
 * Whether a reduction of `removing` nights can be taken from the booking's main
 * order: the order keeps at least one night (`soldNights - alreadyRemoved - 1`
 * is the room). Nights above that were sold on a supplementary order and are
 * settled with that order, not here.
 */
export function reductionRoom(
  soldNights: number,
  alreadyRemoved: number
): number {
  return Math.max(0, soldNights - alreadyRemoved - 1);
}

// ---------------------------------------------------------------------------
// Refusals and their HTTP mapping
// ---------------------------------------------------------------------------

/**
 * Every refusal of a reschedule, its quote or a no-show as a value. The route
 * maps it with {@link rescheduleRefusalHttp} AFTER the transaction, so a refusal
 * never rides a `4xx` out of `withTenant` with a half-written reschedule.
 */
export type RescheduleRefusal =
  | { code: "FEATURE_DISABLED" }
  | { code: "RESERVATION_NOT_FOUND" }
  | { code: "SERVICE_ACTOR_NOT_CONFIGURED" }
  | { code: "INVALID_STATE"; reason: string }
  | { code: "IDEMPOTENCY_CONFLICT" }
  | { code: "QUANTITY_BASIS_MISMATCH" }
  | { code: "NOT_A_CHANGE" }
  | { code: "REFERENCE_MISMATCH" }
  | { code: "BALANCE_OUTSTANDING"; outstanding: string }
  | { code: "REDUCTION_NOT_SUPPORTED"; roomNights: number }
  | { code: "SUPPLEMENT_UNAVAILABLE" }
  | { code: "BOOKING"; reason: BookingRefusal };

export function rescheduleRefusalHttp(refusal: RescheduleRefusal): {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  switch (refusal.code) {
    case "FEATURE_DISABLED":
      return {
        status: 409,
        code: "FEATURE_DISABLED",
        message: 'The "booking" feature is disabled for this tenant.'
      };
    case "RESERVATION_NOT_FOUND":
      return {
        status: 404,
        code: "RESOURCE_NOT_FOUND",
        message: "Reservation not found."
      };
    case "SERVICE_ACTOR_NOT_CONFIGURED":
      return {
        status: 409,
        code: "BOOKING_SERVICE_ACTOR_NOT_CONFIGURED",
        message:
          "Name an active service-account user for bookings in the store settings."
      };
    case "INVALID_STATE":
      return {
        status: 409,
        code: "INVALID_STATE",
        message: `The reservation cannot be changed now (${refusal.reason}).`
      };
    case "IDEMPOTENCY_CONFLICT":
      return {
        status: 409,
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency-Key was already used with a different request."
      };
    case "QUANTITY_BASIS_MISMATCH":
      return {
        status: 409,
        code: "QUANTITY_BASIS_MISMATCH",
        message:
          "Send stay for a night-based reservation and startsAt for a time-slot one."
      };
    case "NOT_A_CHANGE":
      return {
        status: 409,
        code: "RESCHEDULE_NOT_A_CHANGE",
        message: "The new dates are the reservation's current dates."
      };
    case "REFERENCE_MISMATCH":
      return {
        status: 409,
        code: "BOOKING_REFERENCE_MISMATCH",
        message:
          "The Booking reservation does not name this order; an operator must reconcile it first."
      };
    case "BALANCE_OUTSTANDING":
      return {
        status: 409,
        code: "BALANCE_OUTSTANDING",
        message:
          "A shorter stay is refunded only on a fully paid order. Settle the balance first, or cancel and rebook.",
        details: { outstanding: refusal.outstanding }
      };
    case "REDUCTION_NOT_SUPPORTED":
      return {
        status: 409,
        code: "REDUCTION_NOT_SUPPORTED",
        message:
          "That many nights were sold on a supplementary order and are settled with it. Cancel and rebook the stay instead.",
        details: { reducibleNights: refusal.roomNights }
      };
    case "SUPPLEMENT_UNAVAILABLE":
      return {
        status: 409,
        code: "SUPPLEMENT_ORDER_UNAVAILABLE",
        message:
          "The extra nights cannot be sold right now (the product is unavailable or no payment method is open)."
      };
    case "BOOKING":
      // Booking's own refusal keeps Booking's code (NO_SHOW_TOO_EARLY and the
      // rest) through the one mapping every adapter route shares.
      return holdRefusalHttp({ code: "BOOKING", reason: refusal.reason });
  }
}

// ---------------------------------------------------------------------------
// Identity of one request
// ---------------------------------------------------------------------------

/** A closed, serialisable description of the request, hashed (keyed) into the record's `request_hash`. */
export function rescheduleRequestFingerprint(
  actorTag: string,
  linkId: string,
  request: RescheduleRequest
): Record<string, unknown> {
  return {
    scope: "commerce.booking_reservations.reschedule",
    actor: actorTag,
    linkId,
    startsAt: request.startsAt,
    stay: request.stay,
    resourceId: request.resourceId,
    reasonCode: request.reasonCode
  };
}
