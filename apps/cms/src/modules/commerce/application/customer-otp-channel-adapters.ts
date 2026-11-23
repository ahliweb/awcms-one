/**
 * Concrete `CustomerOtpChannel` adapters (Issue #89, contract #86/ADR-0016
 * D2) — `email` (the real path) and `log` (dev/CI, no mail credentials
 * needed). Owned by `commerce` itself, the same way `newsletter`'s
 * `subscribe.ts` calls `email`'s `enqueueDirectAddressEmail` directly rather
 * than through a port owned by `email` — this module already depends on
 * `email` for exactly this reason (see `module.ts`).
 *
 * ## Category registration: `../domain/email-template-categories.ts` (Issue #311)
 *
 * The category is registered by importing the side-effect module imported below (which
 * this file does) and ALSO by `email-dispatch.ts`, so the separate
 * `email:dispatch` process renders the code instead of an empty body.
 */
import { log } from "../../../lib/logging/logger";
import {
  CUSTOMER_OTP_TEMPLATE_KEY,
  CUSTOMER_OTP_TEMPLATE_VARIABLES,
  SUBJECT_OTP_TEMPLATE_KEY
} from "../domain/email-template-categories";
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

export { CUSTOMER_OTP_TEMPLATE_KEY, CUSTOMER_OTP_TEMPLATE_VARIABLES };

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

/**
 * The default template of the data-subject code (Issue #529): the subject and
 * body name what the code authorises, so the shopper can tell it from a sign-in
 * code before typing it.
 */
export const SUBJECT_OTP_DEFAULT_TEMPLATE = {
  name: "Customer data request code",
  subject: {
    en: "Confirm your data request: {{action}}",
    id: "Konfirmasi permintaan data Anda: {{action}}"
  },
  textBody: {
    en: "Someone asked to {{action}} for your account. Your confirmation code is {{code}}. It expires in {{expiresInMinutes}} minutes.\n\nIf this was not you, do not share the code: ignore this message and sign out of your account.\n\n{{storeName}}",
    id: "Ada permintaan untuk {{action}} pada akun Anda. Kode konfirmasi Anda adalah {{code}}. Kode ini kedaluwarsa dalam {{expiresInMinutes}} menit.\n\nJika ini bukan Anda, jangan bagikan kode ini: abaikan pesan ini dan keluar dari akun Anda.\n\n{{storeName}}"
  }
} as const;

const SUBJECT_ACTION_PHRASE = {
  subject_export: {
    en: "download a copy of your data",
    id: "mengunduh salinan data Anda"
  },
  subject_erasure: {
    en: "permanently erase your account and personal data",
    id: "menghapus akun dan data pribadi Anda secara permanen"
  }
} as const;

const SEED_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

/** Returns `true` when a template row now exists (seeded here or already present). */
export async function ensureCustomerOtpTemplate(
  tx: Bun.SQL,
  tenantId: string,
  templateKey: string = CUSTOMER_OTP_TEMPLATE_KEY
): Promise<boolean> {
  const def =
    templateKey === SUBJECT_OTP_TEMPLATE_KEY
      ? SUBJECT_OTP_DEFAULT_TEMPLATE
      : CUSTOMER_OTP_DEFAULT_TEMPLATE;
  const existing = await fetchActiveEmailTemplateByKey(
    tx,
    tenantId,
    templateKey
  );
  if (existing) return true;

  // Through the email module's own seeder — `awcms_email_templates` is that
  // module's table and `modules:table-writes:check` keeps it so.
  const template: DefaultEmailTemplate = {
    templateKey,
    name: def.name,
    subjectTemplate: { ...def.subject },
    textBodyTemplate: { ...def.textBody }
  };
  await seedDefaultEmailTemplates(tx, tenantId, SEED_ACTOR_ID, [template]);

  return (
    (await fetchActiveEmailTemplateByKey(tx, tenantId, templateKey)) !== null
  );
}

function isSubjectPurpose(
  purpose: CustomerOtpChannelRequest["purpose"]
): purpose is keyof typeof SUBJECT_ACTION_PHRASE {
  return purpose === "subject_export" || purpose === "subject_erasure";
}

/** Template variables are one string per locale-less variable, so the purpose phrase carries both languages. */
function buildVariables(
  request: CustomerOtpChannelRequest
): Record<string, string> {
  const variables: Record<string, string> = {
    code: request.code,
    expiresInMinutes: String(request.expiresInMinutes),
    storeName: request.storeName
  };
  if (isSubjectPurpose(request.purpose)) {
    const phrase = SUBJECT_ACTION_PHRASE[request.purpose];
    variables.action = `${phrase.en} / ${phrase.id}`;
  }
  return variables;
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
      // `via: "email"` always carries a non-null `emailNormalized` —
      // `requestCustomerOtp` never resolves this adapter otherwise.
      const emailNormalized = request.emailNormalized!;
      const templateKey = isSubjectPurpose(request.purpose)
        ? SUBJECT_OTP_TEMPLATE_KEY
        : CUSTOMER_OTP_TEMPLATE_KEY;
      const enqueue = () =>
        enqueueDirectAddressEmail(
          tx,
          request.tenantId,
          templateKey,
          emailNormalized,
          buildVariables(request),
          correlationId
        );

      let result = await enqueue();
      if (!result.enqueued) {
        // Either the address is suppressed (respect it — no retry helps) or
        // the tenant has no template yet (seed it, then try once more).
        const seeded = await ensureCustomerOtpTemplate(
          tx,
          request.tenantId,
          templateKey
        );
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
        request.emailNormalized!
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
