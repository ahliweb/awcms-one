import { timingSafeEqual } from "node:crypto";

import {
  normalizeEmail,
  isWellFormedEmail
} from "./customer-account-validation";
import { normalizePhoneNumber } from "./phone-normalisation";

/**
 * Pure parts of the `otp/verify` idempotency contract (Issue #513, work unit B,
 * ADR-0016). No database, no I/O beyond a constant-time compare.
 *
 * ## The contract in one paragraph
 *
 * `Idempotency-Key` is OPTIONAL on `POST .../account/otp/verify`. When present
 * it is an opaque `[A-Za-z0-9_-]{16,128}` value (a `crypto.randomUUID()` per
 * user attempt, stable across retries of that attempt). Within
 * {@link OTP_VERIFY_IDEMPOTENCY_TTL_SECONDS} the same key with the same request
 * replays the outcome (a FRESH session for the same account, never a stored
 * token); the same key with another request is `409 IDEMPOTENCY_CONFLICT`.
 *
 * The shape is narrower than the platform-wide header bound
 * (`lib/security/idempotency-key-bound.ts`: 1-255 visible ASCII, enforced for
 * every `/api` route in the middleware) on purpose: this route is anonymous, so
 * the key is an unguessable client-generated value, and a 16-character floor
 * keeps a short guessable key (`"1"`, `"retry"`) from being used at all.
 */

/** Replay window. Long enough for a flaky-network retry or a reload, short enough that a leaked key is of no use; equals the OTP's own lifetime (a replay can never outlive the code it replays). */
export const OTP_VERIFY_IDEMPOTENCY_TTL_SECONDS = 600;

/** `awcms_idempotency_keys.request_scope` of every `otp/verify` record. */
export const OTP_VERIFY_IDEMPOTENCY_SCOPE = "commerce.customer_otp_verify";

export const OTP_VERIFY_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type IdempotencyKeyHeader =
  { kind: "absent" } | { kind: "valid"; key: string } | { kind: "invalid" };

/** `null` (no header) is absent; anything else must match the shape exactly (no trimming: a value with a space is not a key this contract issued). */
export function parseOtpVerifyIdempotencyKey(
  raw: string | null
): IdempotencyKeyHeader {
  if (raw === null) return { kind: "absent" };
  return OTP_VERIFY_IDEMPOTENCY_KEY_PATTERN.test(raw)
    ? { kind: "valid", key: raw }
    : { kind: "invalid" };
}

/** The normalised, validated identity of one verify request — exactly what the request digest is computed from. */
export type OtpVerifyIdentity = {
  purpose: "login" | "register";
  identifierColumn: "email_normalized" | "phone_normalized";
  identifierValue: string;
  code: string;
};

/**
 * The same acceptance rules `verifyCustomerOtp` applies, reduced to "is this a
 * request that will reach the OTP check, and as whom". `null` for anything the
 * verifier will answer with `validation_error`: such a request never touches the
 * idempotency store (nothing to replay, nothing to conflict with).
 */
export function deriveOtpVerifyIdentity(input: {
  email: unknown;
  phone?: unknown;
  code: unknown;
  purpose: unknown;
}): OtpVerifyIdentity | null {
  if (input.purpose !== "login" && input.purpose !== "register") return null;

  const rawEmail = typeof input.email === "string" ? input.email : "";
  const rawPhone = typeof input.phone === "string" ? input.phone : "";
  const hasEmail = rawEmail.trim().length > 0;
  const hasPhone = rawPhone.trim().length > 0;
  if (hasEmail === hasPhone) return null;

  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (!/^\d{6}$/.test(code)) return null;

  if (hasPhone) {
    if (input.purpose === "register") return null;
    const phone = normalizePhoneNumber(rawPhone);
    if (!phone.valid) return null;
    return {
      purpose: input.purpose,
      identifierColumn: "phone_normalized",
      identifierValue: phone.value,
      code
    };
  }

  const email = normalizeEmail(rawEmail);
  if (!isWellFormedEmail(email)) return null;
  return {
    purpose: input.purpose,
    identifierColumn: "email_normalized",
    identifierValue: email,
    code
  };
}

/** Constant-time equality of two request digests (lower-case hex of equal length when both come from the keyed HMAC; unequal lengths are simply unequal). */
export function otpVerifyDigestsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
