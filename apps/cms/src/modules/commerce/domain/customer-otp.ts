import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Customer e-mail OTP (Issue #87, C1, contract #86/ADR-0016 D2). Pure — no
 * database, no I/O beyond the platform CSPRNG.
 *
 * ## Why a 6-digit code, not a bearer token
 *
 * This is the credential a shopper TYPES BACK from an e-mail, on a phone
 * keyboard, so it has to stay short — `generateOtpCode` uses
 * `crypto.randomInt` (CSPRNG, not `Math.random()`) over the full `000000`-
 * `999999` range, including leading zeros (a code shorter than 6 digits
 * because a leading zero was dropped would be a visible tell that codes
 * cluster in the second half of the range).
 *
 * ## Why the hash is SALTED with tenant + email, not a bare `sha256(code)`
 *
 * A bare `sha256(code)` hash has only 10^6 possible values — small enough
 * that an attacker holding a stolen `code_hash` could brute-force the
 * digest offline instantly (unlike a 256-bit session/reset token, where the
 * SAME simple hash is fine specifically because there is nothing to grind).
 * Salting the digest with `tenant_id` and the normalised e-mail (both
 * already stored alongside the row, never secret) does not add entropy to
 * the SPACE (still 10^6 codes), but it does mean one leaked `code_hash`
 * cannot be checked against a rainbow table shared by every tenant/e-mail —
 * the same code for two different e-mails/tenants hashes to two different
 * values, so a precomputed table would have to be rebuilt per (tenant,
 * email) pair, which is exactly as expensive as brute-forcing it fresh. The
 * REAL defence against guessing is `OTP_MAX_ATTEMPTS` enforced by
 * `consumeOtp`'s single `UPDATE ... RETURNING` (see
 * `application/customer-account-store.ts`), not the hash construction —
 * this salt only removes the "one shared rainbow table for all rows"
 * shortcut.
 */

/** 10 minutes — ADR-0016 D2. */
export const OTP_TTL_SECONDS = 600;

/** 5 tries, then the code is dead even if the correct value is submitted next — ADR-0016 D2. */
export const OTP_MAX_ATTEMPTS = 5;

const OTP_LENGTH = 6;
const OTP_MAX_VALUE = 10 ** OTP_LENGTH;

/** `"000000"`-`"999999"`, CSPRNG, zero-padded. */
export function generateOtpCode(): string {
  return randomInt(0, OTP_MAX_VALUE).toString(10).padStart(OTP_LENGTH, "0");
}

/**
 * `sha256:<hex>` of `tenantId:emailNormalized:code` — see the module header
 * for why the salt is the (tenant, email) pair rather than a random value
 * (a random per-row salt would have to be stored somewhere to verify
 * against later, and storing it beside `code_hash` gives an attacker
 * exactly what the salt was trying to withhold).
 */
export function hashOtpCode(
  code: string,
  emailNormalized: string,
  tenantId: string
): string {
  const digest = createHash("sha256")
    .update(`${tenantId}:${emailNormalized}:${code}`, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

/**
 * Constant-time comparison of two `code_hash` values. Both sides are always
 * a `sha256:` + 64 hex chars string of identical length when they come from
 * this module, so `timingSafeEqual` (which throws on unequal lengths) is
 * safe to call directly after the length guard below.
 */
export function verifyOtpCode(
  candidateHash: string,
  storedHash: string
): boolean {
  const left = Buffer.from(candidateHash, "utf8");
  const right = Buffer.from(storedHash, "utf8");

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

export function isOtpExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= expiresAt.getTime();
}
