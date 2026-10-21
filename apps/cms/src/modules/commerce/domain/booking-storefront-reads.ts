/**
 * Pure rules of the anonymous booking READS the storefront pages call (Issue
 * #386, ADR-0045 implementation notes): bookable offerings, availability and the
 * server quote. No database, no clock of its own (the caller passes `now`), no
 * I/O.
 *
 * ## What an anonymous caller may ask, and may learn
 *
 * Every query parameter is on an allow-list; one that is not is a `400` (a
 * `tenantId` or a `customerId` in the query is rejected, never ignored, exactly
 * as the write routes treat a forbidden body key). Windows are bounded here, on
 * top of the port's own bound (31 days of slots), because a public page is the
 * caller that loops: a stay is 1 to {@link MAX_STAY_NIGHTS} nights, a slot window
 * at most {@link AVAILABILITY_MAX_SLOT_WINDOW_DAYS} days, and neither may start
 * before yesterday (UTC; the property's own zone is unknown to an anonymous
 * caller, so one day of slack keeps a guest east of UTC from being refused) or
 * after {@link AVAILABILITY_MAX_HORIZON_DAYS} days.
 *
 * A refusal is one of three public shapes: `400 VALIDATION_ERROR` (the caller's
 * own input), `404 NOT_FOUND` (an offering that is unknown, another tenant's,
 * unlinked, inactive or not sold - ONE answer, so the route is not an oracle for
 * which Booking offerings exist), and the empty "no availability" answer the
 * port already folds every capacity probe into. The response bodies are built
 * field by field from an allow-list ({@link availabilityBody}), never spread
 * from the port's result, so a field a later port version adds (a resource name,
 * a unit label) cannot reach the public by accident.
 */
import type {
  BookingAvailabilityResult,
  BookingRefusal
} from "../../_shared/ports/booking-port";
import { isUuid } from "./register";
import { MAX_STAY_NIGHTS, nightsBetween } from "./booking-hold-to-order";

export type StorefrontValidation<T> =
  | { valid: true; value: T }
  | { valid: false; errors: { field: string; message: string }[] };

/** The port bounds one slot call to 31 days; the route states the same bound so the refusal is ours, not the port's. */
export const AVAILABILITY_MAX_SLOT_WINDOW_DAYS = 31;
/** How far ahead a public availability or quote may look. */
export const AVAILABILITY_MAX_HORIZON_DAYS = 730;
/** Resources offered per offering (the page probes them one by one). */
export const MAX_RESOURCES_PER_OFFERING = 10;
/** Offerings a storefront list returns. */
export const MAX_BOOKABLE_OFFERINGS = 50;

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DAY_MS = 86_400_000;

const AVAILABILITY_KEYS = [
  "offeringId",
  "resourceId",
  "checkInDate",
  "checkOutDate",
  "from",
  "to"
] as const;
const QUOTE_KEYS = ["offeringId", "checkInDate", "checkOutDate"] as const;

export type AvailabilityQuery = {
  offeringId: string;
  resourceId: string;
} & (
  | { kind: "stay"; checkInDate: string; checkOutDate: string }
  | { kind: "slot"; from: string; to: string }
);

export type QuoteQuery = {
  offeringId: string;
  stay: { checkInDate: string; checkOutDate: string } | null;
};

function unknownKeys(
  params: URLSearchParams,
  allowed: readonly string[]
): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  for (const key of new Set(params.keys())) {
    if (!allowed.includes(key)) {
      errors.push({ field: key, message: `${key} is not a known parameter.` });
    }
  }
  return errors;
}

function utcDayNumber(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS);
}

/** Day number of a real `YYYY-MM-DD`, or `null`. */
function localDayNumber(value: string): number | null {
  if (!LOCAL_DATE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  if (new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return Math.round(ms / DAY_MS);
}

function validateStayDates(
  checkIn: string | null,
  checkOut: string | null,
  now: Date,
  errors: { field: string; message: string }[]
): { checkInDate: string; checkOutDate: string } | null {
  if (checkIn === null || localDayNumber(checkIn) === null) {
    errors.push({
      field: "checkInDate",
      message: "checkInDate must be a real date (YYYY-MM-DD)."
    });
  }
  if (checkOut === null || localDayNumber(checkOut) === null) {
    errors.push({
      field: "checkOutDate",
      message: "checkOutDate must be a real date (YYYY-MM-DD)."
    });
  }
  if (errors.length > 0 || checkIn === null || checkOut === null) return null;

  if (nightsBetween(checkIn, checkOut) === null) {
    errors.push({
      field: "checkOutDate",
      message: `checkOutDate must be after checkInDate, at most ${MAX_STAY_NIGHTS} nights.`
    });
    return null;
  }
  const today = utcDayNumber(now);
  const start = localDayNumber(checkIn)!;
  if (start < today - 1) {
    errors.push({
      field: "checkInDate",
      message: "checkInDate cannot be in the past."
    });
    return null;
  }
  if (start > today + AVAILABILITY_MAX_HORIZON_DAYS) {
    errors.push({
      field: "checkInDate",
      message: `checkInDate is more than ${AVAILABILITY_MAX_HORIZON_DAYS} days ahead.`
    });
    return null;
  }
  return { checkInDate: checkIn, checkOutDate: checkOut };
}

/**
 * `GET .../booking/availability` - exactly one of the stay pair
 * (`checkInDate` + `checkOutDate`) and the slot pair (`from` + `to`).
 */
export function validateAvailabilityQuery(
  params: URLSearchParams,
  now: Date
): StorefrontValidation<AvailabilityQuery> {
  const errors = unknownKeys(params, AVAILABILITY_KEYS);
  const offeringId = params.get("offeringId");
  const resourceId = params.get("resourceId");
  if (!isUuid(offeringId)) {
    errors.push({
      field: "offeringId",
      message: "offeringId must be a uuid."
    });
  }
  if (!isUuid(resourceId)) {
    errors.push({
      field: "resourceId",
      message: "resourceId must be a uuid."
    });
  }

  const checkIn = params.get("checkInDate");
  const checkOut = params.get("checkOutDate");
  const from = params.get("from");
  const to = params.get("to");
  const hasStay = checkIn !== null || checkOut !== null;
  const hasSlot = from !== null || to !== null;
  if (hasStay === hasSlot) {
    errors.push({
      field: hasStay ? "from" : "checkInDate",
      message:
        "Send exactly one of checkInDate+checkOutDate (a stay) and from+to (slots)."
    });
  }

  let stay: { checkInDate: string; checkOutDate: string } | null = null;
  let slot: { from: string; to: string } | null = null;
  if (hasStay && !hasSlot) {
    stay = validateStayDates(checkIn, checkOut, now, errors);
  } else if (hasSlot && !hasStay) {
    if (
      from === null ||
      !INSTANT.test(from) ||
      Number.isNaN(Date.parse(from))
    ) {
      errors.push({
        field: "from",
        message: "from must be an RFC 3339 UTC instant ending in Z."
      });
    }
    if (to === null || !INSTANT.test(to) || Number.isNaN(Date.parse(to))) {
      errors.push({
        field: "to",
        message: "to must be an RFC 3339 UTC instant ending in Z."
      });
    }
    if (from !== null && to !== null && errors.length === 0) {
      const fromMs = Date.parse(from);
      const toMs = Date.parse(to);
      if (toMs <= fromMs) {
        errors.push({ field: "to", message: "to must be after from." });
      } else if (toMs - fromMs > AVAILABILITY_MAX_SLOT_WINDOW_DAYS * DAY_MS) {
        errors.push({
          field: "to",
          message: `The window is at most ${AVAILABILITY_MAX_SLOT_WINDOW_DAYS} days.`
        });
      } else if (fromMs < now.getTime() - DAY_MS) {
        errors.push({ field: "from", message: "from cannot be in the past." });
      } else if (
        fromMs >
        now.getTime() + AVAILABILITY_MAX_HORIZON_DAYS * DAY_MS
      ) {
        errors.push({
          field: "from",
          message: `from is more than ${AVAILABILITY_MAX_HORIZON_DAYS} days ahead.`
        });
      } else {
        slot = { from, to };
      }
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  if (stay) {
    return {
      valid: true,
      value: {
        offeringId: offeringId!,
        resourceId: resourceId!,
        kind: "stay",
        ...stay
      }
    };
  }
  return {
    valid: true,
    value: {
      offeringId: offeringId!,
      resourceId: resourceId!,
      kind: "slot",
      from: slot!.from,
      to: slot!.to
    }
  };
}

/** `GET .../booking/quote` - the offering and, for a night-based one, the stay. */
export function validateQuoteQuery(
  params: URLSearchParams,
  now: Date
): StorefrontValidation<QuoteQuery> {
  const errors = unknownKeys(params, QUOTE_KEYS);
  const offeringId = params.get("offeringId");
  if (!isUuid(offeringId)) {
    errors.push({
      field: "offeringId",
      message: "offeringId must be a uuid."
    });
  }
  const checkIn = params.get("checkInDate");
  const checkOut = params.get("checkOutDate");
  let stay: { checkInDate: string; checkOutDate: string } | null = null;
  if (checkIn !== null || checkOut !== null) {
    stay = validateStayDates(checkIn, checkOut, now, errors);
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { offeringId: offeringId!, stay } };
}

/** The public face of a Booking refusal on the availability read. */
export function publicAvailabilityRefusal(reason: BookingRefusal): {
  status: number;
  code: string;
  message: string;
} {
  if (
    reason === "VALIDATION_ERROR" ||
    reason === "STAY_DATES_INVALID" ||
    reason === "BOOKING_MODE_MISMATCH"
  ) {
    return {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "The availability request does not fit this offering."
    };
  }
  // An unknown offering, an offering the tenant does not sell and anything the
  // port might refuse with later are ONE neutral answer.
  return { status: 404, code: "NOT_FOUND", message: "Not found." };
}

export type PublicAvailability =
  | {
      mode: "stay";
      timezone: string;
      checkInDate: string;
      checkOutDate: string;
      nights: number | null;
      available: boolean;
      freeUnits: number;
      reason?: "SLOT_UNAVAILABLE";
    }
  | {
      mode: "slot";
      timezone: string;
      from: string;
      to: string;
      slots: { startsAt: string; endsAt: string; freeUnits: number }[];
      truncated: boolean;
    };

/**
 * The allow-listed public body of a successful availability answer. Only
 * counts, slots, the zone and the window are copied; nothing else the port
 * returns survives this function. The refusal arm is mapped by
 * {@link publicAvailabilityRefusal}.
 */
export function availabilityBody(
  result: Extract<BookingAvailabilityResult, { ok: true }>
): PublicAvailability {
  if (result.mode === "stay") {
    return {
      mode: "stay",
      timezone: result.timezone,
      checkInDate: result.checkInDate,
      checkOutDate: result.checkOutDate,
      nights: result.nights,
      available: result.available,
      freeUnits: result.freeUnits,
      ...(result.available ? {} : { reason: "SLOT_UNAVAILABLE" as const })
    };
  }
  return {
    mode: "slot",
    timezone: result.timezone,
    from: result.from,
    to: result.to,
    slots: result.slots.map((slot) => ({
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      freeUnits: slot.freeUnits
    })),
    truncated: result.truncated
  };
}
