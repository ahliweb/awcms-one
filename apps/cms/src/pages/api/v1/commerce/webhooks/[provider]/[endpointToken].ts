import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../lib/security/env-thresholds";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { looksLikeWebhookEndpointToken } from "../../../../../../lib/auth/webhook-endpoint-token";
import { parseMidtransWebhookBody } from "../../../../../../modules/commerce/domain/payment-webhook-request";
import { resolvePaymentGatewayProvider } from "../../../../../../modules/commerce/infrastructure/payment-gateway-provider-resolver";
import {
  applyVerifiedWebhookEvent,
  resolveWebhookEndpoint
} from "../../../../../../modules/commerce/application/payment-webhook-intake";

/**
 * `POST /api/v1/commerce/webhooks/{provider}/{endpointToken}` (Issue #113,
 * contract #106's D2/D3) — public, no session, no tenant resolved from
 * Origin/Host (unlike every `/storefront/*` route): the caller is Midtrans's
 * own server, addressing this tenant by an opaque per-tenant token in the
 * PATH. Registered exempt in `lib/security/api-body-auth-boundary.ts` the
 * same way `/api/v1/sync/push` is — a credential OTHER than a session, not
 * "no credential at all".
 *
 * ## Gate order (each step is a hard stop; nothing after it runs otherwise)
 *
 * 1. Body-size-capped JSON read.
 * 2. Resolve `(tenant, provider)` from the token's hash via the SECURITY
 *    DEFINER bootstrap function (`resolveWebhookEndpoint`) — unknown/revoked
 *    token, OR a `{provider}` path segment that does not match what the
 *    token itself resolves to, OR no provider currently configured for this
 *    deployment -> a NEUTRAL 404, after padding the response to a minimum
 *    latency so "token exists but provider mismatch" cannot be timed apart
 *    from "token does not exist at all".
 * 3. `provider.verifyWebhook` — a bad/missing signature is a `401`. This is
 *    the ONLY provider method this route ever calls; `fetchStatus` is the
 *    reconcile job's own concern (`scripts/commerce-payments-reconcile.ts`),
 *    never this route's.
 * 4. `applyVerifiedWebhookEvent` — one `withTenantOrThrow` transaction; a
 *    replay (`ON CONFLICT DO NOTHING` hit zero rows) or a normal apply both
 *    answer `200`, exactly as contract #106 specifies ("always 200 once
 *    verified and processed, or replayed").
 */
const RATE_LIMIT_MAX = parsePositiveIntSetting(
  process.env.COMMERCE_WEBHOOK_RATE_LIMIT_MAX,
  120,
  "COMMERCE_WEBHOOK_RATE_LIMIT_MAX"
);
const RATE_LIMIT_WINDOW_SEC = parsePositiveIntSetting(
  process.env.COMMERCE_WEBHOOK_RATE_LIMIT_WINDOW_SEC,
  60,
  "COMMERCE_WEBHOOK_RATE_LIMIT_WINDOW_SEC"
);

/** Minimum wall-clock time before a NEUTRAL 404 (unknown token, provider mismatch, or gateway not configured) is answered — a floor, not a fixed delay, so a slow DB lookup never LOWERS the latency below this. */
const NEUTRAL_404_MIN_LATENCY_MS = 150;

async function neutralNotFound(startedAtMs: number): Promise<Response> {
  const elapsed = Date.now() - startedAtMs;
  const remaining = NEUTRAL_404_MIN_LATENCY_MS - elapsed;
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  return fail(404, "NOT_FOUND", "Not found.");
}

export const POST: APIRoute = async ({ params, request, clientAddress }) => {
  const startedAtMs = Date.now();

  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:webhooks:${clientIp}`,
    { maxAttempts: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_SEC * 1000 }
  );
  if (!rateLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many requests. Try again later.",
      {},
      undefined,
      {
        "retry-after": String(rateLimit.retryAfterSec)
      }
    );
  }

  const pathProvider = params.provider;
  const endpointToken = params.endpointToken;
  if (
    !pathProvider ||
    !endpointToken ||
    !looksLikeWebhookEndpointToken(endpointToken)
  ) {
    return neutralNotFound(startedAtMs);
  }

  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

  const sql = getDatabaseClient();

  const resolved = await resolveWebhookEndpoint(sql, endpointToken);
  if (!resolved || resolved.provider !== pathProvider) {
    return neutralNotFound(startedAtMs);
  }

  const providerKey = resolved.provider;
  if (providerKey !== "midtrans" && providerKey !== "log") {
    return neutralNotFound(startedAtMs);
  }

  const provider = resolvePaymentGatewayProvider();
  if (!provider) {
    // Configured provider is not this deployment's active one (or none is
    // configured at all) — same neutral answer as an unknown token.
    return neutralNotFound(startedAtMs);
  }

  if (bodyRead.malformed || bodyRead.value === null) {
    return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }

  const webhookInput = parseMidtransWebhookBody(bodyRead.value);
  if (!webhookInput) {
    return fail(400, "VALIDATION_ERROR", "Malformed webhook payload.");
  }

  const verifyResult = await provider.verifyWebhook(webhookInput);
  if (!verifyResult.ok) {
    return fail(
      401,
      "INVALID_SIGNATURE",
      "Webhook signature verification failed."
    );
  }

  const result = await applyVerifiedWebhookEvent(sql, resolved.tenantId, {
    provider: providerKey,
    eventKey: verifyResult.eventKey,
    providerRef: verifyResult.providerRef,
    status: verifyResult.status,
    grossAmount: webhookInput.grossAmount,
    payload: bodyRead.value
  });

  return ok({ outcome: result.kind });
};

/** POST-only — no OPTIONS/GET/etc.: this route is a server-to-server callback, not a browser-CORS surface (unlike every `/storefront/*` route). */
