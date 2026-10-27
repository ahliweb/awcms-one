import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../modules/commerce/application/commerce-feature-gate";
import { fetchCustomerPushDiagnostics } from "../../../../../modules/commerce/application/customer-push-diagnostics";
import { COMMERCE_CUSTOMER_PUSH_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/customer-push-permissions";

/**
 * `GET /api/v1/commerce/customer-push/diagnostics` (Issue #430, ADR-0048 Q10) -
 * staff, `commerce.customer_push.read`. AGGREGATE counts only: devices by
 * status, messages by status and by purpose, preferences by purpose. Never an
 * endpoint (masked or not), a device or customer id, a token or a message text.
 * "sent" means only that the push service accepted the request; no figure is
 * called "delivered" (ADR-0048 I8). Behind the `customerPush` feature: off is a
 * `409 FEATURE_DISABLED`, the owner-route convention.
 */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CUSTOMER_PUSH_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "customerPush"
    );
    if (gate) return gate;

    return ok(await fetchCustomerPushDiagnostics(tx, tenantId));
  }
});
