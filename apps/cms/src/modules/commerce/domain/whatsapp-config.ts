/**
 * WhatsApp configuration boundary (Issue #108, contract #106/ADR-0017 D5).
 * Pure — no `process.env` reads here, mirrors `email/domain/email-
 * config.ts`'s own split: the provider resolver and the dispatcher both
 * pass in whatever `env` they were given.
 */

export const KNOWN_WHATSAPP_PROVIDERS = ["fonnte", "meta", "log"] as const;

export type WhatsappProviderKind = (typeof KNOWN_WHATSAPP_PROVIDERS)[number];

export function isKnownWhatsappProvider(
  value: string | undefined
): value is WhatsappProviderKind {
  return (KNOWN_WHATSAPP_PROVIDERS as readonly string[]).includes(value ?? "");
}

export const DEFAULT_WHATSAPP_SEND_TIMEOUT_MS = 10_000;
export const DEFAULT_WHATSAPP_SEND_MAX_RETRIES = 5;

export function resolveWhatsappSendTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.COMMERCE_WHATSAPP_SEND_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_WHATSAPP_SEND_TIMEOUT_MS;
}

export function resolveWhatsappSendMaxRetries(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.COMMERCE_WHATSAPP_SEND_MAX_RETRIES);
  return Number.isFinite(raw) && raw >= 0
    ? raw
    : DEFAULT_WHATSAPP_SEND_MAX_RETRIES;
}

/**
 * Gates CLAIMING in `whatsapp-dispatch.ts`'s `dispatchWhatsappQueue` — the
 * SAME gate `requestCustomerOtp` (`application/customer-auth.ts`) uses to
 * decide whether `via: "whatsapp"` answers `409 CHANNEL_UNAVAILABLE` before
 * a single row is ever enqueued. A deployment with the flag off never
 * touches the provider at all (doc 18's feature-flag rule).
 */
export function isWhatsappChannelEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.COMMERCE_WHATSAPP_ENABLED === "true";
}
