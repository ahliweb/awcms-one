/**
 * Concrete `CustomerOtpChannel` adapters (Issue #89, contract #86/ADR-0016
 * D2) — `email` (the real path) and `log` (dev/CI, no mail credentials
 * needed). Owned by `commerce` itself, the same way `newsletter`'s
 * `subscribe.ts` calls `email`'s `enqueueDirectAddressEmail` directly rather
 * than through a port owned by `email` — this module already depends on
 * `email` for exactly this reason (see `module.ts`).
 *
 * ## Category registration happens HERE, at import time
 *
 * `registerDerivedEmailTemplateCategory` must run before any template using
 * `derived.commerce_customer_otp` is created/validated/rendered. This file
 * is imported by every composition root that can send an OTP (the
 * `otp/request` route, and any test that exercises the real adapter), so the
 * side effect fires before first use — the same "registered before use"
 * guarantee `newsletter`'s own derived category documents but (see its own
 * header) never actually wires up; this module does not repeat that gap.
 */
import { log } from "../../../lib/logging/logger";
import { registerDerivedEmailTemplateCategory } from "../../email/domain/email-template-categories";
import { enqueueDirectAddressEmail } from "../../email/application/direct-address-notification";
import {
  maskIdentifierValue,
  normalizeIdentifierValue
} from "../../profile-identity/domain/identifier";
import type {
  CustomerOtpChannel,
  CustomerOtpChannelRequest,
  CustomerOtpChannelResult
} from "../domain/customer-otp-channel";

/** `template_key` doubles as the category (`email`'s own convention) — one derived category, one template, one row per tenant. */
export const CUSTOMER_OTP_TEMPLATE_KEY = "derived.commerce_customer_otp";

/** The only variables the template may interpolate — `email-template-render.ts` silently drops anything else. */
export const CUSTOMER_OTP_TEMPLATE_VARIABLES = [
  "code",
  "expiresInMinutes",
  "storeName"
] as const;

registerDerivedEmailTemplateCategory(
  CUSTOMER_OTP_TEMPLATE_KEY,
  CUSTOMER_OTP_TEMPLATE_VARIABLES
);

function buildVariables(
  request: CustomerOtpChannelRequest
): Record<string, string> {
  return {
    code: request.code,
    expiresInMinutes: String(request.expiresInMinutes),
    storeName: request.storeName
  };
}

/**
 * The real path — enqueues one `awcms_email_messages` row inside the SAME
 * transaction as the OTP row (`application/customer-account-store.ts`'s
 * `issueOtp`), so a crash between the two can never leave a code that was
 * issued but whose delivery attempt was silently lost, nor the reverse.
 */
export function createEmailCustomerOtpChannel(): CustomerOtpChannel {
  return {
    async sendOtp(
      tx: Bun.SQL,
      request: CustomerOtpChannelRequest
    ): Promise<CustomerOtpChannelResult> {
      const result = await enqueueDirectAddressEmail(
        tx,
        request.tenantId,
        CUSTOMER_OTP_TEMPLATE_KEY,
        request.emailNormalized,
        buildVariables(request),
        request.correlationId ?? crypto.randomUUID()
      );

      return { sent: result.enqueued };
    }
  };
}

/**
 * Dev/CI path — writes a structured log line instead of touching the
 * outbox at all. Deliberately the ONLY place in this codebase that logs an
 * OTP code in the clear: there is no other way for a developer running
 * without mail credentials (or a CI suite) to learn what code was issued,
 * and this adapter is never selected when a real provider is configured
 * (`resolveCustomerOtpChannel` below). The e-mail address is still masked —
 * the code is the ONE piece of information this adapter exists to reveal.
 */
export function createLogCustomerOtpChannel(): CustomerOtpChannel {
  return {
    async sendOtp(
      _tx: Bun.SQL,
      request: CustomerOtpChannelRequest
    ): Promise<CustomerOtpChannelResult> {
      const normalized = normalizeIdentifierValue(
        "email",
        request.emailNormalized
      );

      log("info", "commerce.customer_otp.log_channel.send", {
        to: maskIdentifierValue(normalized, "email"),
        purpose: request.purpose,
        otpCode: request.code,
        expiresInMinutes: request.expiresInMinutes,
        correlationId: request.correlationId
      });

      return { sent: true };
    }
  };
}

/**
 * `log` whenever `EMAIL_PROVIDER=log` or `EMAIL_ENABLED` is not `"true"` —
 * the SAME two conditions `email-dispatch.ts` itself uses to decide whether
 * a queued message can ever actually leave, so a deployment that would
 * never dispatch the enqueued row gets the log channel instead of a code
 * that silently goes nowhere.
 */
export function resolveCustomerOtpChannel(
  env: NodeJS.ProcessEnv = process.env
): CustomerOtpChannel {
  if (env.EMAIL_ENABLED !== "true" || env.EMAIL_PROVIDER === "log") {
    return createLogCustomerOtpChannel();
  }
  return createEmailCustomerOtpChannel();
}
