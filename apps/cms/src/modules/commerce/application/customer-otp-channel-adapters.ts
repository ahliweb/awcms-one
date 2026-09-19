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
  fetchActiveEmailTemplateByKey,
  seedDefaultEmailTemplates
} from "../../email/application/email-template-directory";
import type { DefaultEmailTemplate } from "../../email/domain/email-default-templates";
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

/**
 * The default template, byte-for-byte what `sql/919` seeded for the tenants
 * that existed when it ran. A tenant created LATER has no row, and
 * `enqueueDirectAddressEmail` answers `enqueued: false` for a missing
 * template — which the OTP request would swallow into its neutral 202 and
 * the shopper would simply never receive a code. So the adapter seeds this
 * row itself on first miss (`ON CONFLICT DO NOTHING`, inside the same
 * transaction, nil-uuid actor exactly like the migration) and retries once.
 * An operator who has edited the tenant's own copy is never overwritten:
 * the seed only fires when no active row exists at all.
 */
export const CUSTOMER_OTP_DEFAULT_TEMPLATE = {
  name: "Customer OTP",
  subject: {
    en: "Your verification code",
    id: "Kode verifikasi Anda"
  },
  textBody: {
    en: "Your verification code is {{code}}. It expires in {{expiresInMinutes}} minutes.\n\n{{storeName}}",
    id: "Kode verifikasi Anda adalah {{code}}. Kode ini kedaluwarsa dalam {{expiresInMinutes}} menit.\n\n{{storeName}}"
  }
} as const;

const SEED_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

/** Returns `true` when a template row now exists (seeded here or already present). */
export async function ensureCustomerOtpTemplate(
  tx: Bun.SQL,
  tenantId: string
): Promise<boolean> {
  const existing = await fetchActiveEmailTemplateByKey(
    tx,
    tenantId,
    CUSTOMER_OTP_TEMPLATE_KEY
  );
  if (existing) return true;

  // Through the email module's own seeder — `awcms_email_templates` is that
  // module's table and `modules:table-writes:check` keeps it so.
  const template: DefaultEmailTemplate = {
    templateKey: CUSTOMER_OTP_TEMPLATE_KEY,
    name: CUSTOMER_OTP_DEFAULT_TEMPLATE.name,
    subjectTemplate: { ...CUSTOMER_OTP_DEFAULT_TEMPLATE.subject },
    textBodyTemplate: { ...CUSTOMER_OTP_DEFAULT_TEMPLATE.textBody }
  };
  await seedDefaultEmailTemplates(tx, tenantId, SEED_ACTOR_ID, [template]);

  return (
    (await fetchActiveEmailTemplateByKey(
      tx,
      tenantId,
      CUSTOMER_OTP_TEMPLATE_KEY
    )) !== null
  );
}

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
      const correlationId = request.correlationId ?? crypto.randomUUID();
      const enqueue = () =>
        enqueueDirectAddressEmail(
          tx,
          request.tenantId,
          CUSTOMER_OTP_TEMPLATE_KEY,
          request.emailNormalized,
          buildVariables(request),
          correlationId
        );

      let result = await enqueue();
      if (!result.enqueued) {
        // Either the address is suppressed (respect it — no retry helps) or
        // the tenant has no template yet (seed it, then try once more).
        const seeded = await ensureCustomerOtpTemplate(tx, request.tenantId);
        if (seeded) result = await enqueue();
      }

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
