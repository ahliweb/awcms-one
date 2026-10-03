import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../modules/commerce/application/commerce-feature-gate";
import { reconcileLoyaltyForTenant } from "../../../../../modules/commerce/application/loyalty-ledger";
import { COMMERCE_LOYALTY_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

/**
 * `POST /api/v1/commerce/loyalty/reconcile` (Issue #289) — recomputes every
 * account's balance from the ledger and reports drift. `{ "repair": true }`
 * additionally rewrites each drifted account's PROJECTION (never the ledger),
 * one audit event per repair. Both modes are a high-risk `manage` action: it
 * scans the whole tenant ledger, and repair mutates balances. Idempotent by
 * nature — a second run finds nothing left to repair.
 */
const MANAGE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_LOYALTY_ACTIVITY_CODE,
  action: "manage"
} as const;

export const POST = defineTenantRoute<{ repair: boolean }>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<{ repair: boolean } | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const body = bodyRead.value ?? {};
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return fail(400, "VALIDATION_ERROR", "Request body must be an object.");
    }
    const repair = (body as Record<string, unknown>).repair;
    if (repair !== undefined && typeof repair !== "boolean") {
      return fail(400, "VALIDATION_ERROR", "repair must be a boolean.", {}, [
        { field: "repair", message: "repair must be a boolean." }
      ]);
    }
    return { repair: repair === true };
  },
  authorize: MANAGE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "loyalty"
    );
    if (gate) return gate;

    return ok(
      await reconcileLoyaltyForTenant(tx, tenantId, {
        repair: prepared.repair,
        actorTenantUserId: auth.context.tenantUserId,
        correlationId: locals.correlationId
      })
    );
  }
});
