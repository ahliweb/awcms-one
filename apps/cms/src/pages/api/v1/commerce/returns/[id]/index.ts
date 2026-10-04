/**
 * `GET /api/v1/commerce/returns/{id}` - one return with its lines, refund
 * legs and compensations (Issue #287, ADR-0033). `commerce.returns.read` and
 * the `returns` feature. An unknown id and another tenant's id are the same
 * `404`.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { requireReturnsFeature } from "../../../../../../modules/commerce/application/return-http";
import { fetchReturn } from "../../../../../../modules/commerce/application/return-records";
import { COMMERCE_RETURNS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import { isUuid } from "../../../../../../modules/commerce/domain/stored-value";

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_RETURNS_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireReturnsFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Return not found.");
    }
    const record = await fetchReturn(tx, tenantId, params.id);
    if (!record) return fail(404, "RESOURCE_NOT_FOUND", "Return not found.");
    return ok({ return: record });
  }
});
