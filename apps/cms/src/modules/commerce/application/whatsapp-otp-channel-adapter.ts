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
import {
  enqueueWhatsappMessage,
  isWhatsappChannelAvailable
} from "./whatsapp-enqueue";
import { readWhatsappMode } from "./whatsapp-mode";

function buildVariables(
  request: CustomerOtpChannelRequest
): Record<string, string> {
  return {
    code: request.code,
    expiresInMinutes: String(request.expiresInMinutes),
    storeName: request.storeName
  };
}

/** The real path - enqueues one message inside the SAME transaction as the OTP row: a `awcms_commerce_whatsapp_messages` row in `legacy` mode, a `whatsapp_delivery` queue row (purpose `security`, with an expiry) in `upstream` mode (Issue #392). */
export function createWhatsappCustomerOtpChannel(): CustomerOtpChannel {
  return {
    async sendOtp(
      tx: Bun.SQL,
      request: CustomerOtpChannelRequest
    ): Promise<CustomerOtpChannelResult> {
      // `via: "whatsapp"` always carries a non-null `phoneNormalized` —
      // `requestCustomerOtp` never resolves this adapter otherwise.
      const phoneNormalized = request.phoneNormalized!;

      // `legacy` always enqueues (`enqueued: true`). In `upstream` mode the
      // queue can refuse or suppress; the caller still answers `202` either way
      // (ADR-0016's anti-enumeration rule) and `sent` only reaches the audit row.
      // No `idempotencyKey`: every OTP request is its own message, and a replay
      // onto the previous message would deliver the old code for the new one.
      const result = await enqueueWhatsappMessage(tx, {
        tenantId: request.tenantId,
        toPhone: phoneNormalized,
        templateKey: "commerce.customer_otp",
        variables: buildVariables(request),
        correlationId: request.correlationId
      });

      return { sent: result.enqueued };
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

/**
 * The tenant-aware form (Issue #392): `legacy` asks `COMMERCE_WHATSAPP_ENABLED`
 * exactly as {@link isWhatsappOtpChannelAvailable} does, `upstream` asks the
 * queue's own `WHATSAPP_ENABLED`. `requestCustomerOtp` uses this one, so
 * `via: "whatsapp"` still answers `409 CHANNEL_UNAVAILABLE` BEFORE issuing an OTP
 * row when the tenant's dispatcher would never send it.
 */
export function isWhatsappOtpChannelAvailableForTenant(
  tx: Bun.SQL,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  return isWhatsappChannelAvailable(tx, tenantId, env);
}

/**
 * `log` whenever WhatsApp is disabled or `COMMERCE_WHATSAPP_PROVIDER=log` - same "never selected when a real provider is configured" rule the e-mail channel follows. Callers should check `isWhatsappOtpChannelAvailableForTenant` FIRST (before issuing an OTP row at all); this resolver exists for the case where the caller already knows the channel is available and just needs the concrete adapter for actual delivery.
 *
 * The choice between the two LEGACY adapters is made here, from the environment,
 * before any tenant is known (the route resolves the channel before it resolves
 * the tenant). A tenant in `upstream` mode must not be subject to it: the
 * `COMMERCE_WHATSAPP_*` flags and the legacy `log` adapter belong to the legacy
 * queue, and the `log` adapter logs the code in the clear instead of enqueueing.
 * So the returned channel looks the tenant's mode up at send time and, in
 * `upstream` mode, always takes the real path (which enqueues through the port;
 * the queue's own `WHATSAPP_PROVIDER=log` is the dev/CI equivalent there).
 */
export function resolveWhatsappCustomerOtpChannel(
  env: NodeJS.ProcessEnv = process.env
): CustomerOtpChannel {
  const legacy =
    !isWhatsappChannelEnabled(env) || env.COMMERCE_WHATSAPP_PROVIDER === "log"
      ? createLogWhatsappCustomerOtpChannel()
      : createWhatsappCustomerOtpChannel();
  const upstream = createWhatsappCustomerOtpChannel();

  return {
    async sendOtp(tx, request) {
      return (await readWhatsappMode(tx, request.tenantId)) === "upstream"
        ? upstream.sendOtp(tx, request)
        : legacy.sendOtp(tx, request);
    }
  };
}
