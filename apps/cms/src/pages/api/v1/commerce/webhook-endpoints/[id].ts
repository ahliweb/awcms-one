import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { recordAuditEvent } from "../../../../../modules/logging/application/audit-log";
import { revokeWebhookEndpoint } from "../../../../../modules/commerce/application/webhook-endpoint-directory";
import { COMMERCE_WEBHOOK_ENDPOINTS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `DELETE /api/v1/commerce/webhook-endpoints/{id}` (Issue #110) — revoke, the
 * fastest available rotation path if a webhook URL leaks. `200 {endpoint}`,
 * idempotent: revoking an already-revoked (but still-existing, this
 * tenant's own) endpoint still answers `200` with the same (already
 * revoked) row — an operator racing to shut down a leak must never be
 * blocked by "already done" ambiguity the way `machine-credentials/{id}/
 * revoke`'s own `409` deliberately IS for that different (POST, not
 * DELETE) shape. `ok(...)` rather than a bare `204` so this route works
 * with the shared `mutateAndReload` admin-form-client helper, matching
 * every other DELETE route in this module (e.g. `vouchers/[id].ts`).
 */
export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_WEBHOOK_ENDPOINTS_ACTIVITY_CODE,
    action: "update"
  },
  handler: async ({ tx, tenantId, params, auth }) => {
    const endpointId = params.id ?? "";
    if (!UUID_PATTERN.test(endpointId)) {
      return fail(404, "NOT_FOUND", "No such webhook endpoint.");
    }

    const result = await revokeWebhookEndpoint(tx, tenantId, endpointId);

    if (result.outcome === "not_found") {
      return fail(404, "NOT_FOUND", "No such webhook endpoint.");
    }

    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId: auth.context.tenantUserId,
      moduleKey: "commerce",
      action: "webhook_endpoint.revoked",
      resourceType: "webhook_endpoint",
      resourceId: result.endpoint.id,
      severity: "warning",
      message: `Commerce webhook endpoint revoked for provider "${result.endpoint.provider}".`,
      attributes: { provider: result.endpoint.provider }
    });

    return ok({ endpoint: result.endpoint });
  }
});
