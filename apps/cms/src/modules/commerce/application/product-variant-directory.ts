import { normalizeMoney } from "../domain/price-calculation";
import { recordAuditEvent } from "../../logging/application/audit-log";
import type {
  CreateProductVariantInput,
  UpdateProductVariantInput
} from "../domain/product-variant-validation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "product_variant";

/** Same reasoning as `product-image-directory.ts`'s equivalent — a variant id alone does not say which product, or tenant, owns it. */
export class ProductNotFoundForVariantError extends Error {
  constructor() {
    super("productId does not reference a live product in this tenant.");
    this.name = "ProductNotFoundForVariantError";
  }
}

/**
 * `sku` is already taken — by another LIVE variant OR a LIVE product — in
 * this tenant. One error for both sources: `sql/157`'s header explains why a
 * single-table unique index cannot express this rule, so
 * `checkVariantSkuAvailable` below checks both tables and this is what it
 * throws when either one already holds the value.
 */
export class DuplicateVariantSkuError extends Error {
  constructor(sku: string) {
    super(
      `sku "${sku}" is already used by a live product or variant in this tenant.`
    );
    this.name = "DuplicateVariantSkuError";
  }
}

export type ProductVariantRow = {
  id: string;
  product_id: string;
  name: string;
  value: string;
  color_hex: string | null;
  image_media_object_id: string | null;
  sku: string | null;
  price: string | null;
  price_level_2: string | null;
  price_level_3: string | null;
  price_level_4: string | null;
  stock: number;
  weight_grams: number;
  sort_order: number;
};

export type ProductVariantRecord = {
  id: string;
  productId: string;
  name: string;
  value: string;
  colorHex: string | null;
  imageMediaObjectId: string | null;
  sku: string | null;
  price: string | null;
  priceLevel2: string | null;
  priceLevel3: string | null;
  priceLevel4: string | null;
  stock: number;
  weightGrams: number;
  sortOrder: number;
};

const VARIANT_COLUMNS = `
  id, product_id, name, value, color_hex, image_media_object_id, sku,
  price, price_level_2, price_level_3, price_level_4, stock, weight_grams, sort_order
`;

function toRecord(row: ProductVariantRow): ProductVariantRecord {
  return {
    id: row.id,
    productId: row.product_id,
    name: row.name,
    value: row.value,
    colorHex: row.color_hex,
    imageMediaObjectId: row.image_media_object_id,
    sku: row.sku,
    price: normalizeMoney(row.price),
    priceLevel2: normalizeMoney(row.price_level_2),
    priceLevel3: normalizeMoney(row.price_level_3),
    priceLevel4: normalizeMoney(row.price_level_4),
    stock: row.stock,
    weightGrams: row.weight_grams,
    sortOrder: row.sort_order
  };
}

async function productExists(
  tx: Bun.SQL,
  tenantId: string,
  productId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT 1 FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND id = ${productId} AND deleted_at IS NULL
  `) as unknown[];
  return rows.length > 0;
}

/**
 * Checks `sku` against BOTH `awcms_commerce_products` and
 * `awcms_commerce_product_variants` (Issue #23's "shared with products via a
 * domain check" — `sql/157`'s header). `excludeVariantId` lets an update keep
 * its OWN sku without tripping over itself.
 */
async function checkVariantSkuAvailable(
  tx: Bun.SQL,
  tenantId: string,
  sku: string,
  excludeVariantId: string | null
): Promise<boolean> {
  const productRows = (await tx`
    SELECT 1 FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND sku = ${sku} AND deleted_at IS NULL
  `) as unknown[];
  if (productRows.length > 0) return false;

  const variantRows = (await tx`
    SELECT 1 FROM awcms_commerce_product_variants
    WHERE tenant_id = ${tenantId} AND sku = ${sku} AND deleted_at IS NULL
      AND (${excludeVariantId}::uuid IS NULL OR id != ${excludeVariantId}::uuid)
  `) as unknown[];
  return variantRows.length === 0;
}

/** Batch fetch for `product-directory.ts`'s `attachProductRelations`. */
export async function listLiveProductVariantsByProductIds(
  tx: Bun.SQL,
  tenantId: string,
  productIds: readonly string[]
): Promise<ProductVariantRow[]> {
  if (productIds.length === 0) return [];

  return (await tx`
    SELECT ${tx.unsafe(VARIANT_COLUMNS)}
    FROM awcms_commerce_product_variants
    WHERE tenant_id = ${tenantId}
      AND product_id = ANY(${tx.array([...productIds], "uuid")}::uuid[])
      AND deleted_at IS NULL
    ORDER BY product_id, sort_order, id
  `) as ProductVariantRow[];
}

/**
 * @throws {ProductNotFoundForVariantError} `productId` is not a live product in this tenant.
 * @throws {DuplicateVariantSkuError} `input.sku` is set and already taken.
 */
export async function createProductVariant(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  productId: string,
  input: CreateProductVariantInput,
  correlationId?: string
): Promise<ProductVariantRecord> {
  if (!(await productExists(tx, tenantId, productId))) {
    throw new ProductNotFoundForVariantError();
  }

  // Checked BEFORE the INSERT (load-bearing ordering, same rule as every
  // other existence/uniqueness pre-check in this module) — the DB partial
  // unique index (`sql/157`) only ever catches the SAME-TABLE race, not a
  // product's own sku.
  if (input.sku !== null) {
    const available = await checkVariantSkuAvailable(
      tx,
      tenantId,
      input.sku,
      null
    );
    if (!available) throw new DuplicateVariantSkuError(input.sku);
  }

  let rows: ProductVariantRow[];
  try {
    rows = (await tx`
      INSERT INTO awcms_commerce_product_variants (
        tenant_id, product_id, name, value, color_hex, image_media_object_id, sku,
        price, price_level_2, price_level_3, price_level_4, stock, weight_grams, sort_order
      )
      VALUES (
        ${tenantId}, ${productId}, ${input.name}, ${input.value}, ${input.colorHex},
        ${input.imageMediaObjectId}, ${input.sku},
        ${input.price}, ${input.priceLevel2}, ${input.priceLevel3}, ${input.priceLevel4},
        ${input.stock}, ${input.weightGrams}, ${input.sortOrder}
      )
      RETURNING ${tx.unsafe(VARIANT_COLUMNS)}
    `) as ProductVariantRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === "23505"
    ) {
      // The same-table race the pre-check above cannot close.
      throw new DuplicateVariantSkuError(input.sku ?? "");
    }
    throw error;
  }

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: `Product variant added to product ${productId}.`,
    attributes: { productId, name: record.name, value: record.value },
    correlationId
  });

  return record;
}

export async function updateProductVariant(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  productId: string,
  variantId: string,
  input: UpdateProductVariantInput,
  correlationId?: string
): Promise<ProductVariantRecord | null> {
  const existingRows = (await tx`
    SELECT ${tx.unsafe(VARIANT_COLUMNS)}
    FROM awcms_commerce_product_variants
    WHERE tenant_id = ${tenantId} AND id = ${variantId} AND product_id = ${productId}
      AND deleted_at IS NULL
  `) as ProductVariantRow[];
  const existing = existingRows[0];
  if (!existing) return null;

  const nextSku = input.sku === undefined ? existing.sku : input.sku;
  if (nextSku !== null && nextSku !== existing.sku) {
    const available = await checkVariantSkuAvailable(
      tx,
      tenantId,
      nextSku,
      variantId
    );
    if (!available) throw new DuplicateVariantSkuError(nextSku);
  }

  let rows: ProductVariantRow[];
  try {
    rows = (await tx`
      UPDATE awcms_commerce_product_variants
      SET
        name = ${input.name ?? existing.name},
        value = ${input.value ?? existing.value},
        color_hex = ${input.colorHex === undefined ? existing.color_hex : input.colorHex},
        image_media_object_id = ${input.imageMediaObjectId === undefined ? existing.image_media_object_id : input.imageMediaObjectId},
        sku = ${nextSku},
        price = ${input.price === undefined ? existing.price : input.price},
        price_level_2 = ${input.priceLevel2 === undefined ? existing.price_level_2 : input.priceLevel2},
        price_level_3 = ${input.priceLevel3 === undefined ? existing.price_level_3 : input.priceLevel3},
        price_level_4 = ${input.priceLevel4 === undefined ? existing.price_level_4 : input.priceLevel4},
        stock = ${input.stock ?? existing.stock},
        weight_grams = ${input.weightGrams ?? existing.weight_grams},
        sort_order = ${input.sortOrder ?? existing.sort_order},
        updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${variantId} AND product_id = ${productId}
        AND deleted_at IS NULL
      RETURNING ${tx.unsafe(VARIANT_COLUMNS)}
    `) as ProductVariantRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === "23505"
    ) {
      throw new DuplicateVariantSkuError(nextSku ?? "");
    }
    throw error;
  }

  if (rows.length === 0) return null;

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: "Product variant updated.",
    attributes: { fields: Object.keys(input) },
    correlationId
  });

  return record;
}

export async function deleteProductVariant(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  productId: string,
  variantId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_commerce_product_variants
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${variantId} AND product_id = ${productId}
      AND deleted_at IS NULL
    RETURNING id
  `;

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "delete",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: variantId,
    severity: "warning",
    message: "Product variant removed.",
    attributes: { productId },
    correlationId
  });

  return true;
}
