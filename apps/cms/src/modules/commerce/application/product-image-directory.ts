import { recordAuditEvent } from "../../logging/application/audit-log";
import type { MediaLibraryPort } from "../../_shared/ports/media-library-port";
import type {
  CreateProductImageInput,
  UpdateProductImageInput
} from "../domain/product-image-validation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "product_image";

/**
 * `awcms_commerce_product_images` is owned by a PRODUCT, so every function
 * here takes `productId` and scopes every query to it — an image id alone is
 * never enough to know which product (and therefore whether the caller's
 * tenant even owns it) it belongs to.
 */
export class ProductNotFoundForImageError extends Error {
  constructor() {
    super("productId does not reference a live product in this tenant.");
    this.name = "ProductNotFoundForImageError";
  }
}

/**
 * `mediaObjectId` does not resolve to a live, same-tenant, verified media
 * object — the same "does not exist / is not verified / belongs to another
 * tenant, indistinguishable on purpose" reasoning as
 * `ProductCategoryNotFoundError` (GHSA-r7cx-c4jh-cvvw's shape).
 */
export class ProductImageMediaReferenceInvalidError extends Error {
  constructor() {
    super(
      "mediaObjectId does not reference a live, verified media object in this tenant."
    );
    this.name = "ProductImageMediaReferenceInvalidError";
  }
}

export type ProductImageRow = {
  id: string;
  product_id: string;
  media_object_id: string;
  sort_order: number;
  alt_text: string | null;
};

export type ProductImageRecord = {
  id: string;
  productId: string;
  mediaObjectId: string;
  altText: string | null;
  sortOrder: number;
};

function toRecord(row: ProductImageRow): ProductImageRecord {
  return {
    id: row.id,
    productId: row.product_id,
    mediaObjectId: row.media_object_id,
    altText: row.alt_text,
    sortOrder: row.sort_order
  };
}

/** Whether `productId` is a LIVE product in `tenantId` — every mutation here checks this before touching a row. */
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

/** Batch fetch for `product-directory.ts`'s `attachProductRelations` — ordered so a caller can group by `product_id` and already have each group's own `sort_order` order. */
export async function listLiveProductImagesByProductIds(
  tx: Bun.SQL,
  tenantId: string,
  productIds: readonly string[]
): Promise<ProductImageRow[]> {
  if (productIds.length === 0) return [];

  return (await tx`
    SELECT id, product_id, media_object_id, sort_order, alt_text
    FROM awcms_commerce_product_images
    WHERE tenant_id = ${tenantId}
      AND product_id = ANY(${productIds})
      AND deleted_at IS NULL
    ORDER BY product_id, sort_order, id
  `) as ProductImageRow[];
}

/**
 * @throws {ProductNotFoundForImageError} `productId` is not a live product in this tenant.
 * @throws {ProductImageMediaReferenceInvalidError} `mediaObjectId` is not a
 *   live, verified, same-tenant media object.
 */
export async function createProductImage(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  productId: string,
  input: CreateProductImageInput,
  mediaPort: MediaLibraryPort,
  correlationId?: string
): Promise<ProductImageRecord> {
  if (!(await productExists(tx, tenantId, productId))) {
    throw new ProductNotFoundForImageError();
  }

  // Checked BEFORE the INSERT — the load-bearing ordering every other
  // existence check in this module follows (`createProduct`'s comment on why).
  const safe = await mediaPort.isMediaReferenceSafe(
    tx,
    tenantId,
    input.mediaObjectId
  );
  if (!safe) {
    throw new ProductImageMediaReferenceInvalidError();
  }

  const rows = (await tx`
    INSERT INTO awcms_commerce_product_images
      (tenant_id, product_id, media_object_id, sort_order, alt_text)
    VALUES (${tenantId}, ${productId}, ${input.mediaObjectId}, ${input.sortOrder}, ${input.altText})
    RETURNING id, product_id, media_object_id, sort_order, alt_text
  `) as ProductImageRow[];

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: `Product image added to product ${productId}.`,
    attributes: { productId, mediaObjectId: record.mediaObjectId },
    correlationId
  });

  return record;
}

export async function updateProductImage(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  productId: string,
  imageId: string,
  input: UpdateProductImageInput,
  correlationId?: string
): Promise<ProductImageRecord | null> {
  const existingRows = (await tx`
    SELECT id, product_id, media_object_id, sort_order, alt_text
    FROM awcms_commerce_product_images
    WHERE tenant_id = ${tenantId} AND id = ${imageId} AND product_id = ${productId}
      AND deleted_at IS NULL
  `) as ProductImageRow[];
  const existing = existingRows[0];
  if (!existing) return null;

  const rows = (await tx`
    UPDATE awcms_commerce_product_images
    SET
      alt_text = ${input.altText === undefined ? existing.alt_text : input.altText},
      sort_order = ${input.sortOrder ?? existing.sort_order},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${imageId} AND product_id = ${productId}
      AND deleted_at IS NULL
    RETURNING id, product_id, media_object_id, sort_order, alt_text
  `) as ProductImageRow[];

  if (rows.length === 0) return null;

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: "Product image updated.",
    attributes: { fields: Object.keys(input) },
    correlationId
  });

  return record;
}

export async function deleteProductImage(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  productId: string,
  imageId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_commerce_product_images
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${imageId} AND product_id = ${productId}
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
    resourceId: imageId,
    severity: "warning",
    message: "Product image removed.",
    attributes: { productId },
    correlationId
  });

  return true;
}
