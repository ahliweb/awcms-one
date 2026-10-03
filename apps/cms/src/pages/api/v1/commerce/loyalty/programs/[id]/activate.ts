import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../../modules/commerce/application/commerce-feature-gate";
import { UUID_PATTERN } from "../../../../../../../modules/commerce/application/loyalty-route-support";
import { activateLoyaltyProgram } from "../../../../../../../modules/commerce/application/loyalty-program-directory";
import { COMMERCE_LOYALTY_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";

/**
 * `POST /api/v1/commerce/loyalty/programs/{id}/activate` (Issue #289) —
 * activates a draft version NOW, closing the version that was open at that
 * instant in the same transaction. A high-risk `manage` action: it changes
 * what every order paid from this moment on earns. Naturally idempotent — a
 * second call finds the version no longer a draft and answers `409`.
 */
const MANAGE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_LOYALTY_ACTIVITY_CODE,
  action: "manage"
} as const;

export const POST = defineTenantRoute({
  workClass: "interactive",
  authorize: MANAGE_GUARD,
  handler: async ({ tx, tenantId, auth, params, now, locals }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "loyalty"
    );
    if (gate) return gate;

    const id = params.id;
    if (!id || !UUID_PATTERN.test(id)) {
      return fail(400, "VALIDATION_ERROR", "id must be a valid uuid.");
    }

    const result = await activateLoyaltyProgram(
      tx,
      tenantId,
      auth.context.tenantUserId,
      id,
      now,
      locals.correlationId
    );
    if (result.kind === "not_found") {
      return fail(404, "RESOURCE_NOT_FOUND", "Loyalty program not found.");
    }
    if (result.kind === "not_draft") {
      return fail(
        409,
        "PROGRAM_NOT_DRAFT",
        "Only a draft program version can be activated."
      );
    }
    return ok({
      program: result.program,
      closedVersion: result.closedVersion
    });
  }
});
