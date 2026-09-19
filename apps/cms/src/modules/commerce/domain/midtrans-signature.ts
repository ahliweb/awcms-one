/**
 * Midtrans Snap webhook signature (Issue #110, contract #106's D3): a pure,
 * side-effect-free hash/compare — no I/O, no database, no fetch. The webhook
 * INTAKE route that will call this is #113's own scope; this issue only
 * ships the verification primitive plus its unit test, per the brief's own
 * instruction not to build the route yet.
 *
 * Midtrans's own documented rule: `signature_key` in the callback body is
 * `sha512(order_id + status_code + gross_amount + ServerKey)`, hex-encoded.
 * Comparison MUST be timing-safe — a webhook endpoint that leaks "how many
 * leading hex characters matched" via response latency is an oracle an
 * attacker can use to forge a valid signature one byte at a time.
 */
import { createHash, timingSafeEqual } from "node:crypto";

const SHA512_HEX_PATTERN = /^[0-9a-f]{128}$/i;

export type MidtransSignatureInput = {
  orderId: string;
  statusCode: string;
  grossAmount: string;
  serverKey: string;
};

/** The expected signature for `input` — hex-encoded SHA-512. */
export function computeMidtransSignature(
  input: MidtransSignatureInput
): string {
  return createHash("sha512")
    .update(
      `${input.orderId}${input.statusCode}${input.grossAmount}${input.serverKey}`
    )
    .digest("hex");
}

/**
 * `true` only when `signatureKey` is a well-formed 128-character hex string
 * AND matches the expected signature, compared via `timingSafeEqual` (never
 * `===` on a secret-derived value). A malformed `signatureKey` (wrong
 * length, non-hex characters) fails IMMEDIATELY, before any timing-safe
 * comparison is attempted — there is nothing to compare in constant time
 * against, and rejecting early does not leak more than the shape check
 * itself already reveals (the expected signature is always exactly 128 hex
 * characters, a fact public in Midtrans's own documentation).
 */
export function verifyMidtransSignature(
  input: MidtransSignatureInput & { signatureKey: string }
): boolean {
  if (!SHA512_HEX_PATTERN.test(input.signatureKey)) return false;

  const expected = computeMidtransSignature(input);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(input.signatureKey.toLowerCase(), "hex");

  if (expectedBuffer.length !== actualBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, actualBuffer);
}
