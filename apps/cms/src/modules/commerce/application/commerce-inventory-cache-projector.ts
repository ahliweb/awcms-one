/**
 * The stock-cache projector (Issue #282, ADR-0038 D4): keeps the write-through
 * cache (`awcms_commerce_products.stock` / `…_product_variants.stock`) true when
 * a movement is posted by something other than commerce - a procurement receipt,
 * an inventory adjustment, a transfer, a reversal.
 *
 * Declared in `commerce/module.ts` `domainEventConsumers` (ADR-0134) on
 * `awcms.inventory.movement.posted` as `commerce.inventory_stock_cache_projector`.
 *
 * ## It never trusts the payload's order
 *
 * Events are at-least-once and a consumer may see two movements of one balance
 * out of order, so the handler does NOT apply `balanceAfter` from the payload. It
 * re-reads the CURRENT balance through the port (`getOnHand`) and writes that,
 * which makes every delivery idempotent in effect as well as in bookkeeping
 * (`applyConsumerEffectOnce` additionally keeps a redelivery from re-reading).
 *
 * It acts only for a tenant in `ledger` mode, only for the sales location, and
 * only for an item of the two `commerce.*` item types: a movement at another
 * location (a warehouse) or of another module's item changes nothing here.
 * Commerce's own postings also publish this event; re-reading what the post just
 * wrote is a harmless no-op (`stock IS DISTINCT FROM` guards the UPDATE).
 *
 * It runs as `awcms_worker` (`bun run domain-events:dispatch`), which `sql/947`
 * grants SELECT on the ledger balance and the settings it reads.
 */
import { COMMERCE_INVENTORY_STOCK_CACHE_PROJECTOR_CONSUMER_NAME } from "../domain/commerce-events";
import {
  COMMERCE_STOCK_UNIT_CODE,
  cacheValueFromBalance,
  stockItemTarget
} from "../domain/commerce-inventory";
import {
  commerceInventoryPort,
  readInventoryConfig,
  writeStockCache
} from "./commerce-inventory";

export const INVENTORY_STOCK_CACHE_PROJECTOR_CONSUMER_NAME =
  COMMERCE_INVENTORY_STOCK_CACHE_PROJECTOR_CONSUMER_NAME;

/** Returns whether a cache row was considered (for tests); never throws for an event it does not own. */
export async function projectStockCacheFromMovement(
  tx: Bun.SQL,
  tenantId: string,
  payload: Record<string, unknown>
): Promise<{ considered: boolean }> {
  const { itemType, itemRef, locationId } = payload;
  if (
    typeof itemType !== "string" ||
    typeof itemRef !== "string" ||
    typeof locationId !== "string"
  ) {
    return { considered: false };
  }

  const target = stockItemTarget({ itemType, itemRef });
  if (!target) return { considered: false };

  const config = await readInventoryConfig(tx, tenantId);
  if (config.mode !== "ledger" || config.locationId !== locationId) {
    return { considered: false };
  }

  const onHand = await commerceInventoryPort().getOnHand(
    tx,
    tenantId,
    locationId,
    { itemType, itemRef, unitCode: COMMERCE_STOCK_UNIT_CODE }
  );
  await writeStockCache(
    tx,
    tenantId,
    { itemType: itemType as never, itemRef },
    cacheValueFromBalance(onHand)
  );

  return { considered: true };
}
