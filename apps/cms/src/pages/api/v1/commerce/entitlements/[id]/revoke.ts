import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { revokeEntitlementByAdmin } from "../../../../../../modules/commerce/application/commerce-entitlement-directory";
import { COMMERCE_ENTITLEMENTS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

/**
 * `POST /api/v1/commerce/entitlements/{id}/revoke` (Issue #267, IRMbyDUS) —
 * the only revocation path this module has (`sql/936`'s header: no
 * `refunded` order status/event exists yet to auto-revoke from). Sets
 * `status = 'revoked'`/`revoked_at`; `verifyEntitlement` reflects it on its
 * very next call, no caching anywhere in between.
 */
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_ENTITLEMENTS_ACTIVITY_CODE,
  action: "update"
} as const;

export const POST = defineTenantRoute({
  workClass: "interactive",
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params }) => {
    const entitlementId = params.id;
    if (!entitlementId) return fail(400, "VALIDATION_ERROR", "id is required.");

    const result = await revokeEntitlementByAdmin(
      tx,
      tenantId,
      entitlementId,
      auth.context.tenantUserId
    );

    if (result.kind === "not_found")
      return fail(404, "RESOURCE_NOT_FOUND", "Entitlement not found.");
    if (result.kind === "already_revoked")
      return fail(
        409,
        "ALREADY_REVOKED",
        "This entitlement has already been revoked."
      );

    return ok(result.entitlement);
  }
});
