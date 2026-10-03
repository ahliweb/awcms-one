import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import type { KeysetCursor } from "../../../../../../../modules/_shared/keyset-pagination";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../../modules/commerce/application/commerce-feature-gate";
import {
  fetchLoyaltyAccountForCustomer,
  fetchLoyaltyCustomerById,
  LOYALTY_LEDGER_DEFAULT_LIMIT,
  LOYALTY_LEDGER_MAX_LIMIT,
  listLedgerForAccount
} from "../../../../../../../modules/commerce/application/loyalty-ledger";
import {
  parseCustomerIdParam,
  parsePageParams
} from "../../../../../../../modules/commerce/application/loyalty-route-support";
import { COMMERCE_LOYALTY_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";

/**
 * `GET /api/v1/commerce/loyalty/accounts/{customerId}/ledger` (Issue #289) —
 * the customer's append-only point history, newest first, keyset-paginated.
 * Staff view: carries the actor and reason that the customer-facing history
 * deliberately omits.
 */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_LOYALTY_ACTIVITY_CODE,
  action: "read"
} as const;

type Prepared = { cursor: KeysetCursor | null; limit: number };

export const GET = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: ({ url }): Prepared | Response =>
    parsePageParams(
      url,
      LOYALTY_LEDGER_DEFAULT_LIMIT,
      LOYALTY_LEDGER_MAX_LIMIT
    ),
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params, prepared }) => {
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
    if (!account) return ok({ items: [], nextCursor: null });

    return ok(
      await listLedgerForAccount(
        tx,
        tenantId,
        account.id,
        prepared.cursor,
        prepared.limit
      )
    );
  }
});
