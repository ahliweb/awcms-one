import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  keysetCursorCreatedAtSql,
  encodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_PRODUCT_AGGREGATE_TYPE,
  COMMERCE_PRODUCT_CREATED_EVENT_TYPE,
  COMMERCE_PRODUCT_STATUS_CHANGED_EVENT_TYPE,
  COMMERCE_PRODUCT_UPDATED_EVENT_TYPE
} from "../domain/commerce-events";
import {
  applyProductStatus,
  PRODUCT_STATUSES,
  type ProductStatus
} from "../domain/product-status";
import type { ProductType } from "../domain/product-type";
import type {
  CreateProductInput,
  UpdateProductInput
} from "../domain/product-validation";
import { fetchCategoryById } from "./category-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "product";
const PRODUCER_MODULE = "commerce";

/** Same bound as `office-directory.ts`'s `OFFICE_LIST_LIMIT` — see its comment. */
export const PRODUCT_LIST_LIMIT = 100;

/**
 * `(tenant_id, slug)` is unique among LIVE products
 * (`awcms_commerce_products_tenant_slug_key`, `sql/153`).
 */
export class DuplicateProductSlugError extends Error {
  constructor(slug: string) {
    super(`A product with slug "${slug}" already exists for this tenant.`);
    this.name = "DuplicateProductSlugError";
  }
}

/**
 * `(tenant_id, sku)` is unique among LIVE products
 * (`awcms_commerce_products_tenant_sku_key`, `sql/153`). A separate error type
 * from the slug collision above because they name different fields to the
 * caller — both are 409s, but a client needs to know WHICH value to change.
 */
export class DuplicateProductSkuError extends Error {
  constructor(sku: string) {
    super(`A product with sku "${sku}" already exists for this tenant.`);
    this.name = "DuplicateProductSkuError";
  }
}

/**
 * `categoryId` did not resolve to a live category IN THE CALLER'S TENANT.
 * Same three-causes-one-error reasoning as `category-directory.ts`'s
 * `ParentCategoryNotFoundError` / `office-directory.ts`'s
 * `ParentOfficeNotFoundError`.
 */
export class ProductCategoryNotFoundError extends Error {
  constructor() {
    super("categoryId does not reference a live category in this tenant.");
    this.name = "ProductCategoryNotFoundError";
  }
}

/**
 * `status` in an update request is a real `ProductStatus` but not a LEGAL
 * transition from the product's current one (`product-status.ts`'s
 * `LEGAL_TRANSITIONS`). Carries the same `{field, message}` shape
 * `applyProductStatus` returns so the route can fold it into an ordinary 400.
 */
export class IllegalProductStatusTransitionError extends Error {
  public readonly errors: { field: string; message: string }[];

  constructor(errors: { field: string; message: string }[]) {
    super(errors.map((error) => error.message).join(" "));
    this.name = "IllegalProductStatusTransitionError";
    this.errors = errors;
  }
}

const POSTGRES_UNIQUE_VIOLATION = "23505";
const PRODUCTS_SLUG_CONSTRAINT = "awcms_commerce_products_tenant_slug_key";
const PRODUCTS_SKU_CONSTRAINT = "awcms_commerce_products_tenant_sku_key";

/**
 * The wire shape — exactly `CommerceProduct` from Issue #4's DTO contract
 * (shared verbatim with #5). `price` stays the STRING `Bun.SQL` hands back
 * for a `numeric` column — never `Number(...)`'d, per Issue #4's "money is
 * numeric(14,2), and crosses the wire as a string" decision. No
 * `createdAt`/`updatedAt`/`deletedAt`: on the row for auditing/soft-delete,
 * deliberately outside the contract, so `toRecord` must not leak them.
 */
export type ProductRecord = {
  id: string;
  categoryId: string | null;
  type: ProductType;
  sku: string;
  name: string;
  slug: string;
  description: string | null;
  digitalNote: string | null;
  price: string;
  discountPercent: number;
  stock: number;
  status: ProductStatus;
  label: string | null;
  labelColor: string | null;
};

type ProductRow = {
  id: string;
  category_id: string | null;
  type: string;
  sku: string;
  name: string;
  slug: string;
  description: string | null;
  digital_note: string | null;
  price: string;
  discount_percent: number;
  stock: number;
  status: string;
  label: string | null;
  label_color: string | null;
};

function toRecord(row: ProductRow): ProductRecord {
  return {
    id: row.id,
    categoryId: row.category_id,
    type: row.type as ProductType,
    sku: row.sku,
    name: row.name,
    slug: row.slug,
    description: row.description,
    digitalNote: row.digital_note,
    price: row.price,
    discountPercent: row.discount_percent,
    stock: row.stock,
    status: row.status as ProductStatus,
    label: row.label,
    labelColor: row.label_color
  };
}

export type ProductListPage = {
  items: ProductRecord[];
  nextCursor: string | null;
};

/** One keyset-paginated page of live products, newest first — see `office-directory.ts`'s `listOffices` for the full precision/tiebreaker rationale this copies. */
export async function listProducts(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null = null
): Promise<ProductListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT id, category_id, type, sku, name, slug, description, digital_note,
           price, discount_percent, stock, status, label, label_color,
           ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${PRODUCT_LIST_LIMIT}
  `) as (ProductRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === PRODUCT_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items: rows.map(toRecord), nextCursor };
}

export async function fetchProductById(
  tx: Bun.SQL,
  tenantId: string,
  productId: string
): Promise<ProductRecord | null> {
  const rows = (await tx`
    SELECT id, category_id, type, sku, name, slug, description, digital_note,
           price, discount_percent, stock, status, label, label_color
    FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND id = ${productId} AND deleted_at IS NULL
  `) as ProductRow[];

  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * @throws {ProductCategoryNotFoundError} `categoryId` is not a live category
 *   in this tenant. Raised BEFORE the INSERT — ordering is load-bearing, same
 *   rule as `office-directory.ts`'s `createOffice`.
 * @throws {DuplicateProductSlugError} `slug` is already taken in this tenant.
 * @throws {DuplicateProductSkuError} `sku` is already taken in this tenant.
 */
export async function createProduct(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateProductInput,
  correlationId?: string
): Promise<ProductRecord> {
  if (input.categoryId !== null) {
    const category = await fetchCategoryById(tx, tenantId, input.categoryId);
    if (!category) throw new ProductCategoryNotFoundError();
  }

  let rows: ProductRow[];

  try {
    rows = (await tx`
      INSERT INTO awcms_commerce_products (
        tenant_id, category_id, type, sku, name, slug, description, digital_note,
        price, discount_percent, stock, status, label, label_color
      )
      VALUES (
        ${tenantId}, ${input.categoryId}, ${input.type}, ${input.sku}, ${input.name},
        ${input.slug}, ${input.description}, ${input.digitalNote},
        ${input.price}, ${input.discountPercent}, ${input.stock}, 'draft',
        ${input.label}, ${input.labelColor}
      )
      RETURNING id, category_id, type, sku, name, slug, description, digital_note,
                price, discount_percent, stock, status, label, label_color
    `) as ProductRow[];
  } catch (error) {
    if (error instanceof Bun.SQL.PostgresError) {
      if (
        String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
        error.constraint === PRODUCTS_SLUG_CONSTRAINT
      ) {
        throw new DuplicateProductSlugError(input.slug);
      }
      if (
        String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
        error.constraint === PRODUCTS_SKU_CONSTRAINT
      ) {
        throw new DuplicateProductSkuError(input.sku);
      }
    }

    // Anything else — including a 23503 from the category FK racing the
    // check above — propagates, same as `createOffice`'s equivalent comment.
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
    message: `Product created: ${record.sku}.`,
    attributes: { sku: record.sku, type: record.type },
    correlationId
  });

  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_PRODUCT_CREATED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_PRODUCT_AGGREGATE_TYPE,
    aggregateId: record.id,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: {
      productId: record.id,
      categoryId: record.categoryId,
      sku: record.sku,
      type: record.type
    }
  });

  return record;
}

/**
 * @throws {ProductCategoryNotFoundError} `categoryId` is set and does not
 *   resolve to a live category in this tenant.
 * @throws {IllegalProductStatusTransitionError} `status` is set and is not a
 *   legal transition from the product's current status.
 * @throws {DuplicateProductSlugError} `slug` is set and already taken.
 * @throws {DuplicateProductSkuError} `sku` is set and already taken.
 */
export async function updateProduct(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  productId: string,
  input: UpdateProductInput,
  correlationId?: string
): Promise<ProductRecord | null> {
  const existing = await fetchProductById(tx, tenantId, productId);
  if (!existing) return null;

  if (input.categoryId !== undefined && input.categoryId !== null) {
    const category = await fetchCategoryById(tx, tenantId, input.categoryId);
    if (!category) throw new ProductCategoryNotFoundError();
  }

  // `status` must be checked against PRODUCT_STATUSES and LEGAL_TRANSITIONS
  // BEFORE the UPDATE runs — ordering is load-bearing (see `createProduct`'s
  // comment on the category check): a throw mapped to 4xx must precede every
  // write, or `withTenant`'s normal-return commit would persist a partial
  // change alongside the rejected status.
  let nextStatus: ProductStatus = existing.status;
  if (input.status !== undefined) {
    if (!(PRODUCT_STATUSES as readonly string[]).includes(input.status)) {
      throw new IllegalProductStatusTransitionError([
        {
          field: "status",
          message: `status must be one of: ${PRODUCT_STATUSES.join(", ")}.`
        }
      ]);
    }

    const transition = applyProductStatus(
      existing.status,
      input.status as ProductStatus
    );
    if (!transition.valid) {
      throw new IllegalProductStatusTransitionError(transition.errors);
    }
    nextStatus = transition.value;
  }

  let rows: ProductRow[];

  try {
    rows = (await tx`
      UPDATE awcms_commerce_products
      SET
        category_id = ${input.categoryId === undefined ? existing.categoryId : input.categoryId},
        type = ${input.type ?? existing.type},
        sku = ${input.sku ?? existing.sku},
        name = ${input.name ?? existing.name},
        slug = ${input.slug ?? existing.slug},
        description = ${input.description === undefined ? existing.description : input.description},
        digital_note = ${input.digitalNote === undefined ? existing.digitalNote : input.digitalNote},
        price = ${input.price ?? existing.price},
        discount_percent = ${input.discountPercent ?? existing.discountPercent},
        stock = ${input.stock ?? existing.stock},
        status = ${nextStatus},
        label = ${input.label === undefined ? existing.label : input.label},
        label_color = ${input.labelColor === undefined ? existing.labelColor : input.labelColor},
        updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${productId} AND deleted_at IS NULL
      RETURNING id, category_id, type, sku, name, slug, description, digital_note,
                price, discount_percent, stock, status, label, label_color
    `) as ProductRow[];
  } catch (error) {
    if (error instanceof Bun.SQL.PostgresError) {
      if (
        String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
        error.constraint === PRODUCTS_SLUG_CONSTRAINT
      ) {
        throw new DuplicateProductSlugError(input.slug ?? existing.slug);
      }
      if (
        String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
        error.constraint === PRODUCTS_SKU_CONSTRAINT
      ) {
        throw new DuplicateProductSkuError(input.sku ?? existing.sku);
      }
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
    message: "Product updated.",
    attributes: { fields: Object.keys(input) },
    correlationId
  });

  // Two independent events can both fire from one PATCH: a caller may change
  // ordinary fields and the status in the same request, and each is its own
  // fact a consumer may care about separately (see `commerce-events.ts`'s
  // header on why `status_changed` is not folded into `updated`).
  const changedNonStatusFields = Object.keys(input).filter(
    (field) => field !== "status"
  );

  if (changedNonStatusFields.length > 0) {
    await appendDomainEvent(tx, tenantId, {
      eventType: COMMERCE_PRODUCT_UPDATED_EVENT_TYPE,
      eventVersion: COMMERCE_EVENT_VERSION,
      aggregateType: COMMERCE_PRODUCT_AGGREGATE_TYPE,
      aggregateId: record.id,
      producerModule: PRODUCER_MODULE,
      correlationId,
      actorTenantUserId,
      payload: { productId: record.id, fields: changedNonStatusFields }
    });
  }

  if (nextStatus !== existing.status) {
    await appendDomainEvent(tx, tenantId, {
      eventType: COMMERCE_PRODUCT_STATUS_CHANGED_EVENT_TYPE,
      eventVersion: COMMERCE_EVENT_VERSION,
      aggregateType: COMMERCE_PRODUCT_AGGREGATE_TYPE,
      aggregateId: record.id,
      producerModule: PRODUCER_MODULE,
      correlationId,
      actorTenantUserId,
      payload: {
        productId: record.id,
        previousStatus: existing.status,
        status: nextStatus
      }
    });
  }

  return record;
}

/**
 * Soft-deletes a live product: stamps `deleted_at` and audits the removal
 * (severity `warning`). Returns `false` when the id is absent, in another
 * tenant, or already soft-deleted. No domain event — same choice
 * `office-directory.ts`'s `softDeleteOffice` makes; a search index or
 * storefront cache reacts to `product.status_changed` (e.g. -> `archived`)
 * rather than to removal from the tenant's own admin view.
 *
 * No `reason`/`deleted_by` column, unlike `awcms_offices` — see
 * `category-directory.ts`'s `deleteCategory` for the same note.
 */
export async function deleteProduct(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  productId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_commerce_products
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${productId} AND deleted_at IS NULL
    RETURNING id
  `;

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "delete",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: productId,
    severity: "warning",
    message: "Product soft-deleted.",
    correlationId
  });

  return true;
}
