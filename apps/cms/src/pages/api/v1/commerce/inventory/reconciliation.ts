/**
 * `GET /api/v1/commerce/inventory/reconciliation` - the stock units whose cache
 * (`stock`) disagrees with `max(0, floor(ledger on-hand))` at the sales location
 * (Issue #282, ADR-0038 D7). `commerce.inventory.read`. One keyset page per call
 * (`?cursor=&limit=`, default 200, at most 500); `nextCursor` is `null` on the
 * last page. `409 NOT_LEDGER_MODE` for a tenant still on the counter.
 */
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { reconcileStockCache } from "../../../../../modules/commerce/application/commerce-inventory-reconciliation";
import {
  INVENTORY_READ_GUARD,
  parsePageQuery,
  type PageRequest
} from "../../../../../modules/commerce/application/commerce-inventory-http";

export const GET = defineTenantRoute<PageRequest>({
  workClass: "reporting",
  prepare: ({ url }) => parsePageQuery(url),
  authorize: INVENTORY_READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const outcome = await reconcileStockCache(
      tx,
      tenantId,
      prepared.cursor,
      prepared.limit
    );

    if ("kind" in outcome) {
      return outcome.kind === "invalid_cursor"
        ? fail(400, "VALIDATION_ERROR", "cursor is not valid.")
        : fail(
            409,
            "NOT_LEDGER_MODE",
            "This store still runs on the commerce counter; there is no ledger to reconcile against."
          );
    }

    return ok(outcome);
  }
});
