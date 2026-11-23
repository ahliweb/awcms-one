/**
 * The rules of a shopper's data-subject request that need no database
 * (Issue #529, ADR-0055 D2/D3). Pure functions and constants.
 *
 * ## Refusal rules
 *
 * An erasure is refused while the shopper still has something in flight that
 * the store owes or is owed; each refusal has a stable code the storefront and
 * the admin screen translate, and the request row records it:
 *
 * | code                       | while...                                              |
 * | -------------------------- | ----------------------------------------------------- |
 * | `ALREADY_ERASED`           | the customer was erased before                        |
 * | `NOT_A_PERSON`             | the row is the shared POS walk-in sentinel customer   |
 * | `OPEN_ORDER`               | an order is pending payment, paid, processing, shipped |
 * | `OPEN_BOOKING`             | a booking reservation of the shopper is still active  |
 * | `STORED_VALUE_BALANCE`     | a gift card or store credit of theirs holds a balance |
 * | `PENDING_REFUND`           | a return is open or a refund is not yet settled       |
 * | `UNPAID_AFFILIATE_PAYOUT`  | an affiliate commission is pending or approved        |
 *
 * The export is never refused for these: a shopper may always see their data.
 *
 * ## Sentinels
 *
 * An anonymised value must stay UNIQUE where the schema says so (the customer's
 * phone and the account's e-mail are unique per tenant), so a sentinel is
 * derived from the row's own id, never a constant. It reveals nothing and is
 * recognisable (`isErasedSentinel`), so reports can say "erased customer".
 */
export const SUBJECT_REQUEST_TYPES = ["export", "erasure"] as const;
export type SubjectRequestType = (typeof SUBJECT_REQUEST_TYPES)[number];

export const SUBJECT_REQUEST_CHANNELS = ["storefront", "admin"] as const;
export type SubjectRequestChannel = (typeof SUBJECT_REQUEST_CHANNELS)[number];

export const SUBJECT_REQUEST_STATUSES = [
  "disclosed",
  "pending_approval",
  "refused",
  "rejected",
  "completed"
] as const;
export type SubjectRequestStatus = (typeof SUBJECT_REQUEST_STATUSES)[number];

/** The OTP purposes a data-subject request uses (a login code never authorises one). */
export const SUBJECT_OTP_PURPOSES = {
  export: "subject_export",
  erasure: "subject_erasure"
} as const;
export type SubjectOtpPurpose =
  (typeof SUBJECT_OTP_PURPOSES)[keyof typeof SUBJECT_OTP_PURPOSES];

export const SUBJECT_REFUSAL_CODES = [
  "ALREADY_ERASED",
  "NOT_A_PERSON",
  "OPEN_ORDER",
  "OPEN_BOOKING",
  "STORED_VALUE_BALANCE",
  "PENDING_REFUND",
  "UNPAID_AFFILIATE_PAYOUT"
] as const;
export type SubjectRefusalCode = (typeof SUBJECT_REFUSAL_CODES)[number];

export const SUBJECT_REFUSAL_MESSAGES: Readonly<
  Record<SubjectRefusalCode, string>
> = {
  ALREADY_ERASED: "This account has already been erased.",
  NOT_A_PERSON:
    "This is the shared point-of-sale walk-in record, not a person, and cannot be erased.",
  OPEN_ORDER:
    "An order is still being processed. Erasure is possible once every order is completed or cancelled.",
  OPEN_BOOKING:
    "A booking is still active. Erasure is possible once it is completed or cancelled.",
  STORED_VALUE_BALANCE:
    "A gift card or store credit linked to this account still has a balance.",
  PENDING_REFUND:
    "A return or refund is still being settled. Erasure is possible once it is settled.",
  UNPAID_AFFILIATE_PAYOUT: "An affiliate commission has not been paid out yet."
};

/** The order statuses that mean "still in flight" (`order-status.ts`'s open set, restated: this file has no imports). */
export const OPEN_ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "processing",
  "shipped"
] as const;

export const OPEN_REFUND_STATUSES = [
  "pending",
  "processing",
  "failed"
] as const;
export const UNPAID_COMMISSION_STATUSES = ["pending", "approved"] as const;

/** Retained rows are never rewritten; the summary names the table families that stayed. */
export const REQUIRED_RETENTION_NOTICE =
  "Orders, payments, documents, returns, refunds and the loyalty and stored-value ledgers are kept for the statutory bookkeeping period and no longer identify you.";

const ERASED_PREFIX = "erased-";
const ERASED_EMAIL_DOMAIN = "erased.invalid";
const ERASED_TEXT = "[erased]";
const ERASED_NAME = "Erased customer";

export function erasedCustomerName(): string {
  return ERASED_NAME;
}

export function erasedText(): string {
  return ERASED_TEXT;
}

/** A per-row-unique phone placeholder (unique per tenant; not a valid phone number on purpose). */
export function erasedPhone(customerId: string): string {
  return `${ERASED_PREFIX}${customerId}`;
}

/** A per-row-unique e-mail placeholder on the reserved `.invalid` TLD (RFC 2606): it can never be delivered to. */
export function erasedEmail(accountId: string): string {
  return `${ERASED_PREFIX}${accountId}@${ERASED_EMAIL_DOMAIN}`;
}

export function isErasedSentinel(value: string | null | undefined): boolean {
  if (!value) return false;
  return (
    value.startsWith(ERASED_PREFIX) ||
    value === ERASED_NAME ||
    value === ERASED_TEXT
  );
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** `null` when the key is acceptable; the storefront and admin routes both require one on a mutation. */
export function validateSubjectIdempotencyKey(
  value: string | null | undefined
): string | null {
  if (value === null || value === undefined || value.length === 0) {
    return "Idempotency-Key header is required.";
  }
  return IDEMPOTENCY_KEY_PATTERN.test(value)
    ? null
    : "Idempotency-Key must be 16 to 128 characters of letters, digits, underscore and hyphen.";
}

const OTP_CODE_PATTERN = /^[0-9]{6}$/;

export function isWellFormedSubjectOtpCode(value: unknown): value is string {
  return typeof value === "string" && OTP_CODE_PATTERN.test(value);
}

/** An erasure reason an admin may type: optional, trimmed, 1 to 500 characters. */
export function normaliseSubjectReason(
  value: unknown
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, message: "reason must be a string." };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > 500) {
    return { ok: false, message: "reason must be at most 500 characters." };
  }
  return { ok: true, value: trimmed };
}

/** The checker must be a different person from the maker. */
export function isSeparateChecker(
  requestedBy: string | null,
  decidedBy: string
): boolean {
  return requestedBy === null || requestedBy !== decidedBy;
}
