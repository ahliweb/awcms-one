import type { APIRoute } from "astro";
import { createHash } from "node:crypto";

import { getDatabaseClient } from "../../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../../lib/security/env-thresholds";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { verifyCustomerOtp } from "../../../../../../../modules/commerce/application/customer-auth";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `POST /api/v1/commerce/storefront/account/otp/verify` (Issue #89,
 * contract #86/ADR-0016 D2/D3/D4) — anonymous, cross-origin.
 *
 * Every OTP failure reason — wrong code, expired, consumed, attempts
 * exhausted, or no such request at all — collapses to the SAME
 * `401 OTP_INVALID` (see `customer-account-store.ts`'s `consumeOtp` header
 * for why: a caller must not be able to tell a wrong guess from an expired
 * code from a request that never happened). `404 ACCOUNT_NOT_FOUND`
 * (`purpose: "login"`, no account) and `409 PHONE_ALREADY_REGISTERED`
 * (`purpose: "register"`, phone already bound) are deliberately NOT folded
 * into the same 401 — both are documented, acceptable exceptions in the
 * contract (the caller already proved control of the mailbox by supplying
 * the right code, so neither response is a new oracle).
 */
const RATE_LIMIT_WINDOW_SEC = parsePositiveIntSetting(
  process.env.COMMERCE_ACCOUNT_OTP_VERIFY_RATE_LIMIT_WINDOW_SEC,
  3600,
  "COMMERCE_ACCOUNT_OTP_VERIFY_RATE_LIMIT_WINDOW_SEC"
);
const RATE_LIMIT_MAX_PER_IP = parsePositiveIntSetting(
  process.env.COMMERCE_ACCOUNT_OTP_VERIFY_RATE_LIMIT_MAX_PER_IP,
  20,
  "COMMERCE_ACCOUNT_OTP_VERIFY_RATE_LIMIT_MAX_PER_IP"
);

const PREFLIGHT_ALLOWED_HEADERS = ["content-type"] as const;

/** A coarse, non-reversible client fingerprint for `client_ip_hash` — same idea `awcms_sessions` already uses, own copy so this module has no dependency on the staff session hasher. */
function hashClientIp(ip: string): string {
  return `sha256:${createHash("sha256").update(ip, "utf8").digest("hex")}`;
}

function summarizeUserAgent(value: string | null): string | null {
  if (!value) return null;
  return value.slice(0, 200);
}

export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const ipLimit = await checkSharedRateLimit(
    `commerce:account:otp:verify:ip:${clientIp}`,
    {
      maxAttempts: RATE_LIMIT_MAX_PER_IP,
      windowMs: RATE_LIMIT_WINDOW_SEC * 1000
    }
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

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant) =>
      verifyCustomerOtp(
        tx,
        tenant.tenantId,
        body as { email: unknown; code: unknown; purpose: unknown },
        {
          clientIpHash: hashClientIp(clientIp),
          userAgentSummary: summarizeUserAgent(
            request.headers.get("user-agent")
          )
        },
        locals.correlationId
      )
  );

  if (!result) {
    // Unresolved tenant — the same neutral floor every other anonymous
    // commerce route uses; `withPublicCommerceTenant` already paid the
    // padded latency.
    return fail(404, "NOT_FOUND", "Not found.", {}, undefined, corsHeaders);
  }

  if (result.kind === "validation_error") {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid OTP verification request.",
      {},
      result.errors,
      corsHeaders
    );
  }

  if (result.kind === "otp_invalid") {
    return fail(
      401,
      "OTP_INVALID",
      "The code is invalid, expired, or has already been used.",
      {},
      undefined,
      corsHeaders
    );
  }

  if (result.kind === "account_not_found") {
    return fail(
      404,
      "ACCOUNT_NOT_FOUND",
      "No account exists for this e-mail address.",
      {},
      undefined,
      corsHeaders
    );
  }

  if (result.kind === "phone_already_registered") {
    return fail(
      409,
      "PHONE_ALREADY_REGISTERED",
      "This phone number is already registered to another account.",
      {},
      undefined,
      corsHeaders
    );
  }

  if (result.kind === "blocked") {
    return fail(
      403,
      "ACCOUNT_BLOCKED",
      "This account has been blocked.",
      {},
      undefined,
      corsHeaders
    );
  }

  return ok(
    {
      token: result.token,
      expiresAt: result.expiresAt,
      account: result.account
    },
    {},
    corsHeaders
  );
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:otp:verify",
    {
      maxAttempts: RATE_LIMIT_MAX_PER_IP,
      windowMs: RATE_LIMIT_WINDOW_SEC * 1000
    },
    PREFLIGHT_ALLOWED_HEADERS
  );
