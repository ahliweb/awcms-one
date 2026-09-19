/**
 * Log/fake `WhatsappProvider` (Issue #108) — `COMMERCE_WHATSAPP_PROVIDER=log`.
 * Writes a structured log line instead of calling a real provider; always
 * succeeds. Mirrors `email/infrastructure/log-email-provider.ts` exactly,
 * including its one deliberate exception: this is the ONLY adapter in the
 * whole WhatsApp surface that ever logs the OTP code in the clear, and it is
 * never selected when a real provider (`fonnte`/`meta`) is configured
 * (`whatsapp-provider-resolver.ts`). The recipient phone is always masked
 * (`domain/phone-normalisation.ts#maskPhone`).
 */
import { log } from "../../../lib/logging/logger";
import { maskPhone } from "../domain/phone-normalisation";
import type {
  WhatsappDeliveryResult,
  WhatsappHealthCheckResult,
  WhatsappMessage,
  WhatsappProvider
} from "../domain/whatsapp-provider";

export function createLogWhatsappProvider(): WhatsappProvider {
  return {
    async send(message: WhatsappMessage): Promise<WhatsappDeliveryResult> {
      log("info", "commerce.whatsapp.log_provider.send", {
        to: maskPhone(message.toPhone),
        templateKey: message.templateKey,
        // The ONE place in this codebase that logs an OTP code in the
        // clear — there is no other way for a developer without real
        // WhatsApp credentials (or a CI suite) to learn what code was
        // issued.
        otpCode: message.otpCode,
        correlationId: message.correlationId
      });

      return { ok: true, providerMessageId: `log:${crypto.randomUUID()}` };
    },

    async healthCheck(): Promise<WhatsappHealthCheckResult> {
      return { ok: true };
    }
  };
}
