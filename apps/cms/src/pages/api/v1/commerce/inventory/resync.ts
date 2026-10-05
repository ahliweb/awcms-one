/**
 * `POST /api/v1/commerce/inventory/resync` - rewrites the stock cache of every
 * drifted unit on one page FROM THE LEDGER (Issue #282, ADR-0038 D7).
 * `commerce.inventory.configure` (high-risk), audited at warning severity.
 *
 * The body is optional and may carry only `{ cursor, limit }` (paging, as the
 * reconciliation read): a stock count can never be supplied, only recomputed.
 * It SETS state, so a repeat changes nothing and it carries no Idempotency-Key.
 * Run it again with the returned `nextCursor` until that is `null`.
 */
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { resyncStockCache } from "../../../../../modules/commerce/application/commerce-inventory-reconciliation";
import {
  INVENTORY_CONFIGURE_GUARD,
  parsePageBody,
  type PageRequest
} from "../../../../../modules/commerce/application/commerce-inventory-http";

export const POST = defineTenantRoute<PageRequest>({
  workClass: "reporting",
  prepare: ({ request }) => parsePageBody(request),
  authorize: INVENTORY_CONFIGURE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const outcome = await resyncStockCache(
      tx,
      tenantId,
      auth.context.tenantUserId,
      prepared.cursor,
      prepared.limit,
      locals.correlationId
    );

    if ("kind" in outcome) {
      return outcome.kind === "invalid_cursor"
        ? fail(400, "VALIDATION_ERROR", "cursor is not valid.")
        : fail(
            409,
            "NOT_LEDGER_MODE",
            "This store still runs on the commerce counter; there is no ledger to resync from."
          );
    }

    return ok(outcome);
  }
});
