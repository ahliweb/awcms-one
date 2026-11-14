import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../lib/security/rate-limit";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { resolveCustomerOtpChannel } from "../../../../../../../modules/commerce/application/customer-otp-channel-adapters";
import { requireCustomerSession } from "../../../../../../../modules/commerce/application/customer-session-auth";
import { requestSubjectOtp } from "../../../../../../../modules/commerce/application/customer-subject-otp";
import { commerceIdempotentPreflightHeaders } from "../../../../../../../modules/commerce/domain/commerce-cors";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";
import { NO_STORE_HEADERS } from "../../../../../../../modules/commerce/application/customer-subject-http";

/**
 * `POST /api/v1/commerce/storefront/account/privacy/otp` (Issue #529,
 * ADR-0055 D3) - bearer. Mails a fresh one-time code to the account's own
 * e-mail address for a data-subject `export` or `erasure`: the second proof the
 * request needs on top of the session. Body `{ "type": "export" | "erasure" }`.
 *
 * The caller is already authenticated, so unlike the sign-in code request there
 * is nothing to hide: `200 { sent: true, expiresInSeconds }`. Rate limited per
 * IP and per account (a stolen session must not be able to flood the mailbox of
 * its owner). A repeat inside the resend window is a no-op success.
 */
const RATE_LIMIT_WINDOW_MS = 3_600_000;
const RATE_LIMIT_MAX_PER_IP = 10;
const RATE_LIMIT_MAX_PER_ACCOUNT = 5;

const PREFLIGHT_ALLOWED_HEADERS = commerceIdempotentPreflightHeaders([
  "content-type",
  "authorization"
]);

export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const ipLimit = await checkSharedRateLimit(
    `commerce:account:privacy:otp:ip:${clientIp}`,
    { maxAttempts: RATE_LIMIT_MAX_PER_IP, windowMs: RATE_LIMIT_WINDOW_MS }
  );
  if (!ipLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many requests from this source. Try again later.",
      {},
      undefined,
      { "retry-after": String(ipLimit.retryAfterSec), vary: "Origin" }
    );
  }

  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
  const body = (bodyRead.value ?? {}) as Record<string, unknown>;
  const type = body.type;

  const sql = getDatabaseClient();
  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant) => {
      const auth = await requireCustomerSession(request, tx, tenant.tenantId);
      if (!auth.ok) return { kind: "unauthenticated" } as const;
      if (type !== "export" && type !== "erasure") {
        return { kind: "invalid_type" } as const;
      }

      const accountLimit = await checkSharedRateLimit(
        `commerce:account:privacy:otp:account:${auth.account.id}`,
        {
          maxAttempts: RATE_LIMIT_MAX_PER_ACCOUNT,
          windowMs: RATE_LIMIT_WINDOW_MS
        }
      );
      if (!accountLimit.allowed) {
        return {
          kind: "limited",
          retryAfterSec: accountLimit.retryAfterSec
        } as const;
      }

      const outcome = await requestSubjectOtp(
        tx,
        tenant.tenantId,
        tenant.tenantName,
        auth.account.id,
        type,
        resolveCustomerOtpChannel(),
        locals.correlationId
      );
      return outcome.kind === "sent"
        ? ({
            kind: "sent",
            expiresInSeconds: outcome.expiresInSeconds
          } as const)
        : ({ kind: "unauthenticated" } as const);
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
  if (result.kind === "invalid_type") {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid request.",
      {},
      [{ field: "type", message: 'type must be "export" or "erasure".' }],
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

  return ok(
    { sent: true, expiresInSeconds: result.expiresInSeconds },
    {},
    { ...corsHeaders, ...NO_STORE_HEADERS }
  );
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:privacy:otp",
    { maxAttempts: 60, windowMs: 60_000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
