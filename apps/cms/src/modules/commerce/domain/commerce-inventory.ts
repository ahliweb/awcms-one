/**
 * The pure half of commerce's adapter over the inventory ledger (Issue #282,
 * ADR-0038). No database, no import from the `inventory` module: item
 * references, the posting order, the refusal vocabulary, the cache value and the
 * `ledger`-mode edit rule are all decided here so they can be unit-tested
 * without a connection, and so `domain/` stays free of other modules' code.
 *
 * ## The stock unit
 *
 * A line's stock unit is its VARIANT when it has one and its PRODUCT otherwise
 * (the rule every stock write has always followed). The ledger item is
 * therefore `commerce.variant` / the variant's uuid, or `commerce.product` / the
 * product's uuid; the stock unit is always `unit` (commerce stock is a whole
 * count). Both references are the row's uuid, never a SKU: a SKU is editable,
 * and an `itemRef` must stay stable for the life of the item.
 */

export type InventoryMode = "counter" | "ledger";

export const INVENTORY_MODES: readonly InventoryMode[] = ["counter", "ledger"];

export const COMMERCE_VARIANT_ITEM_TYPE = "commerce.variant";
export const COMMERCE_PRODUCT_ITEM_TYPE = "commerce.product";
export const COMMERCE_STOCK_UNIT_CODE = "unit";

/** Source identities (the ledger's idempotency key is `(type, id, line, operation)`). */
export const COMMERCE_ORDER_SOURCE_TYPE = "commerce_order";
export const COMMERCE_ORDER_RESTOCK_SOURCE_TYPE = "commerce_order_restock";
export const COMMERCE_RETURN_SOURCE_TYPE = "commerce_return";
export const COMMERCE_OPENING_SOURCE_TYPE = "commerce_inventory_opening";

/** The `stock` column is a Postgres `integer`. */
export const MAX_STOCK_CACHE_VALUE = 2_147_483_647;

export type StockItem = {
  itemType:
    typeof COMMERCE_VARIANT_ITEM_TYPE | typeof COMMERCE_PRODUCT_ITEM_TYPE;
  itemRef: string;
};

export function isInventoryMode(value: unknown): value is InventoryMode {
  return value === "counter" || value === "ledger";
}

/** The ledger item of a line: its variant when it has one, else its product. */
export function stockItemFor(line: {
  productId: string;
  variantId: string | null;
}): StockItem {
  return line.variantId
    ? { itemType: COMMERCE_VARIANT_ITEM_TYPE, itemRef: line.variantId }
    : { itemType: COMMERCE_PRODUCT_ITEM_TYPE, itemRef: line.productId };
}

/** The inverse of {@link stockItemFor}: which table row a ledger item names. */
export function stockItemTarget(item: {
  itemType: string;
  itemRef: string;
}): { kind: "variant" | "product"; id: string } | null {
  if (item.itemType === COMMERCE_VARIANT_ITEM_TYPE) {
    return { kind: "variant", id: item.itemRef };
  }
  if (item.itemType === COMMERCE_PRODUCT_ITEM_TYPE) {
    return { kind: "product", id: item.itemRef };
  }
  return null;
}

/** Byte-wise comparison: locale-independent, so every process agrees on the order. */
function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Posting order: `(itemType, itemRef, lineKey)`.
 *
 * The ledger locks a balance row per posted line and holds it to the end of the
 * transaction, so two orders that touch overlapping items must reach them in the
 * same global order or they deadlock (`40P01`). `lineKey` only makes the sort
 * total when one order carries the same item on two lines.
 */
export function sortForPosting<T extends { item: StockItem; lineKey: string }>(
  lines: readonly T[]
): T[] {
  return [...lines].sort(
    (a, b) =>
      compareBytes(a.item.itemType, b.item.itemType) ||
      compareBytes(a.item.itemRef, b.item.itemRef) ||
      compareBytes(a.lineKey, b.lineKey)
  );
}

/**
 * The value the cache column takes for a ledger balance:
 * `GREATEST(0, floor(onHand))`, clamped to the column's range. The ledger may
 * hold a fraction or (under an `allow` policy) a negative; the storefront reads
 * a non-negative whole number.
 */
export function cacheValueFromBalance(onHand: string): number {
  const match = /^(-?)(\d+)(?:\.\d+)?$/.exec(onHand.trim());
  if (!match) {
    throw new Error(`Not a canonical decimal quantity: ${onHand}`);
  }
  if (match[1] === "-") return 0;
  const whole = BigInt(match[2]!);
  return whole > BigInt(MAX_STOCK_CACHE_VALUE)
    ? MAX_STOCK_CACHE_VALUE
    : Number(whole);
}

/** A quantity as the decimal text the port takes. */
export function quantityText(quantity: number): string {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error(
      `A posted quantity must be a positive integer: ${quantity}`
    );
  }
  return String(quantity);
}

/** The refusals the port returns as values (everything but `posted`/`replayed`). */
export type LedgerRefusalKind =
  | "insufficient_stock"
  | "unit_mismatch"
  | "quantity_out_of_range"
  | "location_not_found"
  | "location_inactive"
  | "source_conflict";

/**
 * `insufficient_stock` is the out-of-stock answer a shopper or cashier already
 * gets (`CART_CHANGED` / `PosCartChangedError`); every other refusal means the
 * ledger configuration or the source identity is wrong, which is an operator's
 * problem and answers `409 INVENTORY_UNAVAILABLE`.
 */
export function isOutOfStock(kind: LedgerRefusalKind): boolean {
  return kind === "insufficient_stock";
}

export const STOCK_MANAGED_BY_INVENTORY_CODE = "STOCK_MANAGED_BY_INVENTORY";
export const STOCK_MANAGED_BY_INVENTORY_MESSAGE =
  "Stock is managed by the inventory ledger for this store; change it with an adjustment, receipt or transfer under /admin/inventory instead of editing the product.";

/**
 * In `ledger` mode an admin edit or an import may not CHANGE a stock count (the
 * ledger would not move and the cache would drift); sending the value the row
 * already holds is accepted so a full-record PUT still works. A create may only
 * start at zero: a non-zero opening is a ledger movement, not a column.
 */
export function stockWriteRefused(
  mode: InventoryMode,
  requested: number | undefined,
  current: number
): boolean {
  if (mode !== "ledger" || requested === undefined) return false;
  return requested !== current;
}

/** A caller-facing sentence for each refusal (logs and the 409 body; never shown as a raw enum). */
export function describeRefusal(kind: LedgerRefusalKind): string {
  switch (kind) {
    case "insufficient_stock":
      return "The inventory ledger holds fewer units than this line needs.";
    case "unit_mismatch":
      return "The inventory ledger counts this item in a different unit.";
    case "quantity_out_of_range":
      return "The quantity is outside the range the inventory ledger accepts.";
    case "location_not_found":
      return "The store's inventory location no longer exists.";
    case "location_inactive":
      return "The store's inventory location is inactive.";
    case "source_conflict":
      return "The inventory ledger already holds a different movement for this document line.";
  }
}
