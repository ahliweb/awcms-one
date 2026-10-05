/**
 * `GET /api/v1/commerce/inventory` - which stock authority the tenant runs on
 * (Issue #282, ADR-0038 D1): `counter` (the default) or `ledger`, with the sales
 * location the ledger is posted at. `commerce.inventory.read`. Read-only: the
 * flip to `ledger` is `bun run commerce:inventory:cutover`, and the way back is
 * `POST .../inventory/rollback`.
 */
import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { readInventoryConfig } from "../../../../../modules/commerce/application/commerce-inventory";
import { INVENTORY_READ_GUARD } from "../../../../../modules/commerce/application/commerce-inventory-http";

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: INVENTORY_READ_GUARD,
  handler: async ({ tx, tenantId }) => {
    const config = await readInventoryConfig(tx, tenantId);

    return ok({
      mode: config.mode,
      locationId: config.mode === "ledger" ? config.locationId : null,
      changedAt: config.changedAt ? config.changedAt.toISOString() : null
    });
  }
});
