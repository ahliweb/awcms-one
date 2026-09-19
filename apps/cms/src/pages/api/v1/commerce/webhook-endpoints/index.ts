import {
  fail,
  jsonResponse,
  ok
} from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import { recordAuditEvent } from "../../../../../modules/logging/application/audit-log";
import {
  createWebhookEndpoint,
  listWebhookEndpoints,
  type WebhookEndpointProvider
} from "../../../../../modules/commerce/application/webhook-endpoint-directory";
import { COMMERCE_WEBHOOK_ENDPOINTS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_WEBHOOK_ENDPOINTS_ACTIVITY_CODE,
  action: "update"
} as const;

const KNOWN_PROVIDERS = new Set<WebhookEndpointProvider>(["midtrans"]);

/** `GET /api/v1/commerce/webhook-endpoints` — Issue #110. Masked list, never the token. */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: GUARD,
  handler: async ({ tx, tenantId }) =>
    ok({ items: await listWebhookEndpoints(tx, tenantId) })
});

type CreateWebhookEndpointBody = {
  provider: WebhookEndpointProvider;
  label: string | null;
};

/**
 * `POST /api/v1/commerce/webhook-endpoints` (Issue #110, contract #106's
 * D2) — mints a new opaque token for `provider`; the RAW token is returned
 * exactly once, in this response, and never again.
 */
export const POST = defineTenantRoute<CreateWebhookEndpointBody>({
  workClass: "interactive",
  authorize: GUARD,
  prepare: async ({ request }) => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const body = (bodyRead.value ?? {}) as {
      provider?: unknown;
      label?: unknown;
    };

    if (
      typeof body.provider !== "string" ||
      !KNOWN_PROVIDERS.has(body.provider as WebhookEndpointProvider)
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "provider must be one of: midtrans.",
        {},
        [{ field: "provider", message: "provider must be one of: midtrans." }]
      );
    }

    const label =
      typeof body.label === "string" && body.label.trim().length > 0
        ? body.label.trim().slice(0, 100)
        : null;

    return { provider: body.provider as WebhookEndpointProvider, label };
  },
  handler: async ({ tx, tenantId, auth, prepared }) => {
    const { endpoint, token } = await createWebhookEndpoint(
      tx,
      tenantId,
      auth.context.tenantUserId,
      prepared.provider,
      prepared.label
    );

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "commerce",
      action: "webhook_endpoint.created",
      resourceType: "webhook_endpoint",
      resourceId: endpoint.id,
      severity: "warning",
      message: `Commerce webhook endpoint created for provider "${endpoint.provider}".`,
      // The token is NOT here — the audit trail must answer "an endpoint
      // for which provider was minted, by whom" without ever being able to
      // answer "what was its token" (same rule
      // `machine-credential-directory.ts`'s issuance route already states).
      attributes: { provider: endpoint.provider, label: endpoint.label }
    });

    return jsonResponse(
      { success: true, data: { ...endpoint, token }, meta: {} },
      { status: 201, headers: { "cache-control": "private, no-store" } }
    );
  }
});
