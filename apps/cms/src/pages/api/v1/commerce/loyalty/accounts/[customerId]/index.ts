import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../../modules/commerce/application/commerce-feature-gate";
import {
  fetchLoyaltyAccountForCustomer,
  fetchLoyaltyCustomerById
} from "../../../../../../../modules/commerce/application/loyalty-ledger";
import { parseCustomerIdParam } from "../../../../../../../modules/commerce/application/loyalty-route-support";
import { COMMERCE_LOYALTY_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";

/**
 * `GET /api/v1/commerce/loyalty/accounts/{customerId}` (Issue #289) — one
 * customer's loyalty position: name, masked phone and the PROJECTED balance
 * (0 for a customer who has never earned). An unknown, deleted or
 * other-tenant customer id is the same `404`.
 */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_LOYALTY_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "loyalty"
    );
    if (gate) return gate;

    const customerId = parseCustomerIdParam(params.customerId);
    if (customerId instanceof Response) return customerId;

    const customer = await fetchLoyaltyCustomerById(tx, tenantId, customerId);
    if (!customer)
      return fail(404, "RESOURCE_NOT_FOUND", "Customer not found.");

    const account = await fetchLoyaltyAccountForCustomer(
      tx,
      tenantId,
      customerId
    );
    return ok({
      customerId,
      customerName: customer.name,
      customerPhoneMasked: customer.phoneMasked,
      accountId: account?.id ?? null,
      balance: customer.balance,
      version: account?.version ?? 0
    });
  }
});
