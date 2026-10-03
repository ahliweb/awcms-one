/**
 * The HTTP plumbing every register route (`/api/v1/commerce/registers*`,
 * `/api/v1/commerce/register-sessions*`) shares (Issue #284, ADR-0028): the
 * `Idempotency-Key` header, body parsing, the feature gate, and the one
 * mapping of the idempotency store's errors to a response. Declared once so
 * ten routes cannot drift into ten slightly different answers.
 */
import { fail, jsonResponse } from "../../_shared/api-response";
import { IdempotencyRaceLostError } from "../../_shared/idempotency";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../lib/security/request-body-limit";
import type { ValidationError } from "../domain/register";
import { requireCommerceFeatureForOwnerRoute } from "./commerce-feature-gate";
import { IdempotencyPayloadMismatchError } from "./order-directory";

/** `null` when the header is present, else the `400` to return. */
export function requireIdempotencyKey(
  request: Request
): { key: string } | { response: Response } {
  const key = request.headers.get("idempotency-key");
  if (!key || key.trim().length === 0) {
    return {
      response: fail(
        400,
        "IDEMPOTENCY_REQUIRED",
        "Idempotency-Key header is required."
      )
    };
  }
  return { key };
}

/** Reads a JSON body (size-bounded) and runs `validate` on it; a failure is the finished `400`/`413` response. */
export async function readValidatedBody<T>(
  request: Request,
  validate: (
    body: unknown
  ) => { valid: true; value: T } | { valid: false; errors: ValidationError[] }
): Promise<T | Response> {
  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const result = validate(bodyRead.value ?? {});
  if (!result.valid) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Request body failed validation.",
      {},
      result.errors
    );
  }
  return result.value;
}

/** `409 FEATURE_DISABLED` while the tenant's `register` feature is off, else `null`. */
export function requireRegisterFeature(
  tx: Bun.SQL,
  tenantId: string
): Promise<Response | null> {
  return requireCommerceFeatureForOwnerRoute(tx, tenantId, "register");
}

/**
 * Maps the two idempotency-store errors every mutation can raise; `null` for
 * anything else (the caller rethrows). A lost race whose winner had the same
 * payload transparently replays the winner's stored response.
 */
export function idempotencyErrorResponse(error: unknown): Response | null {
  if (error instanceof IdempotencyRaceLostError) {
    if (error.replay) {
      return jsonResponse(error.replay.responseBody, {
        status: error.replay.responseStatus
      });
    }
    return fail(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key was already used with a different request."
    );
  }
  if (error instanceof IdempotencyPayloadMismatchError) {
    return fail(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key was already used with a different request."
    );
  }
  return null;
}
