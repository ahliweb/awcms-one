import type { APIRoute } from "astro";

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
import { requestCustomerOtp } from "../../../../../../../modules/commerce/application/customer-auth";
import { resolveCustomerOtpChannel } from "../../../../../../../modules/commerce/application/customer-otp-channel-adapters";
import { resolveWhatsappCustomerOtpChannel } from "../../../../../../../modules/commerce/application/whatsapp-otp-channel-adapter";
import { commercePreflightResponse } from "../../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `POST /api/v1/commerce/storefront/account/otp/request` (Issue #89,
 * contract #86/ADR-0016 D2) — anonymous, cross-origin. Answers `202` for
 * EVERY outcome — a malformed request answers `400 VALIDATION_ERROR`
 * (about the REQUEST, leaks nothing about any e-mail), but an unknown
 * tenant, a rate-limited caller, an e-mail with no account, and a
 * genuinely-issued code all answer the identical `202
 * {sent:true, expiresInSeconds}` (ADR-0016's own anti-enumeration rule,
 * same posture `newsletter/subscribe.ts` already takes for its address).
 *
 * Two independent rate-limit axes, same reasoning
 * `orders/index.ts` already documents for order creation: a per-IP ceiling
 * alone cannot protect the MAILBOX an OTP is sent to, since its owner
 * contributes no IP to this request at all.
 */
const RATE_LIMIT_WINDOW_SEC = parsePositiveIntSetting(
  process.env.COMMERCE_ACCOUNT_OTP_RATE_LIMIT_WINDOW_SEC,
  3600,
  "COMMERCE_ACCOUNT_OTP_RATE_LIMIT_WINDOW_SEC"
);
const RATE_LIMIT_MAX_PER_IP = parsePositiveIntSetting(
  process.env.COMMERCE_ACCOUNT_OTP_RATE_LIMIT_MAX_PER_IP,
  10,
  "COMMERCE_ACCOUNT_OTP_RATE_LIMIT_MAX_PER_IP"
);
const RATE_LIMIT_MAX_PER_EMAIL = parsePositiveIntSetting(
  process.env.COMMERCE_ACCOUNT_OTP_RATE_LIMIT_MAX_PER_EMAIL,
  5,
  "COMMERCE_ACCOUNT_OTP_RATE_LIMIT_MAX_PER_EMAIL"
);

const PREFLIGHT_ALLOWED_HEADERS = ["content-type"] as const;

export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const ipLimit = await checkSharedRateLimit(
    `commerce:account:otp:request:ip:${clientIp}`,
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
  const emailForRateLimit =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (emailForRateLimit) {
    const emailLimit = await checkSharedRateLimit(
      `commerce:account:otp:request:email:${emailForRateLimit}`,
      {
        maxAttempts: RATE_LIMIT_MAX_PER_EMAIL,
        windowMs: RATE_LIMIT_WINDOW_SEC * 1000
      }
    );
    if (!emailLimit.allowed) {
      return fail(
        429,
        "RATE_LIMITED",
        "Too many requests for this e-mail address. Try again later.",
        {},
        undefined,
        { "retry-after": String(emailLimit.retryAfterSec), vary: "Origin" }
      );
    }
  }

  const sql = getDatabaseClient();
  const via = body.via === "whatsapp" ? "whatsapp" : "email";
  const channel =
    via === "whatsapp"
      ? resolveWhatsappCustomerOtpChannel()
      : resolveCustomerOtpChannel();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant) =>
      requestCustomerOtp(
        tx,
        tenant.tenantId,
        tenant.tenantName,
        body as {
          email: unknown;
          purpose: unknown;
          name?: unknown;
          phone?: unknown;
          via?: unknown;
        },
        channel,
        locals.correlationId
      )
  );

  // Unresolved tenant (already latency-padded by `withPublicCommerceTenant`)
  // and a validation failure both answer here — the FIRST is the anti-
  // enumeration floor (still 202, never leaking "this host has no tenant"),
  // the second is about the request shape, not any e-mail, so it is safe to
  // surface as a real 400.
  if (!result) {
    return ok({ sent: true, expiresInSeconds: 600 }, {}, corsHeaders);
  }

  if (result.kind === "validation_error") {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid OTP request.",
      {},
      result.errors,
      corsHeaders
    );
  }

  if (result.kind === "channel_unavailable") {
    // Configuration, not enumeration (ADR-0017 D5) — WhatsApp is not
    // enabled/configured for this deployment, independent of whether the
    // phone supplied has an account.
    return fail(
      409,
      "CHANNEL_UNAVAILABLE",
      "The WhatsApp channel is not available for this store.",
      {},
      undefined,
      corsHeaders
    );
  }

  return ok(
    { sent: true, expiresInSeconds: result.expiresInSeconds },
    {},
    corsHeaders
  );
};

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:otp:request",
    {
      maxAttempts: RATE_LIMIT_MAX_PER_IP,
      windowMs: RATE_LIMIT_WINDOW_SEC * 1000
    },
    PREFLIGHT_ALLOWED_HEADERS
  );
