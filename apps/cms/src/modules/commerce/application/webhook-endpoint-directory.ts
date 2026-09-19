/**
 * `awcms_commerce_webhook_endpoints` persistence — Issue #110 (contract
 * #106's D2). Owner-side lifecycle only (list/create/revoke); the SECURITY
 * DEFINER lookup the public webhook INTAKE route (#113) will call is
 * `awcms_resolve_commerce_webhook_endpoint` (`sql/926`), never this file.
 *
 * Same secret discipline `identity-access/application/machine-credential-
 * directory.ts` already established: the plaintext token is minted and
 * returned to the caller EXACTLY ONCE and is never persisted — only its
 * SHA-256 hash reaches the database, and no projection here ever selects
 * `token_hash` back out.
 */
import {
  generateWebhookEndpointToken,
  hashWebhookEndpointToken
} from "../../../lib/auth/webhook-endpoint-token";

export type WebhookEndpointProvider = "midtrans";

export type WebhookEndpointSummary = {
  id: string;
  provider: WebhookEndpointProvider;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
};

type WebhookEndpointRow = {
  id: string;
  provider: string;
  label: string | null;
  created_at: Date;
  revoked_at: Date | null;
};

function toSummary(row: WebhookEndpointRow): WebhookEndpointSummary {
  return {
    id: row.id,
    provider: row.provider as WebhookEndpointProvider,
    label: row.label,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null
  };
}

/**
 * `GET /api/v1/commerce/webhook-endpoints` — every endpoint this tenant has
 * ever minted, including revoked ones (an operator auditing a leak needs to
 * see what was revoked and when, not just what is live). No `token_hash` in
 * this projection, ever.
 */
export async function listWebhookEndpoints(
  tx: Bun.SQL,
  tenantId: string
): Promise<WebhookEndpointSummary[]> {
  const rows = (await tx`
    SELECT id, provider, label, created_at, revoked_at
    FROM awcms_commerce_webhook_endpoints
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC
    LIMIT 200
  `) as WebhookEndpointRow[];

  return rows.map(toSummary);
}

/**
 * Mints a new endpoint token for `provider`. `token` is returned exactly
 * once, in this function's own return value, and is not stored — only its
 * hash is. Deliberately NOT idempotency-keyed, for the identical reason
 * `identity-access/application/machine-credential-directory.ts`'s
 * `issueMachineCredential` gives for the same choice: replaying this
 * mutation would mean persisting the plaintext token in
 * `awcms_idempotency_keys` so it could be handed out again — a secret
 * stored in a table designed for request bookkeeping. A duplicate submit
 * instead mints a second, independently revocable endpoint, which the list
 * above makes trivially visible.
 */
export async function createWebhookEndpoint(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  provider: WebhookEndpointProvider,
  label: string | null
): Promise<{ endpoint: WebhookEndpointSummary; token: string }> {
  const token = generateWebhookEndpointToken();
  const tokenHash = hashWebhookEndpointToken(token);

  const rows = (await tx`
    INSERT INTO awcms_commerce_webhook_endpoints (
      tenant_id, provider, token_hash, label, created_by
    )
    VALUES (${tenantId}, ${provider}, ${tokenHash}, ${label}, ${actorTenantUserId})
    RETURNING id, provider, label, created_at, revoked_at
  `) as WebhookEndpointRow[];

  return { endpoint: toSummary(rows[0]!), token };
}

export type RevokeWebhookEndpointOutcome =
  | { outcome: "revoked"; endpoint: WebhookEndpointSummary }
  | { outcome: "not_found" };

/** `DELETE /api/v1/commerce/webhook-endpoints/{id}` — idempotent per the contract: revoking an already-revoked (but still-existing, this tenant's own) endpoint still answers as revoked. */
export async function revokeWebhookEndpoint(
  tx: Bun.SQL,
  tenantId: string,
  endpointId: string
): Promise<RevokeWebhookEndpointOutcome> {
  const rows = (await tx`
    UPDATE awcms_commerce_webhook_endpoints
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE tenant_id = ${tenantId} AND id = ${endpointId}
    RETURNING id, provider, label, created_at, revoked_at
  `) as WebhookEndpointRow[];

  const row = rows[0];
  if (!row) return { outcome: "not_found" };
  return { outcome: "revoked", endpoint: toSummary(row) };
}
