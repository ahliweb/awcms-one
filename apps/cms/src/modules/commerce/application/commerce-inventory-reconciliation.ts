/**
 * Reconciliation of the stock cache against the ledger, the resync that repairs
 * it, and the rollback to `counter` mode (Issue #282, ADR-0038 D7).
 *
 * ## What is compared
 *
 * Per STOCK UNIT - a live variant, or a live product that has no live variant -
 * the cache column (`stock`) against `GREATEST(0, floor(on_hand))` of the ledger
 * balance at the sales location, read through `InventoryLedgerPort.getOnHand`
 * (commerce never reads the ledger's tables). A unit that never moved reads
 * `"0"`, so a unit with a non-zero cache and no movement is drift: that is the
 * signature of a stock edit that bypassed the guard, or of a restore.
 *
 * Both operations are keyset-paged over the units (default 200, at most 500 per
 * call) because each unit costs one balance read; the response carries the next
 * cursor. The ledger is always the truth: a resync only ever rewrites `stock`.
 */
import {
  COMMERCE_PRODUCT_ITEM_TYPE,
  COMMERCE_STOCK_UNIT_CODE,
  COMMERCE_VARIANT_ITEM_TYPE,
  cacheValueFromBalance,
  type StockItem
} from "../domain/commerce-inventory";
import {
  commerceInventoryPort,
  lockInventoryModeExclusive,
  readInventoryConfig,
  writeStockCache
} from "./commerce-inventory";
import { recordAuditEvent } from "../../logging/application/audit-log";

export const RECONCILIATION_DEFAULT_LIMIT = 200;
export const RECONCILIATION_MAX_LIMIT = 500;

export type StockUnitRow = {
  item_type: string;
  item_ref: string;
  sku: string | null;
  name: string;
  stock: number;
};

export type StockDrift = {
  itemType: string;
  itemRef: string;
  sku: string | null;
  name: string;
  /** The cache column as it stands. */
  cached: number;
  /** What the cache must be: `max(0, floor(ledger on-hand))`. */
  expected: number;
  /** The ledger balance, as the ledger states it. */
  ledgerOnHand: string;
};

export type ReconciliationPage = {
  mode: "ledger";
  locationId: string;
  scanned: number;
  drift: StockDrift[];
  nextCursor: string | null;
};

export type ReconciliationOutcome =
  ReconciliationPage | { kind: "not_ledger_mode" } | { kind: "invalid_cursor" };

/** `itemType|itemRef` - both halves are free of `|` (item types are a dotted slug, refs are uuids). */
function parseCursor(cursor: string | null): [string, string] | null | "bad" {
  if (cursor === null) return null;
  const parts = cursor.split("|");
  return parts.length === 2 && parts[0] && parts[1]
    ? [parts[0], parts[1]]
    : "bad";
}

async function listUnits(
  tx: Bun.SQL,
  tenantId: string,
  after: [string, string] | null,
  limit: number
): Promise<StockUnitRow[]> {
  const afterType = after?.[0] ?? "";
  const afterRef = after?.[1] ?? "";

  return (await tx`
    SELECT item_type, item_ref, sku, name, stock FROM (
      SELECT ${COMMERCE_PRODUCT_ITEM_TYPE}::text AS item_type, p.id::text AS item_ref,
             p.sku AS sku, p.name AS name, p.stock AS stock
      FROM awcms_commerce_products p
      WHERE p.tenant_id = ${tenantId} AND p.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM awcms_commerce_product_variants v
          WHERE v.tenant_id = p.tenant_id AND v.product_id = p.id
            AND v.deleted_at IS NULL
        )
      UNION ALL
      SELECT ${COMMERCE_VARIANT_ITEM_TYPE}::text, v.id::text, v.sku, p.name || ' / ' || v.value, v.stock
      FROM awcms_commerce_product_variants v
      JOIN awcms_commerce_products p
        ON p.tenant_id = v.tenant_id AND p.id = v.product_id
      WHERE v.tenant_id = ${tenantId} AND v.deleted_at IS NULL
        AND p.deleted_at IS NULL
    ) units
    WHERE (item_type, item_ref) > (${afterType}::text, ${afterRef}::text)
    ORDER BY item_type, item_ref
    LIMIT ${limit}
  `) as StockUnitRow[];
}

async function scan(
  tx: Bun.SQL,
  tenantId: string,
  locationId: string,
  cursor: string | null,
  limit: number
): Promise<
  | {
      page: Omit<ReconciliationPage, "mode" | "locationId">;
      units: StockUnitRow[];
    }
  | "bad"
> {
  const after = parseCursor(cursor);
  if (after === "bad") return "bad";

  const units = await listUnits(tx, tenantId, after, limit);
  const port = commerceInventoryPort();
  const drift: StockDrift[] = [];

  for (const unit of units) {
    const onHand = await port.getOnHand(tx, tenantId, locationId, {
      itemType: unit.item_type,
      itemRef: unit.item_ref,
      unitCode: COMMERCE_STOCK_UNIT_CODE
    });
    const expected = cacheValueFromBalance(onHand);
    if (unit.stock !== expected) {
      drift.push({
        itemType: unit.item_type,
        itemRef: unit.item_ref,
        sku: unit.sku,
        name: unit.name,
        cached: unit.stock,
        expected,
        ledgerOnHand: onHand
      });
    }
  }

  const last = units[units.length - 1];

  return {
    page: {
      scanned: units.length,
      drift,
      nextCursor:
        units.length === limit && last
          ? `${last.item_type}|${last.item_ref}`
          : null
    },
    units
  };
}

export function clampLimit(limit: number | null): number {
  if (limit === null) return RECONCILIATION_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), RECONCILIATION_MAX_LIMIT);
}

/** `GET /inventory/reconciliation`: the units whose cache disagrees with the ledger, one page. */
export async function reconcileStockCache(
  tx: Bun.SQL,
  tenantId: string,
  cursor: string | null,
  limit: number
): Promise<ReconciliationOutcome> {
  const config = await readInventoryConfig(tx, tenantId);
  if (config.mode !== "ledger") return { kind: "not_ledger_mode" };

  const result = await scan(tx, tenantId, config.locationId, cursor, limit);
  if (result === "bad") return { kind: "invalid_cursor" };

  return { mode: "ledger", locationId: config.locationId, ...result.page };
}

export type ResyncOutcome =
  | (ReconciliationPage & { repaired: number })
  | { kind: "not_ledger_mode" }
  | { kind: "invalid_cursor" };

/**
 * `POST /inventory/resync`: rewrites the cache of every drifted unit on one page
 * from the ledger. Naturally idempotent (it SETS state), so it carries no
 * Idempotency-Key; audited as a warning because it changes what the storefront
 * shows. It takes no mode lock: each write is a single-row set to the value read
 * a moment ago, and a concurrent sale re-writes the cache from its own post.
 */
export async function resyncStockCache(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  cursor: string | null,
  limit: number,
  correlationId?: string
): Promise<ResyncOutcome> {
  const config = await readInventoryConfig(tx, tenantId);
  if (config.mode !== "ledger") return { kind: "not_ledger_mode" };

  const result = await scan(tx, tenantId, config.locationId, cursor, limit);
  if (result === "bad") return { kind: "invalid_cursor" };

  for (const row of result.page.drift) {
    await writeStockCache(
      tx,
      tenantId,
      { itemType: row.itemType, itemRef: row.itemRef } as StockItem,
      row.expected
    );
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: "commerce",
    action: "inventory.resync",
    resourceType: "commerce_inventory",
    resourceId: tenantId,
    severity: "warning",
    message: `Stock cache resynced from the inventory ledger: ${result.page.drift.length} of ${result.page.scanned} unit(s) repaired.`,
    attributes: {
      scanned: result.page.scanned,
      repaired: result.page.drift.length
    },
    correlationId
  });

  return {
    mode: "ledger",
    locationId: config.locationId,
    repaired: result.page.drift.length,
    ...result.page
  };
}

export type RollbackOutcome = { changed: boolean };

/**
 * `POST /inventory/rollback`: the stock authority goes back to `counter`. The
 * cache is already the last ledger-derived value, so the storefront keeps
 * selling from it and the counter paths resume from there; nothing else is
 * needed. Takes the EXCLUSIVE mode lock, so every in-flight stock write finishes
 * first and no new one starts under the old mode. Idempotent: already `counter`
 * is a successful no-op.
 */
export async function rollbackToCounterMode(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  correlationId?: string
): Promise<RollbackOutcome> {
  await lockInventoryModeExclusive(tx, tenantId);

  const updated = (await tx`
    UPDATE awcms_commerce_store_settings
    SET inventory_mode = 'counter', inventory_mode_changed_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND inventory_mode = 'ledger'
    RETURNING tenant_id
  `) as { tenant_id: string }[];

  if (updated.length === 0) return { changed: false };

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: "commerce",
    action: "inventory.rollback",
    resourceType: "commerce_inventory",
    resourceId: tenantId,
    severity: "warning",
    message:
      "Stock authority rolled back from the inventory ledger to the commerce counter.",
    attributes: { from: "ledger", to: "counter" },
    correlationId
  });

  return { changed: true };
}
