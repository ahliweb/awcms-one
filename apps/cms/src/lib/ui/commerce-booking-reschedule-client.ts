/**
 * Client helpers for the booking reschedule dialog and the no-show control on the
 * order detail (Issue #382, `docs/booking-ux-flows.md` section 11.6). Pure
 * functions with no DOM dependency so `tests/commerce-booking-reschedule-client.test.ts`
 * asserts them directly.
 *
 * Nothing here is an authority. The server prices the difference (more nights are
 * a supplementary order, fewer nights a refund limited by the ORIGINAL cancellation
 * policy), decides whether the dates are free and whether the arrival plus the
 * grace has passed, and refuses a body that names a price, a refund, an order or a
 * payment method. The dialog's disabled state only tells the operator BEFORE the
 * round trip; a hand-built request meets the same refusals. The only figure the
 * browser ever shows is the one the server's quote returned.
 */

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** `<input type="datetime-local">` value, with or without seconds. */
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const DAY_MS = 86_400_000;

/** The closed reason codes the staff reschedule offers (the server accepts any short lowercase code). */
export const RESCHEDULE_REASON_CODES = [
  "guest_request",
  "property_request",
  "double_booking",
  "other"
] as const;
export type RescheduleReasonCode = (typeof RESCHEDULE_REASON_CODES)[number];

/** The closed reason codes the no-show control offers. */
export const NO_SHOW_REASON_CODES = [
  "guest_did_not_arrive",
  "guest_unreachable",
  "other"
] as const;
export type NoShowReasonCode = (typeof NO_SHOW_REASON_CODES)[number];

function utcDayNumber(date: string): number | null {
  if (!LOCAL_DATE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  // Date.parse accepts 2026-02-30 as March 2: round-trip to refuse it.
  if (new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return Math.floor(ms / DAY_MS);
}

/** Whole nights between two local dates; `null` when either is not a real date or the range is not forward. */
export function nightsBetween(
  checkInDate: string,
  checkOutDate: string
): number | null {
  const from = utcDayNumber(checkInDate);
  const to = utcDayNumber(checkOutDate);
  if (from === null || to === null || to <= from) return null;
  return to - from;
}

/** `YYYY-MM-DD` of `checkInDate` plus `nights` days. */
export function addNights(checkInDate: string, nights: number): string | null {
  const from = utcDayNumber(checkInDate);
  if (from === null) return null;
  return new Date((from + nights) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The earliest date the date inputs offer, from the SERVER's clock (never the
 * browser's): the UTC date of `serverNow` less one day, because a resource's local
 * date can trail UTC by up to a day. Booking refuses a past date for real.
 */
export function earliestDate(serverNowIso: string): string | null {
  const ms = Date.parse(serverNowIso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms - DAY_MS).toISOString().slice(0, 10);
}

/** A `datetime-local` value (read as UTC, the unit Booking stores) as an RFC 3339 instant ending in Z; `null` when malformed. */
export function localDateTimeToInstant(value: string): string | null {
  const match = LOCAL_DATE_TIME.exec(value.trim());
  if (!match) return null;
  const [, date, hours, minutes, seconds] = match;
  if (utcDayNumber(date!) === null) return null;
  if (Number(hours) > 23 || Number(minutes) > 59) return null;
  return `${date}T${hours}:${minutes}:${seconds ?? "00"}Z`;
}

export type RescheduleProblem =
  | "dates_missing"
  | "dates_invalid"
  | "checkout_not_after"
  | "in_the_past"
  | "start_missing"
  | "start_invalid"
  | "unchanged";

export type RescheduleFormInput =
  | {
      mode: "stay";
      checkInDate: string;
      checkOutDate: string;
      /** The stay the reservation has now; the same dates are "no change". */
      current: { checkInDate: string; checkOutDate: string } | null;
      earliest: string | null;
    }
  | {
      mode: "slot";
      /** `datetime-local` text. */
      startsAtLocal: string;
      current: { startsAt: string } | null;
      earliest: string | null;
    };

export type RescheduleFormCheck =
  | {
      ok: true;
      /** The part of the request that says WHEN; the same object for the quote query and the POST body. */
      when:
        | { stay: { checkInDate: string; checkOutDate: string } }
        | { startsAt: string };
      /** Nights asked for (a slot is 1). */
      nights: number;
    }
  | { ok: false; problems: RescheduleProblem[] };

/** Whether the dialog's submit and price button may be enabled. */
export function checkRescheduleForm(
  input: RescheduleFormInput
): RescheduleFormCheck {
  if (input.mode === "stay") {
    const checkIn = input.checkInDate.trim();
    const checkOut = input.checkOutDate.trim();
    if (checkIn === "" || checkOut === "") {
      return { ok: false, problems: ["dates_missing"] };
    }
    if (utcDayNumber(checkIn) === null || utcDayNumber(checkOut) === null) {
      return { ok: false, problems: ["dates_invalid"] };
    }
    const nights = nightsBetween(checkIn, checkOut);
    if (nights === null) {
      return { ok: false, problems: ["checkout_not_after"] };
    }
    if (input.earliest !== null && checkIn < input.earliest) {
      return { ok: false, problems: ["in_the_past"] };
    }
    if (
      input.current &&
      input.current.checkInDate === checkIn &&
      input.current.checkOutDate === checkOut
    ) {
      return { ok: false, problems: ["unchanged"] };
    }
    return {
      ok: true,
      when: { stay: { checkInDate: checkIn, checkOutDate: checkOut } },
      nights
    };
  }

  if (input.startsAtLocal.trim() === "") {
    return { ok: false, problems: ["start_missing"] };
  }
  const instant = localDateTimeToInstant(input.startsAtLocal);
  if (instant === null) return { ok: false, problems: ["start_invalid"] };
  if (input.earliest !== null && instant.slice(0, 10) < input.earliest) {
    return { ok: false, problems: ["in_the_past"] };
  }
  if (
    input.current &&
    Date.parse(input.current.startsAt) === Date.parse(instant)
  ) {
    return { ok: false, problems: ["unchanged"] };
  }
  return { ok: true, when: { startsAt: instant }, nights: 1 };
}

/** The `POST .../reschedule` body: the new time, a closed reason code, and NOTHING about money. */
export function buildRescheduleBody(
  check: Extract<RescheduleFormCheck, { ok: true }>,
  reasonCode: string
): Record<string, unknown> {
  return { ...check.when, reasonCode };
}

/** The query string of `GET .../reschedule-quote` (leading `?`), from the same check. */
export function buildRescheduleQuoteQuery(
  check: Extract<RescheduleFormCheck, { ok: true }>
): string {
  const params = new URLSearchParams();
  if ("stay" in check.when) {
    params.set("checkInDate", check.when.stay.checkInDate);
    params.set("checkOutDate", check.when.stay.checkOutDate);
  } else {
    params.set("startsAt", check.when.startsAt);
  }
  return `?${params.toString()}`;
}

/** The `POST .../no-show` body: a closed reason code, nothing else (never an amount). */
export function buildNoShowBody(reasonCode: string): Record<string, unknown> {
  return { reasonCode };
}

/** What the server's quote says, reduced to the sentence the dialog shows. */
export type QuoteSummary = {
  kind:
    "none" | "charge" | "refund_some" | "refund_none" | "refund_policy_none";
  nightsFrom: number;
  nightsTo: number;
  pricedAmount: string;
  refundAmount: string;
};

export function summarizeQuote(quote: {
  currentNights: number;
  newNights: number;
  direction: string;
  pricedAmount: string;
  refundAmount: string;
  policySource?: string | null;
}): QuoteSummary {
  const base = {
    nightsFrom: quote.currentNights,
    nightsTo: quote.newNights,
    pricedAmount: quote.pricedAmount,
    refundAmount: quote.refundAmount
  };
  if (quote.direction === "charge") return { kind: "charge", ...base };
  if (quote.direction === "refund") {
    if (Number(quote.refundAmount) > 0) return { kind: "refund_some", ...base };
    return {
      kind:
        quote.policySource === "none" ? "refund_policy_none" : "refund_none",
      ...base
    };
  }
  return { kind: "none", ...base };
}

/** The body of a quote answer, narrowed from untrusted JSON; `null` when it is not the shape. */
export function readQuote(data: unknown): {
  currentNights: number;
  newNights: number;
  direction: string;
  pricedAmount: string;
  refundAmount: string;
  policySource: string | null;
  hoursBeforeStart: number | null;
  refundablePercent: string | null;
  availability: { available: boolean; freeUnits: number } | null;
} | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (
    typeof record.currentNights !== "number" ||
    typeof record.newNights !== "number" ||
    typeof record.direction !== "string" ||
    typeof record.pricedAmount !== "string" ||
    typeof record.refundAmount !== "string"
  ) {
    return null;
  }
  const availability = record.availability;
  return {
    currentNights: record.currentNights,
    newNights: record.newNights,
    direction: record.direction,
    pricedAmount: record.pricedAmount,
    refundAmount: record.refundAmount,
    policySource:
      typeof record.policySource === "string" ? record.policySource : null,
    hoursBeforeStart:
      typeof record.hoursBeforeStart === "number"
        ? record.hoursBeforeStart
        : null,
    refundablePercent:
      typeof record.refundablePercent === "string"
        ? record.refundablePercent
        : null,
    availability:
      typeof availability === "object" &&
      availability !== null &&
      typeof (availability as Record<string, unknown>).available ===
        "boolean" &&
      typeof (availability as Record<string, unknown>).freeUnits === "number"
        ? {
            available: (availability as { available: boolean }).available,
            freeUnits: (availability as { freeUnits: number }).freeUnits
          }
        : null
  };
}

export type QuoteFetchResult =
  | { ok: true; quote: NonNullable<ReturnType<typeof readQuote>> }
  | { ok: false; errorCode: string | null };

/** Asks the server for the non-binding price of the move. Never throws; an unreadable answer is a failure. */
export async function fetchRescheduleQuote(
  url: string
): Promise<QuoteFetchResult> {
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin"
    });
    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
      data?: unknown;
      error?: { code?: string };
    } | null;
    if (response.ok && payload?.success === true) {
      const quote = readQuote(payload.data);
      return quote
        ? { ok: true, quote }
        : { ok: false, errorCode: "BAD_RESPONSE" };
    }
    return { ok: false, errorCode: payload?.error?.code ?? null };
  } catch {
    return { ok: false, errorCode: "NETWORK_ERROR" };
  }
}
