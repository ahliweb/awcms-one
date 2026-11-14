import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import { checkSharedRateLimit } from "../../../../../../../lib/security/rate-limit";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { storefrontExport } from "../../../../../../../modules/commerce/application/customer-subject-flow";
import {
  NO_STORE_HEADERS,
  subjectOtpInvalidResponse
} from "../../../../../../../modules/commerce/application/customer-subject-http";
import { commerceIdempotentPreflightHeaders } from "../../../../../../../modules/commerce/domain/commerce-cors";
import { isWellFormedSubjectOtpCode } from "../../../../../../../modules/commerce/domain/customer-subject-policy";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `POST /api/v1/commerce/storefront/account/privacy/export` (Issue #529,
 * ADR-0055 D3/D4) - bearer plus a fresh one-time code (`privacy/otp` with
 * `type: "export"`). Body `{ "code": "123456" }`. Answers `200` with the
 * versioned JSON bundle of everything the store holds about the shopper,
 * `Cache-Control: no-store`; the bundle is NOT stored (a second copy would be a
 * retention duty of its own), and the disclosure is audited with counts only.
 *
 * The code is single-use, which is what makes a retry safe: a repeated request
 * needs a new code, and a wrong, expired or already used code is ONE generic
 * `400 OTP_INVALID` (ADR-0016). A missing or dead session is `401`.
 */
const PREFLIGHT_ALLOWED_HEADERS = commerceIdempotentPreflightHeaders([
  "content-type",
  "authorization"
]);

export const POST: APIRoute = async ({ request, locals }) => {
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
      // Per account, before anything is written: every disclosure writes an
      // evidence row and an audit event, so an unlimited loop of fresh keys
      // would flood those tables.
      const limit = await checkSharedRateLimit(
        `commerce:account:privacy:export:account:${auth.account.id}`,
        { maxAttempts: 20, windowMs: 3_600_000 }
      );
      if (!limit.allowed) {
        return { kind: "limited", retryAfterSec: limit.retryAfterSec } as const;
      }
      if (!isWellFormedSubjectOtpCode(body.code)) {
        return { kind: "otp_invalid" } as const;
      }
      return storefrontExport(tx, tenant.tenantId, auth.account, body.code, {
        correlationId: locals.correlationId
      });
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

  return ok(
    { bundle: result.bundle },
    {},
    { ...corsHeaders, ...NO_STORE_HEADERS }
  );
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:privacy:export",
    { maxAttempts: 60, windowMs: 60_000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
