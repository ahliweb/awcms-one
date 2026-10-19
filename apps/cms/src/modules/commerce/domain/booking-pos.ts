/**
 * Pure rules of the POS side of the booking adapter (Issue #383, ADR-0045 D19,
 * `docs/booking-ux-flows.md` section 5; threat controls C-34, C-35, C-36). No
 * database, no clock, no I/O.
 *
 * ## What the till may say
 *
 * - A LOOKUP names the reservation's code (Booking's `reservation_no`, G13) AND
 *   the customer's phone or e-mail, together and exactly. There is no name, no
 *   prefix, no date and no free-text search: a code alone or an identifier alone
 *   finds nothing, so the lookup cannot be used to list a tenant's guests or to
 *   walk the code space (C-34).
 * - A CHECK-IN or CHECK-OUT names the register only. The reservation is in the
 *   path; the status, the dates and the balance are the server's.
 * - A BALANCE PAYMENT names the register and the tenders. An amount is what the
 *   customer hands over for cash and the applied amount for anything else; the
 *   balance itself, the price of the service line, the order status and the
 *   customer are never accepted (C-36): the server reads the balance from the
 *   payment ledger and the price from the order the product priced.
 *
 * ## Refusals
 *
 * Every refusal is a value of {@link PosBookingRefusal}; the route maps it with
 * {@link posBookingRefusalHttp} AFTER the transaction, so a refusal never rides a
 * `4xx` out of `withTenant` with half a payment written. Booking's own refusals
 * keep Booking's code; `CHECK_IN_TOO_EARLY` is a `409`.
 */
import type { BookingRefusal } from "../../_shared/ports/booking-port";
import { holdRefusalHttp } from "./booking-hold-to-order";
import {
  isRecord,
  validatePosTenders,
  type TenderInput,
  type ValidationError
} from "./payment-allocation";
import { normalizePhoneNumber } from "./phone-normalisation";
import { isUuid } from "./register";

export type { ValidationError };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

// ---------------------------------------------------------------------------
// Audit and limits
// ---------------------------------------------------------------------------

export const POS_BOOKING_LOOKUP_AUDIT_ACTION = "commerce.booking_pos.lookup";
export const POS_BOOKING_CHECK_IN_AUDIT_ACTION =
  "commerce.booking_pos.check_in";
export const POS_BOOKING_CHECK_OUT_AUDIT_ACTION =
  "commerce.booking_pos.check_out";
export const POS_BOOKING_BALANCE_AUDIT_ACTION =
  "commerce.booking_pos.balance_collected";

/** Lookups per actor per minute, hit or miss. */
export const POS_LOOKUPS_PER_MINUTE = 30;
/**
 * MISSES per actor per window. A miss costs a unit and a hit gives it back, so
 * guessing codes is stopped after a handful of wrong ones while a busy desk that
 * finds what it looks for is never slowed down.
 */
export const POS_LOOKUP_MISSES_PER_WINDOW = 10;
export const POS_LOOKUP_MISS_WINDOW_MS = 15 * 60 * 1000;

/**
 * ADR-0045 D19 (residual R3): a guest cannot be checked in while a balance is
 * owed unless the tenant says otherwise. Fail closed - and the OWNER confirms
 * this default before the issue merges. A tenant with no settings row reads it.
 */
export const DEFAULT_CHECK_IN_REQUIRES_SETTLEMENT = true;

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/** Booking's `reservation_no` shape (sql/180): the request is upper-cased before the check. */
export const RESERVATION_NO_PATTERN = /^[A-Z0-9][A-Z0-9-]{3,31}$/;

export type PosLookupIdentifier =
  { kind: "phone"; value: string } | { kind: "email"; value: string };

export type PosLookupRequest = {
  reservationNo: string;
  identifier: PosLookupIdentifier;
};

const MAX_EMAIL_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@%*?]+@[^\s@%*?]+\.[^\s@%*?]+$/;

/**
 * `{ reservationNo, phone | email }` and nothing else. A key the lookup does not
 * own (`name`, `q`, `search`, `date`, a prefix) is a `400` that says so, never a
 * silent ignore: a client that thinks it can search must find out.
 */
export function validatePosLookupRequest(
  body: unknown
): ValidationResult<PosLookupRequest> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const allowed = ["reservationNo", "phone", "email"];
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    errors.push({
      field: key,
      message: `${key} is not accepted: the till finds a reservation by its code together with the customer's phone or e-mail, never by a search.`
    });
  }

  const rawCode = record.reservationNo;
  const reservationNo =
    typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
  if (!RESERVATION_NO_PATTERN.test(reservationNo)) {
    errors.push({
      field: "reservationNo",
      message: "reservationNo must be the full reservation code."
    });
  }

  const hasPhone = record.phone !== undefined && record.phone !== null;
  const hasEmail = record.email !== undefined && record.email !== null;
  let identifier: PosLookupIdentifier | null = null;
  if (hasPhone === hasEmail) {
    errors.push({
      field: "phone",
      message: "Send exactly one of phone and email, together with the code."
    });
  } else if (hasPhone) {
    const phone =
      typeof record.phone === "string"
        ? normalizePhoneNumber(record.phone)
        : null;
    if (phone?.valid) identifier = { kind: "phone", value: phone.value };
    else
      errors.push({
        field: "phone",
        message: "phone is not a valid Indonesian phone number."
      });
  } else {
    const email =
      typeof record.email === "string" ? record.email.trim().toLowerCase() : "";
    if (email.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(email)) {
      identifier = { kind: "email", value: email };
    } else {
      errors.push({
        field: "email",
        message: "email must be the customer's full e-mail address."
      });
    }
  }

  if (errors.length > 0 || identifier === null) {
    return { valid: false, errors };
  }
  return { valid: true, value: { reservationNo, identifier } };
}

/** Keys a till body may never carry: the server reads each of these itself (C-36). */
const FORBIDDEN_KEYS = [
  "price",
  "unitPrice",
  "lineTotal",
  "total",
  "balance",
  "balanceDue",
  "outstanding",
  "paid",
  "settlement",
  "status",
  "orderId",
  "reservationId",
  "customerId",
  "customer",
  "discount",
  "change",
  "registerSessionId"
] as const;

function forbiddenKeyErrors(
  record: Record<string, unknown>,
  allowed: readonly string[]
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    errors.push({
      field: key,
      message: (FORBIDDEN_KEYS as readonly string[]).includes(key)
        ? `${key} is not accepted: the server reads the balance and the price from the ledger and the product.`
        : `${key} is not accepted.`
    });
  }
  return errors;
}

function registerIdError(
  record: Record<string, unknown>
): ValidationError | null {
  return isUuid(record.registerId)
    ? null
    : { field: "registerId", message: "registerId must be a UUID." };
}

export type PosRegisterRequest = { registerId: string };

/** Check-in and check-out: the register only. */
export function validatePosRegisterRequest(
  body: unknown
): ValidationResult<PosRegisterRequest> {
  const record = isRecord(body) ? body : {};
  const errors = forbiddenKeyErrors(record, ["registerId"]);
  const registerError = registerIdError(record);
  if (registerError) errors.push(registerError);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { registerId: record.registerId as string } };
}

export type PosBalancePaymentRequest = {
  registerId: string;
  tenders: TenderInput[];
};

/** Balance collection: the register and at least one tender. Never a balance, a price or an order. */
export function validatePosBalancePaymentRequest(
  body: unknown
): ValidationResult<PosBalancePaymentRequest> {
  const record = isRecord(body) ? body : {};
  const errors = forbiddenKeyErrors(record, ["registerId", "tenders"]);
  const registerError = registerIdError(record);
  if (registerError) errors.push(registerError);
  const tenders = validatePosTenders(record.tenders, errors);
  if (errors.length === 0 && tenders.length === 0) {
    errors.push({
      field: "tenders",
      message: "tenders must contain at least one tender."
    });
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { registerId: record.registerId as string, tenders }
  };
}

// ---------------------------------------------------------------------------
// State rules
// ---------------------------------------------------------------------------

/** Booking statuses in which a balance may still be taken: not cancelled, expired, no-show or moved. */
export const BALANCE_COLLECTABLE_STATUSES: ReadonlySet<string> = new Set([
  "held",
  "confirmed",
  "checked_in",
  "completed"
]);

/** The order statuses a payment may be recorded in (the ordinary owner-side path's own list). */
export const BALANCE_RECORDABLE_ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "processing",
  "shipped",
  "completed"
] as const;

/** D19: the check-in is refused while a balance is owed AND the tenant requires settlement. */
export function checkInBlockedByBalance(input: {
  requiresSettlement: boolean;
  outstandingCents: bigint;
}): boolean {
  return input.requiresSettlement && input.outstandingCents > 0n;
}

export type PosCardActions = {
  canCollectBalance: boolean;
  canCheckIn: boolean;
  /** Why a confirmed reservation cannot be checked in right now, or `null`. */
  checkInBlockedReason: "balance_not_settled" | null;
  canCheckOut: boolean;
};

/**
 * What the reservation card may offer. A hint for the screen, not an
 * authorisation: every route re-checks the state, the balance and the permission
 * itself.
 */
export function posCardActions(input: {
  linkStatus: string;
  reservationStatus: string;
  orderStatus: string;
  outstandingCents: bigint;
  requiresSettlement: boolean;
}): PosCardActions {
  const live = input.linkStatus === "active";
  const payableOrder = (
    BALANCE_RECORDABLE_ORDER_STATUSES as readonly string[]
  ).includes(input.orderStatus);
  const blocked =
    live &&
    input.reservationStatus === "confirmed" &&
    checkInBlockedByBalance({
      requiresSettlement: input.requiresSettlement,
      outstandingCents: input.outstandingCents
    });
  return {
    canCollectBalance:
      live &&
      payableOrder &&
      input.outstandingCents > 0n &&
      BALANCE_COLLECTABLE_STATUSES.has(input.reservationStatus),
    canCheckIn: live && input.reservationStatus === "confirmed" && !blocked,
    checkInBlockedReason: blocked ? "balance_not_settled" : null,
    canCheckOut: live && input.reservationStatus === "checked_in"
  };
}

// ---------------------------------------------------------------------------
// Refusals and their HTTP mapping
// ---------------------------------------------------------------------------

export type PosBookingRefusal =
  | { code: "REGISTER_NOT_FOUND" }
  | { code: "REGISTER_SESSION_REQUIRED" }
  | { code: "REGISTER_SESSION_CLOSING" }
  | { code: "NOT_SESSION_CASHIER" }
  | { code: "RESERVATION_NOT_FOUND" }
  | { code: "INVALID_STATE"; reason: string }
  | { code: "IDEMPOTENCY_CONFLICT" }
  | { code: "BALANCE_NOT_SETTLED"; outstanding: string }
  | { code: "NO_BALANCE_DUE" }
  | { code: "ORDER_NOT_PAYABLE"; orderStatus: string }
  | { code: "BOOKING"; reason: BookingRefusal };

export function posBookingRefusalHttp(refusal: PosBookingRefusal): {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  switch (refusal.code) {
    case "REGISTER_NOT_FOUND":
      return {
        status: 404,
        code: "RESOURCE_NOT_FOUND",
        message: "Register not found."
      };
    case "REGISTER_SESSION_REQUIRED":
      return {
        status: 409,
        code: "REGISTER_SESSION_REQUIRED",
        message:
          "The register has no open session; open one before taking payments or checking guests in."
      };
    case "REGISTER_SESSION_CLOSING":
      return {
        status: 409,
        code: "REGISTER_SESSION_CLOSING",
        message: "The register's session is being closed and accepts no more."
      };
    case "NOT_SESSION_CASHIER":
      return {
        status: 409,
        code: "NOT_SESSION_CASHIER",
        message:
          "The register's session belongs to another cashier; ask for a handover."
      };
    case "RESERVATION_NOT_FOUND":
      return {
        status: 404,
        code: "RESOURCE_NOT_FOUND",
        message: "Reservation not found."
      };
    case "INVALID_STATE":
      return {
        status: 409,
        code: "INVALID_STATE",
        message: `The reservation cannot be changed this way now (${refusal.reason}).`
      };
    case "IDEMPOTENCY_CONFLICT":
      return {
        status: 409,
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency-Key was already used with a different request."
      };
    case "BALANCE_NOT_SETTLED":
      return {
        status: 409,
        code: "BALANCE_NOT_SETTLED",
        message:
          "This store requires the balance to be paid before check-in. Collect the outstanding balance first.",
        details: { outstanding: refusal.outstanding }
      };
    case "NO_BALANCE_DUE":
      return {
        status: 409,
        code: "NO_BALANCE_DUE",
        message: "Nothing is owed on this reservation."
      };
    case "ORDER_NOT_PAYABLE":
      return {
        status: 409,
        code: "ORDER_NOT_PAYABLE",
        message: "A cancelled or expired order cannot receive a payment."
      };
    case "BOOKING":
      // Booking's own refusal keeps Booking's code (`CHECK_IN_TOO_EARLY` is a 409).
      return holdRefusalHttp({ code: "BOOKING", reason: refusal.reason });
  }
}
