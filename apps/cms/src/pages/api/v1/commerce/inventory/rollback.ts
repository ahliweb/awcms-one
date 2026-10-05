/**
 * `POST /api/v1/commerce/inventory/rollback` - puts the stock authority back on
 * the commerce counter (Issue #282, ADR-0038 D1). `commerce.inventory.configure`
 * (high-risk), audited at warning severity, no body. The stock cache already
 * holds the last ledger-derived counts, so the counter paths resume from them and
 * nothing else is needed. Naturally idempotent: a store already on the counter
 * answers `200 { changed: false }`.
 *
 * There is deliberately no matching "switch to ledger" endpoint: that flip needs
 * the opening movements posted in the same transaction, which is
 * `bun run commerce:inventory:cutover`.
 */
import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { rollbackToCounterMode } from "../../../../../modules/commerce/application/commerce-inventory-reconciliation";
import { INVENTORY_CONFIGURE_GUARD } from "../../../../../modules/commerce/application/commerce-inventory-http";

export const POST = defineTenantRoute({
  workClass: "interactive",
  authorize: INVENTORY_CONFIGURE_GUARD,
  handler: async ({ tx, tenantId, auth, locals }) =>
    ok(
      await rollbackToCounterMode(
        tx,
        tenantId,
        auth.context.tenantUserId,
        locals.correlationId
      )
    )
});
