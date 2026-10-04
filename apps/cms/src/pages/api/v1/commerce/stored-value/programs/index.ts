/**
 * `GET /api/v1/commerce/stored-value/programs` — the tenant's gift-card and
 * store-credit program configuration (Issue #288, ADR-0030). Always returns
 * BOTH kinds; one the tenant never saved is reported with its disabled
 * defaults (`configured: false`). Gated on `commerce.stored_value_programs.read`
 * and the tenant's `storedValue` feature (`409 FEATURE_DISABLED` while it is
 * off — it defaults OFF).
 */
import { ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { listStoredValuePrograms } from "../../../../../../modules/commerce/application/stored-value-directory";
import { requireStoredValueFeature } from "../../../../../../modules/commerce/application/stored-value-http";
import { COMMERCE_STORED_VALUE_PROGRAMS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_STORED_VALUE_PROGRAMS_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId }) => {
    const gate = await requireStoredValueFeature(tx, tenantId);
    if (gate) return gate;
    return ok({ items: await listStoredValuePrograms(tx, tenantId) });
  }
});
