import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import { checkSharedRateLimit } from "../../../../../../../lib/security/rate-limit";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { storefrontErase } from "../../../../../../../modules/commerce/application/customer-subject-flow";
import {
  NO_STORE_HEADERS,
  erasureRefusedResponse,
  subjectKeyRequiredResponse,
  subjectOtpInvalidResponse
} from "../../../../../../../modules/commerce/application/customer-subject-http";
import { readStorefrontIdempotencyKey } from "../../../../../../../modules/commerce/application/storefront-idempotency-http";
import { commerceIdempotentPreflightHeaders } from "../../../../../../../modules/commerce/domain/commerce-cors";
import {
  isWellFormedSubjectOtpCode,
  type SubjectRefusalCode
} from "../../../../../../../modules/commerce/domain/customer-subject-policy";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `POST /api/v1/commerce/storefront/account/privacy/erasure` (Issue #529,
 * ADR-0055 D2/D3) - bearer plus a fresh one-time code (`privacy/otp` with
 * `type: "erasure"`) plus a required `Idempotency-Key`. Body
 * `{ "code": "123456" }`.
 *
 * - `200 { erased: true, summary }` - the shopper's identity was anonymised, the
 *   personal rows were deleted and every session (this one too) was revoked, so
 *   the NEXT request with the old bearer is `401` and the storefront clears its
 *   stored session. `summary` lists counts and the table families kept for
 *   bookkeeping, never content.
 * - `409 ERASURE_REFUSED` with `details.refusals` - an order, booking, stored-
 *   value balance, refund or affiliate payout is still open. Nothing changed and
 *   the code was not consumed.
 * - A repeated key answers the stored result only for a REFUSED attempt (the
 *   same `409 ERASURE_REFUSED`); a key already used by a different request is
 *   `409 IDEMPOTENCY_CONFLICT`. After a COMPLETED erasure every session is
 *   gone, so a retry of the same request is `401` before the key is looked at:
 *   that `401` is the client's signal that the erasure went through.
 * - Per-account rate limit (`429 RATE_LIMITED`), because a refusal is recorded
 *   and audited before the code is consumed.
 *
 * Every failure of the code is one generic `400 OTP_INVALID` (ADR-0016).
 */
const PREFLIGHT_ALLOWED_HEADERS = commerceIdempotentPreflightHeaders([
  "content-type",
  "authorization"
]);

export const POST: APIRoute = async ({ request, locals }) => {
  const keyRead = readStorefrontIdempotencyKey(request);
  if ("response" in keyRead) return keyRead.response;
  if (keyRead.key === null) {
    return subjectKeyRequiredResponse("Idempotency-Key header is required.", {
      vary: "Origin"
    });
  }
  const idempotencyKey = keyRead.key;

  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = (bodyRead.value ?? {}) as Record<string, unknown>;

  const sql = getDatabaseClient();
  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant) => {
      const auth = await requireCustomerSession(request, tx, tenant.tenantId);
      if (!auth.ok) return { kind: "unauthenticated" } as const;
      // Per account, before anything is written: a refusal is recorded (and
      // audited) before the code is consumed, so an unlimited loop of fresh
      // keys would flood the evidence and audit tables.
      const limit = await checkSharedRateLimit(
        `commerce:account:privacy:erasure:account:${auth.account.id}`,
        { maxAttempts: 20, windowMs: 3_600_000 }
      );
      if (!limit.allowed) {
        return { kind: "limited", retryAfterSec: limit.retryAfterSec } as const;
      }
      if (!isWellFormedSubjectOtpCode(body.code)) {
        return { kind: "otp_invalid" } as const;
      }
      return storefrontErase(
        tx,
        tenant.tenantId,
        auth.account,
        body.code,
        idempotencyKey,
        { correlationId: locals.correlationId }
      );
    }
  );

  if (!result || result.kind === "unauthenticated") {
    return fail(
      401,
      "UNAUTHENTICATED",
      "Missing, invalid, or expired session.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (result.kind === "limited") {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many requests for this account. Try again later.",
      {},
      undefined,
      { ...corsHeaders, "retry-after": String(result.retryAfterSec) }
    );
  }
  if (result.kind === "otp_invalid") {
    return subjectOtpInvalidResponse(corsHeaders);
  }
  if (result.kind === "key_conflict") {
    return fail(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key was already used with a different request.",
      {},
      undefined,
      corsHeaders
    );
  }
  if (result.kind === "refused") {
    return erasureRefusedResponse(result.codes, corsHeaders);
  }
  if (result.kind === "replayed" && result.request.status === "refused") {
    return erasureRefusedResponse(
      result.request.refusalCode
        ? [result.request.refusalCode as SubjectRefusalCode]
        : [],
      corsHeaders
    );
  }

  const request_ = result.request;
  return ok(
    {
      erased: request_.status === "completed",
      replayed: result.kind === "replayed",
      requestId: request_.id,
      summary: request_.retainedSummary
    },
    {},
    { ...corsHeaders, ...NO_STORE_HEADERS }
  );
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:privacy:erasure",
    { maxAttempts: 60, windowMs: 60_000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
