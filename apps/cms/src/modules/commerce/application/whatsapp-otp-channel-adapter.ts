/**
 * `whatsapp` `CustomerOtpChannel` adapter (Issue #108, contract
 * #106/ADR-0017 D5) — the third channel `domain/customer-otp-channel.ts`
 * documents. Mirrors `customer-otp-channel-adapters.ts`'s `email` shape:
 * `createWhatsappCustomerOtpChannel` enqueues into
 * `awcms_commerce_whatsapp_messages` inside the SAME transaction as the OTP
 * row (`whatsapp-enqueue.ts#enqueueWhatsappMessage`); `createLogWhatsapp
 * CustomerOtpChannel` writes a structured log line instead (dev/CI, no
 * WhatsApp credentials needed) and is the ONLY place in this file that logs
 * the code in the clear.
 *
 * `resolveWhatsappCustomerOtpChannel` and `isWhatsappOtpChannelAvailable`
 * share ONE gate — `COMMERCE_WHATSAPP_ENABLED === "true"` — because that is
 * exactly the condition `dispatchWhatsappQueue` itself uses to decide
 * whether to claim anything at all. `otp/request`'s `via: "whatsapp"`
 * therefore answers `409 CHANNEL_UNAVAILABLE` the moment the flag is off,
 * BEFORE issuing an OTP row or calling this file at all — a configuration
 * fact, not an e-mail/phone existence oracle (ADR-0017 D5's own framing).
 */
import { log } from "../../../lib/logging/logger";
import { maskPhone } from "../domain/phone-normalisation";
import type {
  CustomerOtpChannel,
  CustomerOtpChannelRequest,
  CustomerOtpChannelResult
} from "../domain/customer-otp-channel";
import { isWhatsappChannelEnabled } from "../domain/whatsapp-config";
import { enqueueWhatsappMessage } from "./whatsapp-enqueue";

function buildVariables(
  request: CustomerOtpChannelRequest
): Record<string, string> {
  return {
    code: request.code,
    expiresInMinutes: String(request.expiresInMinutes),
    storeName: request.storeName
  };
}

/** The real path — enqueues one `awcms_commerce_whatsapp_messages` row inside the SAME transaction as the OTP row. */
export function createWhatsappCustomerOtpChannel(): CustomerOtpChannel {
  return {
    async sendOtp(
      tx: Bun.SQL,
      request: CustomerOtpChannelRequest
    ): Promise<CustomerOtpChannelResult> {
      // `via: "whatsapp"` always carries a non-null `phoneNormalized` —
      // `requestCustomerOtp` never resolves this adapter otherwise.
      const phoneNormalized = request.phoneNormalized!;

      await enqueueWhatsappMessage(tx, {
        tenantId: request.tenantId,
        toPhone: phoneNormalized,
        templateKey: "commerce.customer_otp",
        variables: buildVariables(request),
        correlationId: request.correlationId
      });

      return { sent: true };
    }
  };
}

/** Dev/CI path — writes a structured log line instead of touching the outbox. */
export function createLogWhatsappCustomerOtpChannel(): CustomerOtpChannel {
  return {
    async sendOtp(
      _tx: Bun.SQL,
      request: CustomerOtpChannelRequest
    ): Promise<CustomerOtpChannelResult> {
      log("info", "commerce.customer_otp.log_whatsapp_channel.send", {
        to: maskPhone(request.phoneNormalized!),
        purpose: request.purpose,
        otpCode: request.code,
        expiresInMinutes: request.expiresInMinutes,
        correlationId: request.correlationId
      });

      return { sent: true };
    }
  };
}

export function isWhatsappOtpChannelAvailable(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return isWhatsappChannelEnabled(env);
}

/** `log` whenever WhatsApp is disabled or `COMMERCE_WHATSAPP_PROVIDER=log` — same "never selected when a real provider is configured" rule the e-mail channel follows. Callers should check `isWhatsappOtpChannelAvailable` FIRST (before issuing an OTP row at all); this resolver exists for the case where the caller already knows the channel is available and just needs the concrete adapter for actual delivery. */
export function resolveWhatsappCustomerOtpChannel(
  env: NodeJS.ProcessEnv = process.env
): CustomerOtpChannel {
  if (
    !isWhatsappChannelEnabled(env) ||
    env.COMMERCE_WHATSAPP_PROVIDER === "log"
  ) {
    return createLogWhatsappCustomerOtpChannel();
  }
  return createWhatsappCustomerOtpChannel();
}
