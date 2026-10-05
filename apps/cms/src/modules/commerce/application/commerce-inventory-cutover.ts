/**
 * The cut-over of one tenant from `counter` to `ledger` mode (Issue #282,
 * ADR-0038 D5): backfill the ledger from the counters and flip the mode in ONE
 * tenant transaction, so there is no instant at which the ledger is authoritative
 * and empty, or the counters are authoritative and the ledger half-filled.
 *
 * ## Order of operations (inside the caller's tenant transaction)
 *
 *   1. take the EXCLUSIVE mode lock (`lockInventoryModeExclusive`): every
 *      in-flight order, POS sale, cancellation and return that read `counter`
 *      finishes first, and none starts until this transaction ends;
 *   2. ensure the settings row exists and lock it `FOR UPDATE`; refuse unless
 *      the mode is `counter` (a second run is therefore a refusal, never a
 *      second backfill);
 *   3. lock every live product, then every live variant, `FOR UPDATE` in `id`
 *      order: the counters cannot move while they are read;
 *   4. post ONE `opening` movement per stock unit with a positive count, in
 *      `(itemType, itemRef)` order, source
 *      `{commerce_inventory_opening, <tenantId>, <itemRef>}`;
 *   5. set `inventory_mode = 'ledger'` and `inventory_location_id`;
 *   6. verify: every unit's cache equals `max(0, floor(ledger on-hand))`.
 *      Any drift throws, which rolls the whole thing back.
 *
 * The caller commits (`--commit`) or rolls back (the default dry-run), so a dry
 * run executes the real path and proves it would succeed.
 *
 * ## A stock unit
 *
 * A live variant, or a live product with no live variant (the unit every stock
 * write has always used). Units with a zero count get NO opening: the ledger
 * refuses a zero-quantity movement, and a never-moved balance already reads `0`
 * (the unit is fixed by the first real movement and commerce always passes
 * `unit`). A product WITH variants is not a unit; its own `stock` is ignored by
 * every sale, so its counter is left as it is.
 *
 * ## Openings are not on the port
 *
 * `InventoryLedgerPort` carries no opening operation (they need
 * `movements.adjust` authority and a first-movement rule). The composition root
 * - `scripts/commerce-inventory-cutover.ts` - therefore supplies `postOpening`
 * from the inventory module's own application function; this file never imports
 * the inventory module's internals.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  COMMERCE_OPENING_SOURCE_TYPE,
  COMMERCE_PRODUCT_ITEM_TYPE,
  COMMERCE_STOCK_UNIT_CODE,
  COMMERCE_VARIANT_ITEM_TYPE,
  quantityText,
  sortForPosting,
  type StockItem
} from "../domain/commerce-inventory";
import { lockInventoryModeExclusive } from "./commerce-inventory";
import { fetchStoreSettings } from "./store-settings-directory";
import { reconcileStockCache } from "./commerce-inventory-reconciliation";

export type OpeningRequest = StockItem & {
  unitCode: string;
  locationId: string;
  /** Strictly positive decimal text. */
  quantity: string;
  source: { type: string; id: string; line: string };
  correlationId?: string;
};

/** Posts one opening movement; returns the ledger's refusal vocabulary as a string, or `"posted"`. */
export type OpeningPoster = (
  tx: Bun.SQL,
  tenantId: string,
  request: OpeningRequest
) => Promise<"posted" | "replayed" | string>;

export type CutoverResult =
  | {
      kind: "completed";
      units: number;
      openings: number;
      zeroUnits: number;
      /** Sum of the opening quantities. */
      totalQuantity: number;
    }
  | { kind: "already_ledger" };

/**
 * The ledger refused an opening (an inactive location, a unit mismatch, ...).
 * Thrown, never returned: earlier openings were already posted, and a caller
 * that could commit after a returned refusal would commit a PARTIAL backfill.
 */
export class CutoverOpeningRefusedError extends Error {
  constructor(
    readonly itemType: string,
    readonly itemRef: string,
    readonly refusal: string
  ) {
    super(
      `The ledger refused the opening of ${itemType} ${itemRef}: ${refusal}.`
    );
    this.name = "CutoverOpeningRefusedError";
  }
}

/** A cut-over whose final check found drift: a bug, never a normal outcome. Rolls the transaction back. */
export class CutoverVerificationError extends Error {
  constructor(readonly drifted: number) {
    super(
      `Cut-over verification failed: ${drifted} stock unit(s) disagree with the ledger.`
    );
    this.name = "CutoverVerificationError";
  }
}

type CounterRow = { id: string; stock: number; product_id?: string };

export async function runCommerceInventoryCutover(
  tx: Bun.SQL,
  tenantId: string,
  locationId: string,
  postOpening: OpeningPoster,
  correlationId?: string
): Promise<CutoverResult> {
  await lockInventoryModeExclusive(tx, tenantId);

  // The settings row must exist, LIVE and holding real settings (never the
  // table's empty-object default): a stamped (reset) row would be hard-purged by
  // the retention engine and take the mode with it. `fetchStoreSettings` answers
  // the live blob or the defaults, so writing it back changes nothing visible.
  const settings = await fetchStoreSettings(tx, tenantId);
  await tx`
    INSERT INTO awcms_commerce_store_settings (tenant_id, settings)
    VALUES (${tenantId}, ${settings}::jsonb)
    ON CONFLICT (tenant_id) DO UPDATE
      SET settings = EXCLUDED.settings, deleted_at = NULL
  `;
  const current = (await tx`
    SELECT inventory_mode FROM awcms_commerce_store_settings
    WHERE tenant_id = ${tenantId}
    FOR UPDATE
  `) as { inventory_mode: string }[];
  if (current[0]?.inventory_mode === "ledger")
    return { kind: "already_ledger" };

  const products = (await tx`
    SELECT id, stock FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  `) as CounterRow[];
  const variants = (await tx`
    SELECT v.id, v.stock, v.product_id
    FROM awcms_commerce_product_variants v
    JOIN awcms_commerce_products p
      ON p.tenant_id = v.tenant_id AND p.id = v.product_id AND p.deleted_at IS NULL
    WHERE v.tenant_id = ${tenantId} AND v.deleted_at IS NULL
    ORDER BY v.id
    FOR UPDATE OF v
  `) as CounterRow[];

  const withVariants = new Set(variants.map((variant) => variant.product_id));
  const units = [
    ...products
      .filter((product) => !withVariants.has(product.id))
      .map((product) => ({
        item: {
          itemType: COMMERCE_PRODUCT_ITEM_TYPE,
          itemRef: product.id
        } as StockItem,
        stock: product.stock
      })),
    ...variants.map((variant) => ({
      item: {
        itemType: COMMERCE_VARIANT_ITEM_TYPE,
        itemRef: variant.id
      } as StockItem,
      stock: variant.stock
    }))
  ];

  let openings = 0;
  let totalQuantity = 0;

  for (const entry of sortForPosting(
    units.map((unit) => ({ ...unit, lineKey: "" }))
  )) {
    if (entry.stock <= 0) continue;

    const outcome = await postOpening(tx, tenantId, {
      ...entry.item,
      unitCode: COMMERCE_STOCK_UNIT_CODE,
      locationId,
      quantity: quantityText(entry.stock),
      source: {
        type: COMMERCE_OPENING_SOURCE_TYPE,
        id: tenantId,
        line: entry.item.itemRef
      },
      correlationId
    });

    if (outcome !== "posted" && outcome !== "replayed") {
      throw new CutoverOpeningRefusedError(
        entry.item.itemType,
        entry.item.itemRef,
        outcome
      );
    }

    openings += 1;
    totalQuantity += entry.stock;
  }

  await tx`
    UPDATE awcms_commerce_store_settings
    SET inventory_mode = 'ledger', inventory_location_id = ${locationId},
        inventory_mode_changed_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId}
  `;

  // Verify against the ledger before anyone can commit: every cache value must
  // be exactly what the openings (and zero balances) imply.
  let cursor: string | null = null;
  let drifted = 0;
  do {
    const page = await reconcileStockCache(tx, tenantId, cursor, 500);
    if ("kind" in page) {
      throw new CutoverVerificationError(units.length);
    }
    drifted += page.drift.length;
    cursor = page.nextCursor;
  } while (cursor !== null);
  if (drifted > 0) throw new CutoverVerificationError(drifted);

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: "commerce",
    action: "inventory.cutover",
    resourceType: "commerce_inventory",
    resourceId: tenantId,
    severity: "warning",
    message:
      "Stock authority moved from the commerce counter to the inventory ledger.",
    attributes: {
      locationId,
      units: units.length,
      openings,
      zeroUnits: units.length - openings,
      totalQuantity
    },
    correlationId
  });

  return {
    kind: "completed",
    units: units.length,
    openings,
    zeroUnits: units.length - openings,
    totalQuantity
  };
}
