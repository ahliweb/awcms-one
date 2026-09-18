import { normalizeMoney } from "../domain/price-calculation";
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import {
  keysetCursorCreatedAtSql,
  encodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import type {
  MediaLibraryPort,
  ResolvedMediaReferenceDTO
} from "../../_shared/ports/media-library-port";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_FLASH_SALE_AGGREGATE_TYPE,
  COMMERCE_FLASH_SALE_ENDED_EVENT_TYPE,
  COMMERCE_FLASH_SALE_STARTED_EVENT_TYPE
} from "../domain/commerce-events";
import {
  deriveFlashSaleStatus,
  type FlashSaleStatus
} from "../domain/flash-sale-status";
import type {
  CreateFlashSaleInput,
  CreateFlashSaleProductInput,
  UpdateFlashSaleInput,
  UpdateFlashSaleProductInput
} from "../domain/flash-sale-validation";
import { listLiveProductImagesByProductIds } from "./product-image-directory";

const PRODUCER_MODULE = "commerce";
/** Bounded per tenant per tick — a tenant's own flash-sale calendar is small (see `module.ts`'s `dataLifecycle` partition rationale), so this is generous headroom, not a real limit. */
const TICK_BATCH_LIMIT = 500;

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "flash_sale";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const FLASH_SALES_SLUG_CONSTRAINT =
  "awcms_commerce_flash_sales_tenant_slug_key";

/** Same bound as `product-directory.ts`'s `PRODUCT_LIST_LIMIT` — see its comment. */
export const FLASH_SALE_LIST_LIMIT = 100;

export class DuplicateFlashSaleSlugError extends Error {
  constructor(slug: string) {
    super(`A flash sale with slug "${slug}" already exists for this tenant.`);
    this.name = "DuplicateFlashSaleSlugError";
  }
}

/** `productId`/`variantId` (when set) does not resolve to a live row in this tenant — one error for both causes, same GHSA-r7cx-c4jh-cvvw reasoning `ProductCategoryNotFoundError` already uses in this module. */
export class FlashSaleProductReferenceInvalidError extends Error {
  constructor() {
    super(
      "productId/variantId does not reference a live product/variant in this tenant."
    );
    this.name = "FlashSaleProductReferenceInvalidError";
  }
}

export class DuplicateFlashSaleProductError extends Error {
  constructor() {
    super("This product (and variant, if any) is already on this flash sale.");
    this.name = "DuplicateFlashSaleProductError";
  }
}

type FlashSaleRow = {
  id: string;
  name: string;
  slug: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
};

/**
 * The OWNER wire shape — every value on the row, `status` as STORED (the
 * editorial state, `draft`/`scheduled`, or whatever the tick job last wrote).
 * The admin screen that wants the LIVE derived status computes it itself via
 * `deriveFlashSaleStatus` (same function the public read model and the tick
 * job use) rather than this type carrying two different notions of "status".
 */
export type FlashSaleRecord = {
  id: string;
  name: string;
  slug: string;
  startsAt: string;
  endsAt: string;
  status: FlashSaleStatus;
};

function toRecord(row: FlashSaleRow): FlashSaleRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    status: row.status as FlashSaleStatus
  };
}

export type FlashSaleListPage = {
  items: FlashSaleRecord[];
  nextCursor: string | null;
};

export async function listFlashSales(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null = null
): Promise<FlashSaleListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT id, name, slug, starts_at, ends_at, status,
           ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_flash_sales
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${FLASH_SALE_LIST_LIMIT}
  `) as (FlashSaleRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === FLASH_SALE_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items: rows.map(toRecord), nextCursor };
}

export async function fetchFlashSaleById(
  tx: Bun.SQL,
  tenantId: string,
  flashSaleId: string
): Promise<FlashSaleRecord | null> {
  const rows = (await tx`
    SELECT id, name, slug, starts_at, ends_at, status
    FROM awcms_commerce_flash_sales
    WHERE tenant_id = ${tenantId} AND id = ${flashSaleId} AND deleted_at IS NULL
  `) as FlashSaleRow[];

  return rows[0] ? toRecord(rows[0]) : null;
}

export async function createFlashSale(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateFlashSaleInput,
  correlationId?: string
): Promise<FlashSaleRecord> {
  let rows: FlashSaleRow[];

  try {
    rows = (await tx`
      INSERT INTO awcms_commerce_flash_sales (tenant_id, name, slug, starts_at, ends_at, status)
      VALUES (${tenantId}, ${input.name}, ${input.slug}, ${input.startsAt}, ${input.endsAt}, ${input.status})
      RETURNING id, name, slug, starts_at, ends_at, status
    `) as FlashSaleRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
      error.constraint === FLASH_SALES_SLUG_CONSTRAINT
    ) {
      throw new DuplicateFlashSaleSlugError(input.slug);
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
    message: `Flash sale created: ${record.name}.`,
    attributes: { slug: record.slug },
    correlationId
  });

  return record;
}

export async function updateFlashSale(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  flashSaleId: string,
  input: UpdateFlashSaleInput,
  correlationId?: string
): Promise<FlashSaleRecord | null> {
  const existing = await fetchFlashSaleById(tx, tenantId, flashSaleId);
  if (!existing) return null;

  let rows: FlashSaleRow[];

  try {
    rows = (await tx`
      UPDATE awcms_commerce_flash_sales
      SET
        name = ${input.name ?? existing.name},
        slug = ${input.slug ?? existing.slug},
        starts_at = ${input.startsAt ?? new Date(existing.startsAt)},
        ends_at = ${input.endsAt ?? new Date(existing.endsAt)},
        status = ${input.status ?? existing.status},
        updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${flashSaleId} AND deleted_at IS NULL
      RETURNING id, name, slug, starts_at, ends_at, status
    `) as FlashSaleRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
      error.constraint === FLASH_SALES_SLUG_CONSTRAINT
    ) {
      throw new DuplicateFlashSaleSlugError(input.slug ?? existing.slug);
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
    message: "Flash sale updated.",
    attributes: { fields: Object.keys(input) },
    correlationId
  });

  return record;
}

/** Soft delete. No domain event — same "an audit-log fact, not a catalog event" choice `deleteCategory`/`deleteProduct` already make in this module. */
export async function deleteFlashSale(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  flashSaleId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_commerce_flash_sales
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${flashSaleId} AND deleted_at IS NULL
    RETURNING id
  `;

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "delete",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: flashSaleId,
    severity: "warning",
    message: "Flash sale soft-deleted.",
    correlationId
  });

  return true;
}

// ---------------------------------------------------------------------------
// Flash-sale products — a sub-resource of editing a flash sale, the same
// "owned by, edited through" relationship product images/variants have to a
// product (`sql/905`).
// ---------------------------------------------------------------------------

type FlashSaleProductRow = {
  id: string;
  flash_sale_id: string;
  product_id: string;
  variant_id: string | null;
  sale_price: string;
  quota: number;
  sold: number;
  sort_order: number;
};

export type FlashSaleProductRecord = {
  id: string;
  flashSaleId: string;
  productId: string;
  variantId: string | null;
  salePrice: string;
  quota: number;
  sold: number;
  sortOrder: number;
};

function toProductRecord(row: FlashSaleProductRow): FlashSaleProductRecord {
  return {
    id: row.id,
    flashSaleId: row.flash_sale_id,
    productId: row.product_id,
    variantId: row.variant_id,
    salePrice: normalizeMoney(row.sale_price),
    quota: row.quota,
    sold: row.sold,
    sortOrder: row.sort_order
  };
}

async function flashSaleExists(
  tx: Bun.SQL,
  tenantId: string,
  flashSaleId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT 1 FROM awcms_commerce_flash_sales
    WHERE tenant_id = ${tenantId} AND id = ${flashSaleId} AND deleted_at IS NULL
  `) as unknown[];
  return rows.length > 0;
}

/** `productId` live, AND (when set) `variantId` live and belonging to THAT product — one round trip covers both, mirroring `product-variant-directory.ts`'s own existence check shape. */
async function productAndVariantReferenceValid(
  tx: Bun.SQL,
  tenantId: string,
  productId: string,
  variantId: string | null
): Promise<boolean> {
  const productRows = (await tx`
    SELECT 1 FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND id = ${productId} AND deleted_at IS NULL
  `) as unknown[];
  if (productRows.length === 0) return false;

  if (variantId === null) return true;

  const variantRows = (await tx`
    SELECT 1 FROM awcms_commerce_product_variants
    WHERE tenant_id = ${tenantId} AND id = ${variantId} AND product_id = ${productId} AND deleted_at IS NULL
  `) as unknown[];
  return variantRows.length > 0;
}

export async function listFlashSaleProducts(
  tx: Bun.SQL,
  tenantId: string,
  flashSaleId: string
): Promise<FlashSaleProductRecord[]> {
  const rows = (await tx`
    SELECT id, flash_sale_id, product_id, variant_id, sale_price, quota, sold, sort_order
    FROM awcms_commerce_flash_sale_products
    WHERE tenant_id = ${tenantId} AND flash_sale_id = ${flashSaleId} AND deleted_at IS NULL
    ORDER BY sort_order, id
  `) as FlashSaleProductRow[];

  return rows.map(toProductRecord);
}

/**
 * @throws {FlashSaleProductReferenceInvalidError} `productId`/`variantId` does
 *   not reference a live row in this tenant.
 * @throws {DuplicateFlashSaleProductError} this (product, variant) pair is
 *   already on this sale.
 */
export async function createFlashSaleProduct(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  flashSaleId: string,
  input: CreateFlashSaleProductInput,
  correlationId?: string
): Promise<FlashSaleProductRecord | null> {
  if (!(await flashSaleExists(tx, tenantId, flashSaleId))) return null;

  if (
    !(await productAndVariantReferenceValid(
      tx,
      tenantId,
      input.productId,
      input.variantId
    ))
  ) {
    throw new FlashSaleProductReferenceInvalidError();
  }

  let rows: FlashSaleProductRow[];

  try {
    rows = (await tx`
      INSERT INTO awcms_commerce_flash_sale_products
        (tenant_id, flash_sale_id, product_id, variant_id, sale_price, quota, sort_order)
      VALUES (${tenantId}, ${flashSaleId}, ${input.productId}, ${input.variantId}, ${input.salePrice}, ${input.quota}, ${input.sortOrder})
      RETURNING id, flash_sale_id, product_id, variant_id, sale_price, quota, sold, sort_order
    `) as FlashSaleProductRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION
    ) {
      throw new DuplicateFlashSaleProductError();
    }
    throw error;
  }

  const record = toProductRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: flashSaleId,
    message: `Product added to flash sale ${flashSaleId}.`,
    attributes: { productId: input.productId, variantId: input.variantId },
    correlationId
  });

  return record;
}

export async function updateFlashSaleProduct(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  flashSaleId: string,
  flashSaleProductId: string,
  input: UpdateFlashSaleProductInput,
  correlationId?: string
): Promise<FlashSaleProductRecord | null> {
  const existingRows = (await tx`
    SELECT id, flash_sale_id, product_id, variant_id, sale_price, quota, sold, sort_order
    FROM awcms_commerce_flash_sale_products
    WHERE tenant_id = ${tenantId} AND id = ${flashSaleProductId} AND flash_sale_id = ${flashSaleId}
      AND deleted_at IS NULL
  `) as FlashSaleProductRow[];
  const existing = existingRows[0];
  if (!existing) return null;

  const rows = (await tx`
    UPDATE awcms_commerce_flash_sale_products
    SET
      sale_price = ${input.salePrice ?? existing.sale_price},
      quota = ${input.quota ?? existing.quota},
      sort_order = ${input.sortOrder ?? existing.sort_order},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${flashSaleProductId} AND flash_sale_id = ${flashSaleId}
      AND deleted_at IS NULL
    RETURNING id, flash_sale_id, product_id, variant_id, sale_price, quota, sold, sort_order
  `) as FlashSaleProductRow[];

  if (rows.length === 0) return null;

  const record = toProductRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: flashSaleId,
    message: `Flash sale product ${flashSaleProductId} updated.`,
    attributes: { fields: Object.keys(input) },
    correlationId
  });

  return record;
}

export async function deleteFlashSaleProduct(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  flashSaleId: string,
  flashSaleProductId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_commerce_flash_sale_products
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${flashSaleProductId} AND flash_sale_id = ${flashSaleId}
      AND deleted_at IS NULL
    RETURNING id
  `;

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: flashSaleId,
    severity: "warning",
    message: `Product removed from flash sale ${flashSaleId}.`,
    attributes: { flashSaleProductId },
    correlationId
  });

  return true;
}

// ---------------------------------------------------------------------------
// Public read model — GET /api/v1/commerce/flash-sales/active
// ---------------------------------------------------------------------------

export type FlashSalePublicProductDTO = {
  productId: string;
  variantId: string | null;
  salePrice: string;
  originalPrice: string;
  quota: number;
  sold: number;
  sortOrder: number;
  product: {
    id: string;
    slug: string;
    name: string;
    image: { url: string | null; alt: string | null };
  };
};

export type FlashSalePublicDTO = {
  id: string;
  name: string;
  slug: string;
  startsAt: string;
  endsAt: string;
  status: "scheduled" | "active";
  products: FlashSalePublicProductDTO[];
};

type FlashSaleProductJoinRow = {
  id: string;
  flash_sale_id: string;
  product_id: string;
  variant_id: string | null;
  sale_price: string;
  quota: number;
  sold: number;
  sort_order: number;
  product_slug: string;
  product_name: string;
  product_price: string;
  variant_price: string | null;
};

/**
 * Sales whose window contains `now()` **and** sales still scheduled to start
 * — never `draft`, never `ended` (Issue #26's own contract). Recomputes each
 * sale's status LIVE via `deriveFlashSaleStatus` rather than trusting the
 * stored column, so a caller never sees a sale a few minutes stale because
 * `commerce:flash-sales:tick` has not run yet — see `flash-sale-status.ts`'s
 * header. `product.image` is `images[0].publicUrl` (issue #26's own note on
 * the product DTO), resolved in ONE batched call regardless of how many
 * sales/products are returned (never N+1, same discipline
 * `product-directory.ts`'s `attachProductRelations` follows).
 */
export async function listActiveFlashSalesPublic(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  now: Date
): Promise<FlashSalePublicDTO[]> {
  const saleRows = (await tx`
    SELECT id, name, slug, starts_at, ends_at, status
    FROM awcms_commerce_flash_sales
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL AND status != 'draft'
    ORDER BY starts_at ASC
  `) as FlashSaleRow[];

  const qualifying = saleRows
    .map((row) => ({
      row,
      derived: deriveFlashSaleStatus(
        row.status as FlashSaleStatus,
        row.starts_at,
        row.ends_at,
        now
      )
    }))
    .filter(
      (
        entry
      ): entry is { row: FlashSaleRow; derived: "scheduled" | "active" } =>
        entry.derived === "scheduled" || entry.derived === "active"
    );

  if (qualifying.length === 0) return [];

  const saleIds = qualifying.map((entry) => entry.row.id);

  const productRows = (await tx`
    SELECT
      fsp.id, fsp.flash_sale_id, fsp.product_id, fsp.variant_id,
      fsp.sale_price, fsp.quota, fsp.sold, fsp.sort_order,
      p.slug AS product_slug, p.name AS product_name, p.price AS product_price,
      v.price AS variant_price
    FROM awcms_commerce_flash_sale_products fsp
    JOIN awcms_commerce_products p ON p.id = fsp.product_id
    LEFT JOIN awcms_commerce_product_variants v ON v.id = fsp.variant_id
    WHERE fsp.tenant_id = ${tenantId}
      AND fsp.deleted_at IS NULL
      AND fsp.flash_sale_id = ANY(${tx.array([...saleIds], "uuid")}::uuid[])
    ORDER BY fsp.flash_sale_id, fsp.sort_order, fsp.id
  `) as FlashSaleProductJoinRow[];

  const productIds = [...new Set(productRows.map((row) => row.product_id))];
  const imageRows = await listLiveProductImagesByProductIds(
    tx,
    tenantId,
    productIds
  );

  // First live image per product — `listLiveProductImagesByProductIds`
  // already orders by `(product_id, sort_order, id)`, so the first row seen
  // for a product IS its lowest-`sort_order` image.
  const firstImageMediaIdByProduct = new Map<string, string>();
  for (const image of imageRows) {
    if (!firstImageMediaIdByProduct.has(image.product_id)) {
      firstImageMediaIdByProduct.set(image.product_id, image.media_object_id);
    }
  }

  const mediaIds = [...new Set(firstImageMediaIdByProduct.values())];
  const resolvedMedia =
    mediaIds.length > 0
      ? await mediaPort.resolveMediaReferences(tx, tenantId, mediaIds)
      : new Map<string, ResolvedMediaReferenceDTO>();

  const productsBySale = new Map<string, FlashSalePublicProductDTO[]>();
  for (const row of productRows) {
    const mediaObjectId = firstImageMediaIdByProduct.get(row.product_id);
    const resolved = mediaObjectId
      ? resolvedMedia.get(mediaObjectId)
      : undefined;

    const list = productsBySale.get(row.flash_sale_id) ?? [];
    list.push({
      productId: row.product_id,
      variantId: row.variant_id,
      salePrice: normalizeMoney(row.sale_price),
      originalPrice: normalizeMoney(
        row.variant_id
          ? (row.variant_price ?? row.product_price)
          : row.product_price
      ),
      quota: row.quota,
      sold: row.sold,
      sortOrder: row.sort_order,
      product: {
        id: row.product_id,
        slug: row.product_slug,
        name: row.product_name,
        image: {
          url: resolved?.publicUrl ?? null,
          alt: resolved?.altText ?? null
        }
      }
    });
    productsBySale.set(row.flash_sale_id, list);
  }

  return qualifying.map(({ row, derived }) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    status: derived,
    products: productsBySale.get(row.id) ?? []
  }));
}

// ---------------------------------------------------------------------------
// commerce:flash-sales:tick — the scheduled job's per-tenant work. Opens its
// OWN transaction (`withTenantOrThrow`, not `withTenant` — a non-HTTP caller
// throws rather than returning a `Response`, same choice
// `blog-scheduled-publish.ts`'s `publishDueScheduledPosts` makes), so
// `scripts/commerce-flash-sales-tick.ts` only has to iterate tenants and call
// this once per tenant, exactly the shape that script follows.
// ---------------------------------------------------------------------------

export type TickFlashSalesResult = {
  startedCount: number;
  endedCount: number;
  partial: boolean;
};

/**
 * Recomputes every non-draft, non-ended flash sale in `tenantId` against
 * `now` and persists the derived status when it changed, firing
 * `commerce.flash_sale.started`/`.ended` on the transition. Idempotent — a
 * sale whose derived status has not moved since the last tick does not match
 * this query's `status IN ('scheduled', 'active')` guard once it settles
 * into `ended`, and a `scheduled` sale whose window has not opened yet is
 * simply left alone (no event, no write).
 */
export async function tickFlashSalesForTenant(
  sql: Bun.SQL,
  tenantId: string,
  now: Date,
  correlationId?: string
): Promise<TickFlashSalesResult> {
  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const rows = (await tx`
        SELECT id, name, slug, starts_at, ends_at, status
        FROM awcms_commerce_flash_sales
        WHERE tenant_id = ${tenantId}
          AND deleted_at IS NULL
          AND status IN ('scheduled', 'active')
        ORDER BY starts_at ASC
        LIMIT ${TICK_BATCH_LIMIT}
        FOR UPDATE SKIP LOCKED
      `) as FlashSaleRow[];

      let startedCount = 0;
      let endedCount = 0;

      for (const row of rows) {
        const derived = deriveFlashSaleStatus(
          row.status as FlashSaleStatus,
          row.starts_at,
          row.ends_at,
          now
        );
        if (derived === row.status) continue;

        await tx`
          UPDATE awcms_commerce_flash_sales
          SET status = ${derived}, updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${row.id}
        `;

        if (derived === "active") {
          startedCount += 1;
          await appendDomainEvent(tx, tenantId, {
            eventType: COMMERCE_FLASH_SALE_STARTED_EVENT_TYPE,
            eventVersion: COMMERCE_EVENT_VERSION,
            aggregateType: COMMERCE_FLASH_SALE_AGGREGATE_TYPE,
            aggregateId: row.id,
            producerModule: PRODUCER_MODULE,
            correlationId,
            payload: { flashSaleId: row.id, slug: row.slug }
          });
        } else if (derived === "ended") {
          endedCount += 1;
          await appendDomainEvent(tx, tenantId, {
            eventType: COMMERCE_FLASH_SALE_ENDED_EVENT_TYPE,
            eventVersion: COMMERCE_EVENT_VERSION,
            aggregateType: COMMERCE_FLASH_SALE_AGGREGATE_TYPE,
            aggregateId: row.id,
            producerModule: PRODUCER_MODULE,
            correlationId,
            payload: { flashSaleId: row.id, slug: row.slug }
          });
        }

        await recordAuditEvent(tx, {
          tenantId,
          moduleKey: AUDIT_MODULE_KEY,
          action: "update",
          resourceType: AUDIT_RESOURCE_TYPE,
          resourceId: row.id,
          message: `Flash sale ${row.slug} transitioned to ${derived} (scheduled job).`,
          correlationId
        });
      }

      return {
        startedCount,
        endedCount,
        partial: rows.length === TICK_BATCH_LIMIT
      };
    },
    { workClass: "background_sync" }
  );
}
