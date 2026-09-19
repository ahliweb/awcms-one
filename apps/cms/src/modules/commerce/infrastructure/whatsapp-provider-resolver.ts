/**
 * Production resolver (Issue #108) — mirrors `email/infrastructure/email-
 * provider-resolver.ts`: picks the concrete `WhatsappProvider` from
 * configuration, degrading to a clean failed-result provider on
 * misconfiguration rather than throwing (one misconfigured deployment must
 * not crash the dispatcher).
 */
import {
  isKnownWhatsappProvider,
  resolveWhatsappSendTimeoutMs
} from "../domain/whatsapp-config";
import type { WhatsappProvider } from "../domain/whatsapp-provider";
import { createFonnteWhatsappProvider } from "./fonnte-provider";
import { createLogWhatsappProvider } from "./log-whatsapp-provider";
import { createMetaWhatsappProvider } from "./meta-whatsapp-provider";

function createMisconfiguredProvider(reason: string): WhatsappProvider {
  return {
    async send() {
      return { ok: false, error: reason, retryable: false };
    },
    async healthCheck() {
      return { ok: false, error: reason };
    }
  };
}

export function resolveWhatsappProvider(
  env: NodeJS.ProcessEnv = process.env
): WhatsappProvider {
  const provider = env.COMMERCE_WHATSAPP_PROVIDER;

  if (!isKnownWhatsappProvider(provider)) {
    return createMisconfiguredProvider(
      "COMMERCE_WHATSAPP_PROVIDER is missing or not a known provider."
    );
  }

  if (provider === "log") {
    return createLogWhatsappProvider();
  }

  const timeoutMs = resolveWhatsappSendTimeoutMs(env);

  if (provider === "fonnte") {
    const token = env.COMMERCE_FONNTE_TOKEN;

    if (!token) {
      return createMisconfiguredProvider(
        "Fonnte is not configured (requires COMMERCE_FONNTE_TOKEN)."
      );
    }

    return createFonnteWhatsappProvider({
      token,
      baseUrl: env.COMMERCE_FONNTE_API_BASE_URL,
      timeoutMs
    });
  }

  // provider === "meta"
  const token = env.COMMERCE_META_WA_TOKEN;
  const phoneNumberId = env.COMMERCE_META_WA_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    return createMisconfiguredProvider(
      "Meta WhatsApp Cloud API is not configured (requires " +
        "COMMERCE_META_WA_TOKEN, COMMERCE_META_WA_PHONE_NUMBER_ID)."
    );
  }

  return createMetaWhatsappProvider({
    token,
    phoneNumberId,
    otpTemplateName: env.COMMERCE_META_WA_OTP_TEMPLATE,
    baseUrl: env.COMMERCE_META_WA_API_BASE_URL,
    timeoutMs
  });
}

/**
 * Issue #118 — `store-settings-directory.ts`'s `toPublicRecord`'s own
 * `whatsappOtpEnabled` derivation, mirroring
 * `payment-gateway-provider-resolver.ts`'s `isPaymentGatewayProviderConfigured`
 * exactly: `true` only for a genuinely USABLE provider (Fonnte with its
 * token, or Meta with both its token and phone-number id) — never merely
 * "a `COMMERCE_WHATSAPP_PROVIDER` value is set". `log` counts as configured
 * OUTSIDE production only, the same "an operator's forgotten dev setting
 * must never look live in production" rule the payment-gateway resolver's
 * own header states for its own `log` adapter. This does NOT change
 * `resolveWhatsappProvider`'s own dispatch behaviour (which never refused
 * `log` in production) — the WhatsApp OTP channel already had its own `log`
 * fallback selection rule (`customer-otp-channel-adapters.ts`, keyed on
 * `EMAIL_PROVIDER`/`EMAIL_ENABLED`, not on this function) before this issue;
 * this function is ONLY the public-facing "is OTP-via-WhatsApp usable at
 * all" signal.
 */
export function isWhatsappProviderConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const provider = env.COMMERCE_WHATSAPP_PROVIDER;

  if (provider === "log") {
    return env.NODE_ENV !== "production";
  }
  if (provider === "fonnte") {
    return Boolean(env.COMMERCE_FONNTE_TOKEN);
  }
  if (provider === "meta") {
    return Boolean(
      env.COMMERCE_META_WA_TOKEN && env.COMMERCE_META_WA_PHONE_NUMBER_ID
    );
  }
  return false;
}
