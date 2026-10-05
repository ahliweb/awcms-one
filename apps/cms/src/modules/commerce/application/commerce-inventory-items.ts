/**
 * The ledger-reference lookup (Issue #283, ADR-0038 addendum): resolves a SKU or
 * a name to the `(itemType, itemRef)` a procurement document line must carry to
 * stock a commerce good.
 *
 * ## The convention it serves
 *
 * The ledger never looks an `itemRef` up, so a procurement line that is meant to
 * stock commerce goods has to name the stock UNIT exactly as commerce does:
 *
 *   - a live variant            -> `commerce.variant` + the variant's uuid;
 *   - a live product that has NO live variant
 *                               -> `commerce.product` + the product's uuid;
 *   - the unit is always `unit`.
 *
 * A product that HAS variants is never a stock unit (its own counter is
 * ignored, ADR-0038 D2), so it is deliberately absent here: offering its uuid
 * would invite exactly the mistake `reconciliation`'s `orphans` section exists
 * to catch. Read-only; commerce's own tables only (no ledger read).
 */
import {
  COMMERCE_PRODUCT_ITEM_TYPE,
  COMMERCE_STOCK_UNIT_CODE,
  COMMERCE_VARIANT_ITEM_TYPE
} from "../domain/commerce-inventory";

export const ITEM_LOOKUP_DEFAULT_LIMIT = 20;
export const ITEM_LOOKUP_MAX_LIMIT = 50;
export const ITEM_LOOKUP_MAX_QUERY_LENGTH = 100;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InventoryItemLookupRow = {
  itemType: string;
  itemRef: string;
  sku: string | null;
  /** The product's name (for a variant: its parent product). */
  name: string;
  /** The variant's value, e.g. `M`; `null` for a product-level unit. */
  variantName: string | null;
  unitCode: string;
};

export type InventoryItemLookupPage = {
  items: InventoryItemLookupRow[];
  nextCursor: string | null;
};

type Row = {
  item_type: string;
  item_ref: string;
  sku: string | null;
  name: string;
  variant_name: string | null;
};

/** `itemType|uuid`; `"bad"` for anything else. */
export function parseItemCursor(
  cursor: string | null
): [string, string] | null | "bad" {
  if (cursor === null) return null;
  const parts = cursor.split("|");
  const [type, ref] = parts;

  return parts.length === 2 &&
    (type === COMMERCE_PRODUCT_ITEM_TYPE ||
      type === COMMERCE_VARIANT_ITEM_TYPE) &&
    ref &&
    UUID_PATTERN.test(ref)
    ? [type, ref]
    : "bad";
}

/** Escapes `\`, `%` and `_` so a search term is matched literally. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export async function lookupInventoryItems(
  tx: Bun.SQL,
  tenantId: string,
  query: string | null,
  cursor: string | null,
  limit: number
): Promise<InventoryItemLookupPage | "invalid_cursor"> {
  const after = parseItemCursor(cursor);
  if (after === "bad") return "invalid_cursor";

  const afterType = after?.[0] ?? "";
  // A nil uuid sorts below every real one, so the first page needs no branch.
  const afterRef = after?.[1] ?? "00000000-0000-0000-0000-000000000000";
  const pattern = query ? likePattern(query) : null;

  const rows = (await tx`
    SELECT item_type, item_ref, sku, name, variant_name FROM (
      SELECT ${COMMERCE_PRODUCT_ITEM_TYPE}::text AS item_type, p.id AS item_id,
             p.id::text AS item_ref, p.sku AS sku, p.name AS name,
             NULL::text AS variant_name
      FROM awcms_commerce_products p
      WHERE p.tenant_id = ${tenantId} AND p.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM awcms_commerce_product_variants v
          WHERE v.tenant_id = p.tenant_id AND v.product_id = p.id
            AND v.deleted_at IS NULL
        )
        AND (${pattern}::text IS NULL OR p.sku ILIKE ${pattern} OR p.name ILIKE ${pattern})
      UNION ALL
      SELECT ${COMMERCE_VARIANT_ITEM_TYPE}::text, v.id, v.id::text, v.sku, p.name, v.value
      FROM awcms_commerce_product_variants v
      JOIN awcms_commerce_products p
        ON p.tenant_id = v.tenant_id AND p.id = v.product_id
      WHERE v.tenant_id = ${tenantId} AND v.deleted_at IS NULL
        AND p.deleted_at IS NULL
        AND (${pattern}::text IS NULL OR v.sku ILIKE ${pattern}
             OR p.sku ILIKE ${pattern} OR p.name ILIKE ${pattern}
             OR v.value ILIKE ${pattern})
    ) items
    WHERE (item_type, item_id) > (${afterType}::text, ${afterRef}::uuid)
    ORDER BY item_type, item_id
    LIMIT ${limit + 1}
  `) as Row[];

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return {
    items: page.map((row) => ({
      itemType: row.item_type,
      itemRef: row.item_ref,
      sku: row.sku,
      name: row.name,
      variantName: row.variant_name,
      unitCode: COMMERCE_STOCK_UNIT_CODE
    })),
    nextCursor:
      rows.length > limit && last ? `${last.item_type}|${last.item_ref}` : null
  };
}
