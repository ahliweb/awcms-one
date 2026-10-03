/**
 * `GET /api/v1/commerce/stored-value/accounts/{id}` — one account (Issue #288,
 * ADR-0029): kind, status, projected balance, masked code, expiry. Gated on
 * `commerce.stored_value.read` and the `storedValue` feature. Resolved tenant-
 * scoped: an unknown id and another tenant's id are the same `404` (no BOLA
 * oracle).
 */
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { fetchStoredValueAccount } from "../../../../../../../modules/commerce/application/stored-value-directory";
import { requireStoredValueFeature } from "../../../../../../../modules/commerce/application/stored-value-http";
import { COMMERCE_STORED_VALUE_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";
import { isUuid } from "../../../../../../../modules/commerce/domain/stored-value";

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_STORED_VALUE_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireStoredValueFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Account not found.");
    }
    const account = await fetchStoredValueAccount(tx, tenantId, params.id);
    if (!account) return fail(404, "RESOURCE_NOT_FOUND", "Account not found.");
    return ok(account);
  }
});
