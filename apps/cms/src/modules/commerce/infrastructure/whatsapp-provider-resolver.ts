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
