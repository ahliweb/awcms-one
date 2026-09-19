/**
 * Commerce webhook-endpoint token format (Issue #110, contract #106's D2).
 *
 * ```
 * awcmswh_<43 chars base64url secret>
 * ```
 *
 * Unlike `machine-credential-token.ts`'s token, this one does NOT embed its
 * tenant: the whole point of `awcms_resolve_commerce_webhook_endpoint`
 * (`sql/926`) is to discover `(tenant_id, provider)` from the token's HASH
 * alone, before any tenant context exists — a provider's own webhook URL
 * (`.../webhooks/midtrans/{token}`) carries no other identifying
 * information, so the token itself must be the sole address.
 *
 * Only the SHA-256 of the full token is ever persisted, exactly the same
 * one-way construction `machine-credential-token.ts` uses for its own secret
 * — the plaintext is generated, shown to the owner exactly once, and never
 * stored anywhere.
 */
import { createHash, randomBytes } from "node:crypto";

export const WEBHOOK_ENDPOINT_TOKEN_PREFIX = "awcmswh_";

const SECRET_BYTES = 32;

export function generateWebhookEndpointToken(): string {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return `${WEBHOOK_ENDPOINT_TOKEN_PREFIX}${secret}`;
}

export function hashWebhookEndpointToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function looksLikeWebhookEndpointToken(token: string): boolean {
  return (
    token.startsWith(WEBHOOK_ENDPOINT_TOKEN_PREFIX) &&
    token.length > WEBHOOK_ENDPOINT_TOKEN_PREFIX.length
  );
}
