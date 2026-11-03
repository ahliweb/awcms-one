import {
  OTP_VERIFY_IDEMPOTENCY_KEY_PATTERN,
  otpVerifyDigestsEqual,
  parseOtpVerifyIdempotencyKey,
  type IdempotencyKeyHeader
} from "./customer-otp-idempotency";

/**
 * Pure parts of the optional `Idempotency-Key` contract of the mutating
 * storefront endpoints (Issue #513, work unit C; unit B did the same for
 * `otp/verify`). The key SHAPE is the one unit B fixed so a storefront sends one
 * kind of key everywhere: an opaque `[A-Za-z0-9_-]{16,128}` value (a
 * `crypto.randomUUID()` per user attempt, stable across retries of that
 * attempt). Same key + same request replays the original success; same key +
 * another request is `409 IDEMPOTENCY_CONFLICT`; no key = the route behaves as
 * before (each route's own natural idempotency is the only guard).
 *
 * See `application/storefront-idempotency.ts` for the storage side.
 */

/**
 * How long a recorded success may be replayed. Longer than the OTP's 10
 * minutes (an address or a message is not a one-shot secret) but short enough
 * that a key left in a browser is of no use the next day. Outside the window a
 * row is ignored (an ordinary request) and never overwritten.
 */
export const STOREFRONT_IDEMPOTENCY_TTL_SECONDS = 3600;

/** `awcms_idempotency_keys.request_scope` of every record, one per route (so a key is scoped per tenant AND per route). */
export const STOREFRONT_IDEMPOTENCY_SCOPES = {
  accountAddressCreate: "commerce.storefront.account_address_create",
  accountConversationCreate: "commerce.storefront.account_conversation_create",
  accountMessagePost: "commerce.storefront.account_message_post",
  paymentConfirmationCreate: "commerce.storefront.payment_confirmation_create",
  orderCancel: "commerce.storefront.order_cancel",
  reviewCreate: "commerce.storefront.review_create"
} as const;

export type StorefrontIdempotencyScope =
  (typeof STOREFRONT_IDEMPOTENCY_SCOPES)[keyof typeof STOREFRONT_IDEMPOTENCY_SCOPES];

export const STOREFRONT_IDEMPOTENCY_KEY_PATTERN =
  OTP_VERIFY_IDEMPOTENCY_KEY_PATTERN;

export type StorefrontIdempotencyKeyHeader = IdempotencyKeyHeader;

/** `null` (no header) is absent; anything else must match the shape exactly. */
export function parseStorefrontIdempotencyKey(
  raw: string | null
): StorefrontIdempotencyKeyHeader {
  return parseOtpVerifyIdempotencyKey(raw);
}

/** Constant-time equality of two request digests. */
export const storefrontDigestsEqual = otpVerifyDigestsEqual;

/** The one `400` every keyed route answers for a malformed header (the same code unit B's `otp/verify` uses). */
export const STOREFRONT_IDEMPOTENCY_KEY_INVALID = {
  code: "IDEMPOTENCY_KEY_INVALID",
  message:
    "Idempotency-Key must be 16 to 128 characters of A-Z, a-z, 0-9, '_' or '-'."
} as const;
