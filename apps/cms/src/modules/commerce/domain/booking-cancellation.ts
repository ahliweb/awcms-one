/**
 * Pure rules of the booking cancellation, refund quote and refund override
 * (Issue #381, ADR-0045 D4/D6/D8/D9/D10/D12; access matrix sections 5 and 6;
 * threat controls C-10, C-11, C-37, C-40). No database, no clock, no I/O.
 *
 * ## The quote is arithmetic over four server facts
 *
 *   - the amount PAID that can still be given back (the ledger, never a field of
 *     the request),
 *   - the ORIGINAL arrival instant of the booking (the root of a reschedule
 *     chain, from Booking),
 *   - the instant of the decision (the server clock, never a request field),
 *   - the windows of the policy version that applied WHEN THE BOOKING WAS MADE.
 *
 * Windows are evaluated greatest `min_hours_before_start` first and the first
 * that the notice satisfies applies (a notice of exactly `min` hours matches);
 * closer than the smallest window - or after arrival - refunds nothing. The
 * share is applied to cents with a half-up rounding, so the result is
 * cent-exact and never above the amount paid.
 *
 * ## `per_night`
 *
 * With `refund_basis = 'per_night'` the amount paid is split evenly over the
 * nights (the first nights carry the odd cents, so the parts add up to the
 * total exactly however it is split) and each night is judged by the notice
 * before ITS OWN start (arrival plus whole days). A later night therefore has
 * more notice than the first. `whole_stay`, and any slot reservation, judges the
 * whole amount by the notice before arrival.
 *
 * ## What a request may say
 *
 * A guest or customer cancel says which figure they saw (`acknowledgedRefund`,
 * compared and never stored as the refund) and nothing else. It NEVER says
 * `final_refund`, `amount` or an override: those keys are a `400` from the strict
 * schema (control C-10). Only a staff cancel carries an `override`, and the
 * route honours it only after the override permission and a fresh step-up.
 */
import type { BookingRefusal } from "../../_shared/ports/booking-port";
import { isRecord, type ValidationError } from "./payment-allocation";
import { holdRefusalHttp } from "./booking-hold-to-order";
import { fromCents, toCents } from "./price-calculation";

export type { ValidationError };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

export const OVERRIDE_REASON_MIN_LENGTH = 10;
export const OVERRIDE_REASON_MAX_LENGTH = 500;
/** A defensive ceiling on windows per policy version. */
export const CANCELLATION_POLICY_MAX_WINDOWS = 20;
/** One year of notice; a longer window is a typo, not a policy. */
export const CANCELLATION_POLICY_MAX_HOURS = 8_760;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Quote arithmetic
// ---------------------------------------------------------------------------

export type CancellationWindow = {
  minHoursBeforeStart: number;
  /** Basis points, 0..10000 (`33.33` percent is 3333). */
  refundableBp: number;
};

export type CancellationRefundBasis = "whole_stay" | "per_night";

export type CancellationRules = {
  refundBasis: CancellationRefundBasis;
  windows: readonly CancellationWindow[];
};

/** `"33.33"` -> 3333; `null` when it is not a percent with at most two decimals in 0..100. */
export function percentToBasisPoints(percent: string): number | null {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(percent)) return null;
  const [whole, fraction = ""] = percent.split(".");
  const bp = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return bp >= 0 && bp <= 10_000 ? bp : null;
}

/** 3333 -> `"33.33"`. */
export function basisPointsToPercent(bp: number): string {
  const whole = Math.floor(bp / 100);
  return `${whole}.${String(bp % 100).padStart(2, "0")}`;
}

/** Whole hours from `nowMs` to `startMs`, floored; negative once the start has passed. */
export function hoursBeforeStart(startMs: number, nowMs: number): number {
  return Math.floor((startMs - nowMs) / HOUR_MS);
}

/**
 * The window a notice of `hours` falls in, or `null` (closer than the smallest
 * window, or already past arrival).
 */
export function matchWindow(
  windows: readonly CancellationWindow[],
  hours: number
): CancellationWindow | null {
  const ordered = [...windows].sort(
    (a, b) => b.minHoursBeforeStart - a.minHoursBeforeStart
  );
  for (const window of ordered) {
    if (hours >= window.minHoursBeforeStart) return window;
  }
  return null;
}

/** `cents * bp / 10000`, half up. */
export function shareOfCents(cents: bigint, bp: number): bigint {
  return (cents * BigInt(bp) + 5_000n) / 10_000n;
}

/**
 * `total` cents split over `parts` parts: the first `total mod parts` parts
 * carry one extra cent, so the parts add up to `total` exactly.
 */
export function splitCents(total: bigint, parts: number): bigint[] {
  const n = BigInt(parts);
  const base = total / n;
  const extra = Number(total % n);
  return Array.from({ length: parts }, (_, index) =>
    index < extra ? base + 1n : base
  );
}

export type QuoteFigures = {
  /** Whole hours before arrival at the instant of the decision (negative after it). */
  hoursBeforeStart: number;
  /** The share the window(s) allowed, in basis points; the effective share for `per_night`. */
  refundableBp: number;
  computedCents: bigint;
};

/**
 * The refund the policy computes. `rules === null` is "no policy" (ADR-0045
 * D6): refund 0, share 0. `nights` is the stay's night count (1 for a slot).
 * The result never exceeds `amountPaidCents`.
 */
export function computeCancellationRefund(input: {
  amountPaidCents: bigint;
  startsAtMs: number;
  nowMs: number;
  rules: CancellationRules | null;
  nights: number;
}): QuoteFigures {
  const hours = hoursBeforeStart(input.startsAtMs, input.nowMs);
  const paid = input.amountPaidCents > 0n ? input.amountPaidCents : 0n;
  if (input.rules === null || input.rules.windows.length === 0) {
    return { hoursBeforeStart: hours, refundableBp: 0, computedCents: 0n };
  }

  const nights = Math.max(1, Math.floor(input.nights));
  if (input.rules.refundBasis === "per_night" && nights > 1) {
    const shares = splitCents(paid, nights);
    let total = 0n;
    for (let night = 0; night < nights; night += 1) {
      const nightHours = hoursBeforeStart(
        input.startsAtMs + night * DAY_MS,
        input.nowMs
      );
      const window = matchWindow(input.rules.windows, nightHours);
      total += shareOfCents(shares[night]!, window?.refundableBp ?? 0);
    }
    const first = matchWindow(input.rules.windows, hours);
    const effective =
      paid > 0n
        ? Number((total * 10_000n + paid / 2n) / paid)
        : (first?.refundableBp ?? 0);
    return {
      hoursBeforeStart: hours,
      refundableBp: Math.min(10_000, effective),
      computedCents: total > paid ? paid : total
    };
  }

  const window = matchWindow(input.rules.windows, hours);
  const bp = window?.refundableBp ?? 0;
  const computed = shareOfCents(paid, bp);
  return {
    hoursBeforeStart: hours,
    refundableBp: bp,
    computedCents: computed > paid ? paid : computed
  };
}

// ---------------------------------------------------------------------------
// Policy draft validation (the windows editor of UX 11.4)
// ---------------------------------------------------------------------------

export type PolicyDraftWindowInput = {
  minHoursBeforeStart: number;
  /** `numeric(5,2)` text, `"50.00"`. */
  refundablePercent: string;
};

export type PolicyDraftInput = {
  /** `null` is the tenant default (Q9). */
  productId: string | null;
  refundBasis: CancellationRefundBasis;
  noShowRetention: "retain_deposit" | "retain_all" | "refund_per_windows";
  windows: PolicyDraftWindowInput[];
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether more notice never refunds LESS than less notice: the invariant the
 * database refuses at activation, checked here so a draft that could never be
 * activated is a `400` at authoring time.
 */
export function windowsAreMonotone(
  windows: readonly CancellationWindow[]
): boolean {
  const ordered = [...windows].sort(
    (a, b) => b.minHoursBeforeStart - a.minHoursBeforeStart
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.refundableBp > ordered[index - 1]!.refundableBp) {
      return false;
    }
  }
  return true;
}

export function validatePolicyDraftInput(
  body: unknown
): ValidationResult<PolicyDraftInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const allowed = ["productId", "refundBasis", "noShowRetention", "windows"];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      errors.push({ field: key, message: `${key} is not a known field.` });
    }
  }

  let productId: string | null = null;
  if (record.productId !== undefined && record.productId !== null) {
    if (
      typeof record.productId !== "string" ||
      !UUID_PATTERN.test(record.productId)
    ) {
      errors.push({
        field: "productId",
        message: "productId must be a uuid, or null for the tenant default."
      });
    } else {
      productId = record.productId;
    }
  }

  const refundBasis = record.refundBasis ?? "whole_stay";
  if (refundBasis !== "whole_stay" && refundBasis !== "per_night") {
    errors.push({
      field: "refundBasis",
      message: "refundBasis must be whole_stay or per_night."
    });
  }
  const noShowRetention = record.noShowRetention ?? "retain_deposit";
  if (
    noShowRetention !== "retain_deposit" &&
    noShowRetention !== "retain_all" &&
    noShowRetention !== "refund_per_windows"
  ) {
    errors.push({
      field: "noShowRetention",
      message:
        "noShowRetention must be retain_deposit, retain_all or refund_per_windows."
    });
  }

  const windows: PolicyDraftWindowInput[] = [];
  if (
    !Array.isArray(record.windows) ||
    record.windows.length < 1 ||
    record.windows.length > CANCELLATION_POLICY_MAX_WINDOWS
  ) {
    errors.push({
      field: "windows",
      message: `windows must be a list of 1 to ${CANCELLATION_POLICY_MAX_WINDOWS} windows.`
    });
  } else {
    const seen = new Set<number>();
    record.windows.forEach((entry: unknown, index: number) => {
      const field = `windows[${index}]`;
      if (!isRecord(entry)) {
        errors.push({ field, message: "A window must be an object." });
        return;
      }
      for (const key of Object.keys(entry)) {
        if (key !== "minHoursBeforeStart" && key !== "refundablePercent") {
          errors.push({
            field: `${field}.${key}`,
            message: `${key} is not a known field.`
          });
        }
      }
      const hours = entry.minHoursBeforeStart;
      if (
        typeof hours !== "number" ||
        !Number.isInteger(hours) ||
        hours < 0 ||
        hours > CANCELLATION_POLICY_MAX_HOURS
      ) {
        errors.push({
          field: `${field}.minHoursBeforeStart`,
          message: `minHoursBeforeStart must be a whole number of hours from 0 to ${CANCELLATION_POLICY_MAX_HOURS}.`
        });
        return;
      }
      const rawPercent = entry.refundablePercent;
      const percentText =
        typeof rawPercent === "number" && Number.isFinite(rawPercent)
          ? rawPercent.toFixed(2)
          : typeof rawPercent === "string"
            ? rawPercent.trim()
            : "";
      const bp = percentToBasisPoints(percentText);
      if (bp === null) {
        errors.push({
          field: `${field}.refundablePercent`,
          message:
            "refundablePercent must be a percentage from 0 to 100 with at most two decimals."
        });
        return;
      }
      if (seen.has(hours)) {
        errors.push({
          field: `${field}.minHoursBeforeStart`,
          message: "Two windows cannot start at the same number of hours."
        });
        return;
      }
      seen.add(hours);
      windows.push({
        minHoursBeforeStart: hours,
        refundablePercent: basisPointsToPercent(bp)
      });
    });
    if (
      errors.length === 0 &&
      !windowsAreMonotone(
        windows.map((window) => ({
          minHoursBeforeStart: window.minHoursBeforeStart,
          refundableBp: percentToBasisPoints(window.refundablePercent)!
        }))
      )
    ) {
      errors.push({
        field: "windows",
        message:
          "A window with more notice must not refund less than a window with less notice."
      });
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      productId,
      refundBasis: refundBasis as CancellationRefundBasis,
      noShowRetention: noShowRetention as PolicyDraftInput["noShowRetention"],
      windows: windows.sort(
        (a, b) => b.minHoursBeforeStart - a.minHoursBeforeStart
      )
    }
  };
}

// ---------------------------------------------------------------------------
// Cancel requests (strict schemas)
// ---------------------------------------------------------------------------

/** Names no cancel body may carry: the amount is the server's (C-10). */
const MONEY_KEYS = [
  "amount",
  "refund",
  "refundAmount",
  "final_refund",
  "finalRefund",
  "computedRefund",
  "computed_refund",
  "amountPaid",
  "amount_paid",
  "total",
  "price"
] as const;

const REASON_CODE = /^[a-z][a-z0-9_]{2,39}$/;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

function rejectKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  errors: ValidationError[]
): void {
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    errors.push({
      field: key,
      message: (MONEY_KEYS as readonly string[]).includes(key)
        ? `${key} is not accepted: the server computes the refund.`
        : key === "override"
          ? "override is not accepted here."
          : `${key} is not a known field.`
    });
  }
}

export type StaffCancelRequest = {
  reasonCode: string;
  override: { finalRefund: string; reason: string } | null;
};

/**
 * The body of the STAFF cancel: a closed `reasonCode` and an optional
 * `override { finalRefund, reason }`. Whether the caller may override is the
 * route's decision (permission and step-up); the SHAPE is validated here.
 */
export function validateStaffCancelRequest(
  body: unknown
): ValidationResult<StaffCancelRequest> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  rejectKeys(record, ["reasonCode", "override"], errors);

  if (
    typeof record.reasonCode !== "string" ||
    !REASON_CODE.test(record.reasonCode)
  ) {
    errors.push({
      field: "reasonCode",
      message:
        "reasonCode must be a short lowercase code (letters, digits, underscore), never free text."
    });
  }

  let override: StaffCancelRequest["override"] = null;
  if (record.override !== undefined && record.override !== null) {
    if (!isRecord(record.override)) {
      errors.push({
        field: "override",
        message: "override must be an object."
      });
    } else {
      for (const key of Object.keys(record.override)) {
        if (key !== "finalRefund" && key !== "reason") {
          errors.push({
            field: `override.${key}`,
            message: `${key} is not a known field.`
          });
        }
      }
      const finalRefund = record.override.finalRefund;
      if (typeof finalRefund !== "string" || !MONEY.test(finalRefund.trim())) {
        errors.push({
          field: "override.finalRefund",
          message:
            "finalRefund must be a numeric(14,2) string (digits with at most two decimals), never a JSON number."
        });
      }
      const reason =
        typeof record.override.reason === "string"
          ? record.override.reason.trim()
          : "";
      if (
        reason.length < OVERRIDE_REASON_MIN_LENGTH ||
        reason.length > OVERRIDE_REASON_MAX_LENGTH
      ) {
        errors.push({
          field: "override.reason",
          message: `reason is required, ${OVERRIDE_REASON_MIN_LENGTH} to ${OVERRIDE_REASON_MAX_LENGTH} characters.`
        });
      }
      if (
        typeof finalRefund === "string" &&
        MONEY.test(finalRefund.trim()) &&
        reason.length >= OVERRIDE_REASON_MIN_LENGTH &&
        reason.length <= OVERRIDE_REASON_MAX_LENGTH
      ) {
        override = {
          finalRefund: fromCents(toCents(finalRefund.trim())),
          reason
        };
      }
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { reasonCode: record.reasonCode as string, override }
  };
}

export type CustomerCancelRequest = {
  acknowledgedRefund: string;
  /** The order's phone, for a guest without a bearer session (the route reads it; never an amount). */
  phone: string | null;
};

/**
 * The body of the GUEST / CUSTOMER cancel: the figure they saw and, for an
 * anonymous caller, the order's phone. It can NEVER carry `final_refund`,
 * `amount` or an `override` - each is a `400` naming the key (control C-10).
 */
export function validateCustomerCancelRequest(
  body: unknown
): ValidationResult<CustomerCancelRequest> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  rejectKeys(record, ["acknowledgedRefund", "phone"], errors);

  const ack = record.acknowledgedRefund;
  if (typeof ack !== "string" || !MONEY.test(ack.trim())) {
    errors.push({
      field: "acknowledgedRefund",
      message:
        "acknowledgedRefund must be the quoted refund as a numeric(14,2) string."
    });
  }
  let phone: string | null = null;
  if (record.phone !== undefined && record.phone !== null) {
    if (typeof record.phone !== "string" || record.phone.trim().length === 0) {
      errors.push({ field: "phone", message: "phone must be a string." });
    } else {
      phone = record.phone.trim().slice(0, 30);
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      acknowledgedRefund: fromCents(toCents((ack as string).trim())),
      phone
    }
  };
}

// ---------------------------------------------------------------------------
// Refusals and their HTTP mapping
// ---------------------------------------------------------------------------

/**
 * Every refusal of a cancellation, quote or policy write as a value. The route
 * maps it with {@link cancelRefusalHttp} AFTER the transaction, so a refusal
 * never rides a `4xx` out of `withTenant` with a half-written decision.
 */
export type CancelRefusal =
  | { code: "FEATURE_DISABLED" }
  | { code: "RESERVATION_NOT_FOUND" }
  | { code: "SERVICE_ACTOR_NOT_CONFIGURED" }
  | { code: "INVALID_STATE"; reason: string }
  | { code: "IDEMPOTENCY_CONFLICT" }
  | { code: "QUOTE_CHANGED"; computedRefund: string }
  | { code: "REFUND_EXCEEDS_PAID"; amountPaid: string }
  | { code: "OVERRIDE_NOT_A_CHANGE"; computedRefund: string }
  | { code: "BOOKING"; reason: BookingRefusal };

export function cancelRefusalHttp(refusal: CancelRefusal): {
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
        message: `The reservation cannot be cancelled now (${refusal.reason}).`
      };
    case "IDEMPOTENCY_CONFLICT":
      return {
        status: 409,
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency-Key was already used with a different request."
      };
    case "QUOTE_CHANGED":
      return {
        status: 409,
        code: "QUOTE_CHANGED",
        message:
          "The refund changed since you saw it. Nothing was cancelled; review the new figure.",
        details: { computedRefund: refusal.computedRefund }
      };
    case "REFUND_EXCEEDS_PAID":
      return {
        status: 409,
        code: "REFUND_EXCEEDS_PAID",
        message: "The refund cannot be more than the amount paid.",
        details: { amountPaid: refusal.amountPaid }
      };
    case "OVERRIDE_NOT_A_CHANGE":
      return {
        status: 400,
        code: "VALIDATION_ERROR",
        message:
          "The override equals the policy refund; cancel without an override.",
        details: { computedRefund: refusal.computedRefund }
      };
    case "BOOKING": {
      // Booking's own refusal keeps Booking's code and uses the one mapping
      // every adapter route shares (new upstream codes fall into its 409
      // default, which carries the code through).
      const mapped = holdRefusalHttp({
        code: "BOOKING",
        reason: refusal.reason
      });
      return mapped;
    }
  }
}

/** The audit/event `trigger_kind` and `actor_kind` of a cancel. */
export type CancelActorKind = "customer" | "staff";

export function triggerKindFor(
  actor: CancelActorKind
): "customer_cancel" | "staff_cancel" {
  return actor === "customer" ? "customer_cancel" : "staff_cancel";
}

/** The source key of a decision (and the seed of its refund legs' keys): one per Booking reservation. */
export function decisionSourceKey(reservationId: string): string {
  return `booking-cancel:${reservationId}`;
}
