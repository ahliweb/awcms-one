/**
 * Barcode persistence for `commerce` (Issue #292, ADR-0032): resolve a scanned
 * code to ONE catalogue row, browse the products/variants that can carry a
 * barcode, assign or clear one, and load the rows a label sheet prints.
 *
 * Every statement filters `tenant_id = ${tenantId}` on top of FORCE RLS - the
 * module-wide convention - and every lookup is an equality probe on
 * `(tenant_id, barcode)`, which the partial unique indexes of `sql/975` serve
 * directly (no scan, no `ILIKE`, so a large catalogue costs the same as a small
 * one, and the predicate is leakproof: plain `=` on `text`).
 *
 * A code that is unknown, soft-deleted or belongs to another tenant answers the
 * SAME `null` - the route turns that into one neutral 404, so a caller cannot
 * use the endpoint to probe for codes of a tenant it is not in.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { computeFinalPrice, normalizeMoney } from "../domain/price-calculation";
import {
  LABEL_LIMITS,
  validateBarcode,
  type BarcodeSymbology,
  type BarcodeTarget
} from "../domain/barcode";

const AUDIT_MODULE_KEY = "commerce";

/** A code that is already carried by another LIVE product or variant of the tenant. */
export class DuplicateBarcodeError extends Error {
  constructor() {
    super("barcode is already used by another live product or variant.");
    this.name = "DuplicateBarcodeError";
  }
}

export type BarcodeCatalogRow = {
  productId: string;
  variantId: string | null;
  /** Product name; for a variant row the variant is in `variantLabel`. */
  name: string;
  variantLabel: string | null;
  sku: string | null;
  barcode: string | null;
  symbology: BarcodeSymbology | null;
  /** Effective selling price, a `numeric(14,2)` string. */
  price: string;
  stock: number;
  status: string;
};

export type BarcodeLookupResult = BarcodeCatalogRow & {
  /** True when the product has live variants, so the bare product cannot be sold (the cashier must pick a variant). */
  requiresVariant: boolean;
  /** Whether the POS may add it to the cart right now. */
  sellable: boolean;
};

type CatalogDbRow = {
  product_id: string;
  variant_id: string | null;
  name: string;
  variant_name: string | null;
  variant_value: string | null;
  sku: string | null;
  barcode: string | null;
  price: string;
  discount_percent: number;
  variant_price: string | null;
  stock: number;
  status: string;
  has_variants?: boolean;
};

function symbologyOf(barcode: string | null): BarcodeSymbology | null {
  if (barcode === null) return null;
  const checked = validateBarcode(barcode);
  return checked.valid ? checked.symbology : "code128";
}

function toCatalogRow(row: CatalogDbRow): BarcodeCatalogRow {
  const price =
    row.variant_id !== null && row.variant_price !== null
      ? normalizeMoney(row.variant_price)!
      : computeFinalPrice(row.price, row.discount_percent);
  return {
    productId: row.product_id,
    variantId: row.variant_id,
    name: row.name,
    variantLabel:
      row.variant_id !== null
        ? `${row.variant_name ?? ""}: ${row.variant_value ?? ""}`
        : null,
    sku: row.sku,
    barcode: row.barcode,
    symbology: symbologyOf(row.barcode),
    price,
    stock: row.stock,
    status: row.status
  };
}

/**
 * The one catalogue row a scanned `code` names, or `null`. A variant wins over
 * a product only in the impossible case of both holding the code (`sql/975`'s
 * trigger makes that unrepresentable).
 */
export async function lookupBarcode(
  tx: Bun.SQL,
  tenantId: string,
  code: string
): Promise<BarcodeLookupResult | null> {
  const rows = (await tx`
    SELECT p.id AS product_id, v.id AS variant_id, p.name,
           v.name AS variant_name, v.value AS variant_value,
           COALESCE(v.sku, p.sku) AS sku, v.barcode,
           p.price, p.discount_percent, v.price AS variant_price,
           v.stock, p.status, FALSE AS has_variants
    FROM awcms_commerce_product_variants v
    JOIN awcms_commerce_products p
      ON p.id = v.product_id AND p.tenant_id = v.tenant_id
    WHERE v.tenant_id = ${tenantId} AND v.barcode = ${code}
      AND v.deleted_at IS NULL AND p.deleted_at IS NULL
    UNION ALL
    SELECT p.id, NULL::uuid, p.name, NULL, NULL, p.sku, p.barcode,
           p.price, p.discount_percent, NULL::numeric, p.stock, p.status,
           EXISTS (
             SELECT 1 FROM awcms_commerce_product_variants pv
             WHERE pv.tenant_id = p.tenant_id AND pv.product_id = p.id
               AND pv.deleted_at IS NULL
           )
    FROM awcms_commerce_products p
    WHERE p.tenant_id = ${tenantId} AND p.barcode = ${code}
      AND p.deleted_at IS NULL
    LIMIT 1
  `) as CatalogDbRow[];
  const row = rows[0];
  if (!row) return null;
  const record = toCatalogRow(row);
  const requiresVariant = row.variant_id === null && row.has_variants === true;
  return {
    ...record,
    requiresVariant,
    sellable: record.status === "active" && !requiresVariant && record.stock > 0
  };
}

export const BARCODE_CATALOG_PAGE_SIZE = 50;

export type BarcodeCatalogFilters = {
  q?: string;
  /** `with` / `without` narrow to rows that do / do not carry a barcode. */
  barcode?: "with" | "without";
  page?: number;
};

export type BarcodeCatalogPage = {
  items: BarcodeCatalogRow[];
  page: number;
  hasMore: boolean;
};

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Products (without variants) and variants, name-ordered, optionally filtered.
 * Offset pagination by design: this feeds an operator screen that pages a few
 * dozen rows at a time, not a hot path.
 */
export async function listBarcodeCatalog(
  tx: Bun.SQL,
  tenantId: string,
  filters: BarcodeCatalogFilters = {}
): Promise<BarcodeCatalogPage> {
  const page = Math.max(0, Math.min(10_000, filters.page ?? 0));
  const qTrim = filters.q?.trim() ?? "";
  const qLike = qTrim.length > 0 ? `%${escapeLike(qTrim)}%` : null;
  const barcodeFilter = filters.barcode ?? null;
  const rows = (await tx`
    SELECT * FROM (
      SELECT p.id AS product_id, v.id AS variant_id, p.name,
             v.name AS variant_name, v.value AS variant_value,
             COALESCE(v.sku, p.sku) AS sku, v.barcode,
             p.price, p.discount_percent, v.price AS variant_price,
             v.stock, p.status
      FROM awcms_commerce_product_variants v
      JOIN awcms_commerce_products p
        ON p.id = v.product_id AND p.tenant_id = v.tenant_id
      WHERE v.tenant_id = ${tenantId} AND v.deleted_at IS NULL
        AND p.deleted_at IS NULL
      UNION ALL
      SELECT p.id, NULL::uuid, p.name, NULL, NULL, p.sku, p.barcode,
             p.price, p.discount_percent, NULL::numeric, p.stock, p.status
      FROM awcms_commerce_products p
      WHERE p.tenant_id = ${tenantId} AND p.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM awcms_commerce_product_variants pv
          WHERE pv.tenant_id = p.tenant_id AND pv.product_id = p.id
            AND pv.deleted_at IS NULL
        )
    ) AS catalog
    WHERE (
        ${qLike}::text IS NULL
        OR name ILIKE ${qLike} ESCAPE '\\'
        OR sku ILIKE ${qLike} ESCAPE '\\'
        OR barcode = ${qTrim}
      )
      AND (
        ${barcodeFilter}::text IS NULL
        OR (${barcodeFilter}::text = 'with' AND barcode IS NOT NULL)
        OR (${barcodeFilter}::text = 'without' AND barcode IS NULL)
      )
    ORDER BY name, variant_name NULLS FIRST, variant_value NULLS FIRST,
             product_id, variant_id NULLS FIRST
    LIMIT ${BARCODE_CATALOG_PAGE_SIZE + 1}
    OFFSET ${page * BARCODE_CATALOG_PAGE_SIZE}
  `) as CatalogDbRow[];
  return {
    items: rows.slice(0, BARCODE_CATALOG_PAGE_SIZE).map(toCatalogRow),
    page,
    hasMore: rows.length > BARCODE_CATALOG_PAGE_SIZE
  };
}

/**
 * The rows a label sheet prints, in the order the targets were asked for.
 * Targets that do not resolve to a live row of THIS tenant are silently absent
 * (the same answer as an unknown id - no oracle); targets without a barcode are
 * returned with `barcode: null` so the sheet can say "no barcode" rather than
 * print nothing.
 */
export async function loadLabelRows(
  tx: Bun.SQL,
  tenantId: string,
  targets: readonly BarcodeTarget[]
): Promise<BarcodeCatalogRow[]> {
  const wanted = targets.slice(0, LABEL_LIMITS.maxItems);
  if (wanted.length === 0) return [];
  const productIds = [...new Set(wanted.map((target) => target.productId))];
  const rows = (await tx`
    SELECT p.id AS product_id, v.id AS variant_id, p.name,
           v.name AS variant_name, v.value AS variant_value,
           COALESCE(v.sku, p.sku) AS sku, v.barcode,
           p.price, p.discount_percent, v.price AS variant_price,
           v.stock, p.status
    FROM awcms_commerce_product_variants v
    JOIN awcms_commerce_products p
      ON p.id = v.product_id AND p.tenant_id = v.tenant_id
    WHERE v.tenant_id = ${tenantId}
      AND p.id = ANY(${tx.array(productIds, "uuid")}::uuid[])
      AND v.deleted_at IS NULL AND p.deleted_at IS NULL
    UNION ALL
    SELECT p.id, NULL::uuid, p.name, NULL, NULL, p.sku, p.barcode,
           p.price, p.discount_percent, NULL::numeric, p.stock, p.status
    FROM awcms_commerce_products p
    WHERE p.tenant_id = ${tenantId}
      AND p.id = ANY(${tx.array(productIds, "uuid")}::uuid[])
      AND p.deleted_at IS NULL
  `) as CatalogDbRow[];
  const byKey = new Map<string, BarcodeCatalogRow>();
  for (const row of rows) {
    const record = toCatalogRow(row);
    byKey.set(`${record.productId}:${record.variantId ?? ""}`, record);
  }
  const ordered: BarcodeCatalogRow[] = [];
  for (const target of wanted) {
    const found = byKey.get(`${target.productId}:${target.variantId ?? ""}`);
    if (found) ordered.push(found);
  }
  return ordered;
}

export type AssignBarcodeOutcome =
  { kind: "assigned"; row: BarcodeCatalogRow } | { kind: "not_found" };

/**
 * Sets (`code`) or clears (`null`) the barcode of a live product or variant.
 * Cross-table uniqueness is the database's job (`sql/975`'s trigger); the unique
 * violation it raises, or either partial index's own, becomes
 * {@link DuplicateBarcodeError}. A variant target must belong to the named
 * product (so an id of another product's variant cannot be re-pointed here).
 */
export async function assignBarcode(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  target: BarcodeTarget,
  code: string | null,
  correlationId?: string
): Promise<AssignBarcodeOutcome> {
  let updated: { id: string }[];
  try {
    if (target.variantId === null) {
      updated = (await tx`
        UPDATE awcms_commerce_products
        SET barcode = ${code}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${target.productId}
          AND deleted_at IS NULL
        RETURNING id
      `) as { id: string }[];
    } else {
      updated = (await tx`
        UPDATE awcms_commerce_product_variants
        SET barcode = ${code}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${target.variantId}
          AND product_id = ${target.productId} AND deleted_at IS NULL
        RETURNING id
      `) as { id: string }[];
    }
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === "23505"
    ) {
      throw new DuplicateBarcodeError();
    }
    throw error;
  }
  if (updated.length === 0) return { kind: "not_found" };

  const [row] = await loadLabelRows(tx, tenantId, [target]);
  if (!row) return { kind: "not_found" };

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: target.variantId ? "product_variant" : "product",
    resourceId: target.variantId ?? target.productId,
    message: code ? "Barcode assigned." : "Barcode cleared.",
    attributes: { barcode: code },
    correlationId
  });
  return { kind: "assigned", row };
}
