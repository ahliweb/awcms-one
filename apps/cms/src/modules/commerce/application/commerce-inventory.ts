/**
 * Commerce's adapter over the upstream `inventory` ledger (Issue #282,
 * ADR-0038). The ONE file in `commerce` that knows the ledger exists: every
 * stock write site (order creation, POS, cancel/expiry restock, return restock)
 * and every guard on an admin stock edit asks THIS file what to do, so a tenant
 * that has not cut over (`counter` mode, the default) keeps today's behaviour
 * and a tenant that has (`ledger` mode) never touches a counter directly.
 *
 * ## What `ledger` mode means
 *
 *   * The ledger is AUTHORITATIVE. A sale posts `sale`, a cancel/expiry restock
 *     posts `sale_return`, a return's restock posts `sale_return`, all through
 *     `InventoryLedgerPort`, inside the caller's tenant transaction, so "move the
 *     stock" and "write the order" commit or roll back together.
 *   * `awcms_commerce_products.stock` / `…_product_variants.stock` become a
 *     WRITE-THROUGH CACHE: after each successful post the row is set to
 *     `GREATEST(0, floor(on_hand))` at the sales location (D3). Every existing
 *     reader (storefront, cart quote, POS, barcodes, admin lists) keeps reading
 *     `stock` unchanged. The cache never guards overselling; the ledger does.
 *   * A movement the ledger takes from elsewhere (a receipt, an adjustment, a
 *     transfer) reaches the cache through the `awcms.inventory.movement.posted`
 *     consumer in `application/commerce-inventory-cache-projector.ts` (D4).
 *
 * ## The mode is read under a shared advisory lock
 *
 * `resolveInventoryConfig` takes `pg_advisory_xact_lock_shared` BEFORE reading
 * the mode, and the cut-over and the rollback take the EXCLUSIVE lock before they
 * change it. So an order that read `counter` finishes decrementing the counter
 * before the cut-over snapshots the counters, and an order that starts while the
 * cut-over runs waits, then reads `ledger`. Without it a counter-mode order could
 * decrement after the opening was posted and the cache would be wrong forever.
 * The lock is per tenant and shared, so orders never wait for one another.
 *
 * ## Authorization and audit stay where commerce already does them
 *
 * The adapter performs no access check (port doc). Order creation is the
 * anonymous storefront path, the POS path is gated by `commerce.pos.*`, and the
 * status changes are gated by their own routes; none of that moves. The caller's
 * `correlationId` is passed on every movement so the ledger row and the commerce
 * audit row join.
 *
 * ## The composition seam
 *
 * `commerceInventoryPort()` is the single place this module names the
 * in-process adapter, and it does so lazily: `domain_event_runtime`'s consumer
 * registry imports the cache projector, and the adapter's own import chain
 * reaches that registry, so a top-level reference would read a binding that is
 * not initialised yet (the same inert cycle `loyalty-ledger.ts` documents).
 */
import type {
  InventoryLedgerPort,
  InventoryPostOutcome
} from "../../_shared/ports/inventory-ledger-port";
import { inventoryLedgerPortAdapter } from "../../inventory/application/inventory-ledger-port-adapter";
import type { CartQuoteResult } from "../domain/cart-quote";
import {
  COMMERCE_ORDER_RESTOCK_SOURCE_TYPE,
  COMMERCE_ORDER_SOURCE_TYPE,
  COMMERCE_RETURN_SOURCE_TYPE,
  COMMERCE_STOCK_UNIT_CODE,
  STOCK_MANAGED_BY_INVENTORY_MESSAGE,
  cacheValueFromBalance,
  describeRefusal,
  quantityText,
  sortForPosting,
  stockItemFor,
  stockItemTarget,
  stockWriteRefused,
  type InventoryMode,
  type LedgerRefusalKind,
  type StockItem
} from "../domain/commerce-inventory";

export type InventoryConfig =
  { mode: "counter" } | { mode: "ledger"; locationId: string };

/**
 * Runs a stock-moving unit of work. In `counter` mode it is a plain call; in
 * `ledger` mode it runs inside a SAVEPOINT, so a ledger refusal (thrown as
 * {@link InventoryLedgerRefusedError}) rolls back everything the unit wrote -
 * order rows, status changes, return rows - and leaves the transaction clean.
 * That is what makes it safe for a route to catch the error and return a 4xx:
 * `defineTenantRoute` commits a normal return, and nothing is left to commit.
 */
export async function withInventorySavepoint<T>(
  tx: Bun.SQL,
  config: InventoryConfig,
  work: (db: Bun.SQL) => Promise<T>
): Promise<T> {
  if (config.mode === "counter") return work(tx);

  return (tx as Bun.TransactionSQL).savepoint((sp) => work(sp));
}

/** The in-process `InventoryLedgerPort`, resolved at call time (see the header). */
export function commerceInventoryPort(): InventoryLedgerPort {
  return inventoryLedgerPortAdapter;
}

/** A ledger refusal inside a commerce write: throw it, and the tenant transaction (or the savepoint) rolls back. */
export class InventoryLedgerRefusedError extends Error {
  readonly kind: LedgerRefusalKind;
  readonly item: StockItem;
  readonly locationId: string;
  /** Present for `insufficient_stock`: the balance the ledger holds. */
  readonly onHand: string | null;
  /** The cart quote the refused write was built from; set by `createOrderFromCart` so it can still answer `cart_changed`. */
  quote?: CartQuoteResult;

  constructor(
    kind: LedgerRefusalKind,
    item: StockItem,
    locationId: string,
    onHand: string | null
  ) {
    super(`${describeRefusal(kind)} (${item.itemType} ${item.itemRef})`);
    this.name = "InventoryLedgerRefusedError";
    this.kind = kind;
    this.item = item;
    this.locationId = locationId;
    this.onHand = onHand;
  }
}

/** An admin edit or an import tried to change a stock count while the ledger owns it. */
export class StockManagedByInventoryError extends Error {
  constructor() {
    super(STOCK_MANAGED_BY_INVENTORY_MESSAGE);
    this.name = "StockManagedByInventoryError";
  }
}

function modeLockKey(tenantId: string): string {
  return `commerce.inventory_mode|${tenantId}`;
}

async function lockMode(
  tx: Bun.SQL,
  tenantId: string,
  exclusive: boolean
): Promise<void> {
  const key = modeLockKey(tenantId);
  if (exclusive) {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  } else {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
  }
}

/** Takes the cut-over/rollback's EXCLUSIVE mode lock: waits for every in-flight stock write, blocks new ones. */
export async function lockInventoryModeExclusive(
  tx: Bun.SQL,
  tenantId: string
): Promise<void> {
  await lockMode(tx, tenantId, true);
}

type ConfigRow = {
  inventory_mode: string;
  inventory_location_id: string | null;
  inventory_mode_changed_at: Date | null;
};

/**
 * The tenant's stock authority, without taking the mode lock. For reads that do
 * not write stock (the status endpoint, reconciliation). `deleted_at` is
 * ignored on purpose: "reset the store settings to defaults" must not flip the
 * stock authority (see `sql/947`).
 */
export async function readInventoryConfig(
  tx: Bun.SQL,
  tenantId: string
): Promise<InventoryConfig & { changedAt: Date | null }> {
  const rows = (await tx`
    SELECT inventory_mode, inventory_location_id, inventory_mode_changed_at
    FROM awcms_commerce_store_settings
    WHERE tenant_id = ${tenantId}
  `) as ConfigRow[];
  const row = rows[0];

  if (row && row.inventory_mode === "ledger" && row.inventory_location_id) {
    return {
      mode: "ledger",
      locationId: row.inventory_location_id,
      changedAt: row.inventory_mode_changed_at
    };
  }

  return { mode: "counter", changedAt: row?.inventory_mode_changed_at ?? null };
}

/**
 * The tenant's stock authority for a WRITE: takes the shared mode lock first, so
 * the answer cannot change under the transaction (see the header).
 */
export async function resolveInventoryConfig(
  tx: Bun.SQL,
  tenantId: string
): Promise<InventoryConfig> {
  await lockMode(tx, tenantId, false);
  const config = await readInventoryConfig(tx, tenantId);

  return config.mode === "ledger"
    ? { mode: "ledger", locationId: config.locationId }
    : { mode: "counter" };
}

/**
 * Refuses an admin edit/import that would change a stock count in `ledger` mode.
 * Takes the mode lock only when a change is actually requested.
 */
export async function assertStockWritable(
  tx: Bun.SQL,
  tenantId: string,
  requested: number | undefined,
  current: number
): Promise<void> {
  if (requested === undefined || requested === current) return;
  const config = await resolveInventoryConfig(tx, tenantId);
  if (stockWriteRefused(config.mode as InventoryMode, requested, current)) {
    throw new StockManagedByInventoryError();
  }
}

/** Writes the cache column of one stock unit; a no-op when it already holds `value`. */
export async function writeStockCache(
  tx: Bun.SQL,
  tenantId: string,
  item: StockItem,
  value: number
): Promise<void> {
  const target = stockItemTarget(item);
  if (!target) return;

  if (target.kind === "variant") {
    await tx`
      UPDATE awcms_commerce_product_variants
      SET stock = ${value}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${target.id}
        AND stock IS DISTINCT FROM ${value}
    `;
  } else {
    await tx`
      UPDATE awcms_commerce_products
      SET stock = ${value}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${target.id}
        AND stock IS DISTINCT FROM ${value}
    `;
  }
}

/** Re-reads the ledger balance of each item at the sales location and rewrites its cache. */
export async function refreshStockCache(
  tx: Bun.SQL,
  tenantId: string,
  locationId: string,
  items: readonly StockItem[]
): Promise<void> {
  const port = commerceInventoryPort();
  const seen = new Set<string>();

  for (const item of sortForPosting(
    items.map((entry) => ({ item: entry, lineKey: "" }))
  )) {
    const key = `${item.item.itemType}|${item.item.itemRef}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const onHand = await port.getOnHand(tx, tenantId, locationId, {
      ...item.item,
      unitCode: COMMERCE_STOCK_UNIT_CODE
    });
    await writeStockCache(
      tx,
      tenantId,
      item.item,
      cacheValueFromBalance(onHand)
    );
  }
}

export type SaleLine = {
  /** the ledger source line: an order item id, or a return line id. */
  lineId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
};

export type PostContext = {
  actorTenantUserId: string | null;
  correlationId?: string;
};

type PostKind = "sale" | "sale_return";

function refusalOf(
  outcome: InventoryPostOutcome
): outcome is Exclude<
  InventoryPostOutcome,
  { outcome: "posted" | "replayed" }
> {
  return outcome.outcome !== "posted" && outcome.outcome !== "replayed";
}

async function postLines(
  tx: Bun.SQL,
  tenantId: string,
  locationId: string,
  kind: PostKind,
  source: { type: string; id: string },
  lines: readonly SaleLine[],
  context: PostContext
): Promise<void> {
  const port = commerceInventoryPort();
  const ordered = sortForPosting(
    lines.map((line) => ({
      line,
      item: stockItemFor(line),
      lineKey: line.lineId
    }))
  );

  for (const entry of ordered) {
    const request = {
      ...entry.item,
      unitCode: COMMERCE_STOCK_UNIT_CODE,
      locationId,
      quantity: quantityText(entry.line.quantity),
      source: { type: source.type, id: source.id, line: entry.lineKey },
      correlationId: context.correlationId
    };
    const outcome =
      kind === "sale"
        ? await port.postSale(tx, tenantId, context.actorTenantUserId, request)
        : await port.postSaleReturn(
            tx,
            tenantId,
            context.actorTenantUserId,
            request
          );

    if (refusalOf(outcome)) {
      throw new InventoryLedgerRefusedError(
        outcome.outcome,
        entry.item,
        locationId,
        outcome.outcome === "insufficient_stock" ? outcome.onHand : null
      );
    }

    // A replay carries the ORIGINAL movement's balance, which may be stale:
    // read the current one. A fresh post's `balanceAfter` is exactly the balance
    // this transaction holds the row lock on.
    if (outcome.outcome === "replayed") {
      await refreshStockCache(tx, tenantId, locationId, [entry.item]);
    } else {
      await writeStockCache(
        tx,
        tenantId,
        entry.item,
        cacheValueFromBalance(outcome.movements[0]!.balanceAfter)
      );
    }
  }
}

/**
 * Sells every line of an order out of the ledger (`sale`, source
 * `{commerce_order, orderId, lineId}`). Throws {@link InventoryLedgerRefusedError}
 * on the first refusal; the caller's savepoint or transaction rolls the earlier
 * lines back (port doc §6.3).
 */
export async function postOrderSale(
  tx: Bun.SQL,
  tenantId: string,
  config: Extract<InventoryConfig, { mode: "ledger" }>,
  orderId: string,
  lines: readonly SaleLine[],
  context: PostContext
): Promise<void> {
  await postLines(
    tx,
    tenantId,
    config.locationId,
    "sale",
    { type: COMMERCE_ORDER_SOURCE_TYPE, id: orderId },
    lines,
    context
  );
}

/** Puts a cancelled/expired order's lines back (`sale_return`, source `{commerce_order_restock, orderId, lineId}`). */
export async function postOrderRestock(
  tx: Bun.SQL,
  tenantId: string,
  config: Extract<InventoryConfig, { mode: "ledger" }>,
  orderId: string,
  lines: readonly SaleLine[],
  context: PostContext
): Promise<void> {
  await postLines(
    tx,
    tenantId,
    config.locationId,
    "sale_return",
    { type: COMMERCE_ORDER_RESTOCK_SOURCE_TYPE, id: orderId },
    lines,
    context
  );
}

/** Puts a return's restocked lines back (`sale_return`, source `{commerce_return, returnId, returnLineId}`). */
export async function postReturnRestock(
  tx: Bun.SQL,
  tenantId: string,
  config: Extract<InventoryConfig, { mode: "ledger" }>,
  returnId: string,
  lines: readonly SaleLine[],
  context: PostContext
): Promise<void> {
  await postLines(
    tx,
    tenantId,
    config.locationId,
    "sale_return",
    { type: COMMERCE_RETURN_SOURCE_TYPE, id: returnId },
    lines,
    context
  );
}
