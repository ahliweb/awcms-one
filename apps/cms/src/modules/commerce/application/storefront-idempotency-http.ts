import { fail } from "../../_shared/api-response";
import {
  parseStorefrontIdempotencyKey,
  STOREFRONT_IDEMPOTENCY_KEY_INVALID
} from "../domain/storefront-idempotency";

/**
 * HTTP edge of the optional `Idempotency-Key` contract (Issue #513, unit C),
 * shared by the six mutating storefront routes so each answers the same two
 * errors the same way (and the same ones `otp/verify` answers).
 */

/**
 * Reads the header. Absent -> `{ key: null }`; well-formed -> `{ key }`; any
 * other value is a `400 IDEMPOTENCY_KEY_INVALID` (never silently ignored, or a
 * client with a malformed key would believe it was protected). Answered before
 * any database work.
 */
export function readStorefrontIdempotencyKey(
  request: Request
): { key: string | null } | { response: Response } {
  const header = parseStorefrontIdempotencyKey(
    request.headers.get("idempotency-key")
  );
  if (header.kind === "invalid") {
    return {
      response: fail(
        400,
        STOREFRONT_IDEMPOTENCY_KEY_INVALID.code,
        STOREFRONT_IDEMPOTENCY_KEY_INVALID.message,
        {},
        undefined,
        { vary: "Origin" }
      )
    };
  }
  return { key: header.kind === "valid" ? header.key : null };
}

/** `409 IDEMPOTENCY_CONFLICT`: the key was already used by a different request. */
export function storefrontIdempotencyConflictResponse(
  corsHeaders: Record<string, string>
): Response {
  return fail(
    409,
    "IDEMPOTENCY_CONFLICT",
    "Idempotency-Key was already used with a different request.",
    {},
    undefined,
    corsHeaders
  );
}
