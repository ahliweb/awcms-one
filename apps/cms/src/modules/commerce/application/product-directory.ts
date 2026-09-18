import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  keysetCursorCreatedAtSql,
  encodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import type {
  MediaLibraryPort,
  ResolvedMediaReferenceDTO
} from "../../_shared/ports/media-library-port";
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
import { computeFinalPrice, normalizeMoney } from "../domain/price-calculation";
import { reconcileSizeChart, type SizeChartType } from "../domain/size-chart";
import type { SubscriptionPeriod } from "../domain/subscription-period";
import type { ServiceFormField } from "../domain/service-form-validation";
import type { VariantAttributeGroup } from "../domain/variant-attributes-validation";
import type { ProductSort } from "../domain/product-sort";
import { fetchCategoryById } from "./category-directory";
import {
  listLiveProductImagesByProductIds,
  type ProductImageRow
} from "./product-image-directory";
import {
  listLiveProductVariantsByProductIds,
  type ProductVariantRow
} from "./product-variant-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "product";
const PRODUCER_MODULE = "commerce";

/** Same bound as `office-directory.ts`'s `OFFICE_LIST_LIMIT` — see its comment. */
export const PRODUCT_LIST_LIMIT = 100;

/**
 * `(tenant_id, slug)` is unique among LIVE products
 * (`awcms_commerce_products_tenant_slug_key`, `sql/901`).
 */
export class DuplicateProductSlugError extends Error {
  constructor(slug: string) {
    super(`A product with slug "${slug}" already exists for this tenant.`);
    this.name = "DuplicateProductSlugError";
  }
}

/**
 * `(tenant_id, sku)` is unique among LIVE products
 * (`awcms_commerce_products_tenant_sku_key`, `sql/901`). A separate error type
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

/**
 * `updateProduct`'s merged next-state (existing row patched by the request)
 * fails `domain/size-chart.ts`'s `reconcileSizeChart` cross-field rule — e.g.
 * the request sets `sizeChartType: "image"` without ever having set
 * `sizeChartMediaId` (on this request OR a previous one). Same "check the
 * next state before the write, throw a 4xx-shaped error" rule
 * `IllegalProductStatusTransitionError` follows.
 */
export class InvalidSizeChartFieldsError extends Error {
  public readonly errors: { field: string; message: string }[];

  constructor(errors: { field: string; message: string }[]) {
    super(errors.map((error) => error.message).join(" "));
    this.name = "InvalidSizeChartFieldsError";
    this.errors = errors;
  }
}

const POSTGRES_UNIQUE_VIOLATION = "23505";
const PRODUCTS_SLUG_CONSTRAINT = "awcms_commerce_products_tenant_slug_key";
const PRODUCTS_SKU_CONSTRAINT = "awcms_commerce_products_tenant_sku_key";

/**
 * Every column `awcms_commerce_products` carries, reused across every
 * SELECT/RETURNING below so the column list is declared exactly once
 * (same convention `media-object-directory.ts`'s `SELECT_COLUMNS` follows).
 */
const PRODUCT_COLUMNS = `
  id, category_id, type, sku, name, slug, description, digital_note,
  price, discount_percent, stock, status, label, label_color,
  price_level_2, price_level_3, price_level_4, cost_price,
  min_purchase, weight_grams, manual_rating, manual_sold_count,
  with_insurance, insurance_required, insurance_fee,
  promo_banner_show, promo_banner_title, promo_banner_subtitle,
  promo_banner_badge, promo_banner_icon, promo_banner_color,
  size_chart_type, size_chart_media_id, size_chart_details,
  service_form, subscription_period, download_link,
  allow_dp, allow_free_shipping, variant_attributes,
  is_featured, is_recommended
`;

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
  price_level_2: string | null;
  price_level_3: string | null;
  price_level_4: string | null;
  cost_price: string | null;
  min_purchase: number;
  weight_grams: number;
  manual_rating: string | null;
  manual_sold_count: number;
  with_insurance: boolean;
  insurance_required: boolean;
  insurance_fee: string | null;
  promo_banner_show: boolean;
  promo_banner_title: string | null;
  promo_banner_subtitle: string | null;
  promo_banner_badge: string | null;
  promo_banner_icon: string | null;
  promo_banner_color: string | null;
  size_chart_type: string;
  size_chart_media_id: string | null;
  size_chart_details: unknown | null;
  service_form: ServiceFormField[] | null;
  subscription_period: string | null;
  download_link: string | null;
  allow_dp: boolean;
  allow_free_shipping: boolean;
  variant_attributes: VariantAttributeGroup[] | null;
  is_featured: boolean;
  is_recommended: boolean;
};

/**
 * The public wire shape — `CommerceProduct` (Issue #4, extended to full
 * parity by Issue #23). `price`/`priceLevel2/3/4`/`finalPrice`/`insuranceFee`
 * stay the STRING `Bun.SQL` hands back for a `numeric` column — never
 * `Number(...)`'d (ADR-0003). `costPrice` is deliberately ABSENT — see
 * `ProductAdminRecord` below and `sql/904`'s header. No
 * `createdAt`/`updatedAt`/`deletedAt`/`restoredAt`: on the row for
 * auditing/soft-delete, deliberately outside the contract.
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
  priceLevel2: string | null;
  priceLevel3: string | null;
  priceLevel4: string | null;
  minPurchase: number;
  weightGrams: number;
  manualRating: string | null;
  manualSoldCount: number;
  withInsurance: boolean;
  insuranceRequired: boolean;
  insuranceFee: string | null;
  promoBannerShow: boolean;
  promoBannerTitle: string | null;
  promoBannerSubtitle: string | null;
  promoBannerBadge: string | null;
  promoBannerIcon: string | null;
  promoBannerColor: string | null;
  sizeChartType: SizeChartType;
  sizeChartMediaId: string | null;
  sizeChartDetails: unknown | null;
  serviceForm: ServiceFormField[] | null;
  subscriptionPeriod: SubscriptionPeriod | null;
  allowDp: boolean;
  allowFreeShipping: boolean;
  variantAttributes: VariantAttributeGroup[] | null;
  isFeatured: boolean;
  isRecommended: boolean;
  /** `price` after `discountPercent` off — `domain/price-calculation.ts`, never a float. */
  finalPrice: string;
  /** = `manualRating` (Issue #23 — "until #29 lands reviews/orders"). */
  averageRating: string | null;
  /** = `manualSoldCount`. */
  soldCount: number;
};

/**
 * Admin-only superset of {@link ProductRecord} that additionally carries
 * `costPrice` — Issue #23's table says "never in the public DTO"; this type
 * exists so that promise is a TYPE distinction (what a public API route may
 * return) rather than a convention every route author has to remember to
 * honour by hand. Used only by `src/pages/admin/commerce.astro`.
 */
export type ProductAdminRecord = ProductRecord & {
  costPrice: string | null;
  /**
   * A digital product's download link — the thing a customer PAYS for
   * (`type: "digital"`). Issue #26 moved it off the public `ProductRecord`
   * after the manager's review of #37: on the catalog read model it would
   * have handed every reader the paid asset for free. It is delivered to a
   * customer only through the order path (Issue #29), never through the
   * catalog. Same TYPE-level enforcement `costPrice` gets, for the same
   * reason: a public route cannot return it by accident.
   */
  downloadLink: string | null;
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
    price: normalizeMoney(row.price),
    discountPercent: row.discount_percent,
    stock: row.stock,
    status: row.status as ProductStatus,
    label: row.label,
    labelColor: row.label_color,
    priceLevel2: normalizeMoney(row.price_level_2),
    priceLevel3: normalizeMoney(row.price_level_3),
    priceLevel4: normalizeMoney(row.price_level_4),
    minPurchase: row.min_purchase,
    weightGrams: row.weight_grams,
    manualRating: row.manual_rating,
    manualSoldCount: row.manual_sold_count,
    withInsurance: row.with_insurance,
    insuranceRequired: row.insurance_required,
    insuranceFee: normalizeMoney(row.insurance_fee),
    promoBannerShow: row.promo_banner_show,
    promoBannerTitle: row.promo_banner_title,
    promoBannerSubtitle: row.promo_banner_subtitle,
    promoBannerBadge: row.promo_banner_badge,
    promoBannerIcon: row.promo_banner_icon,
    promoBannerColor: row.promo_banner_color,
    sizeChartType: row.size_chart_type as SizeChartType,
    sizeChartMediaId: row.size_chart_media_id,
    sizeChartDetails: row.size_chart_details,
    serviceForm: row.service_form,
    subscriptionPeriod: row.subscription_period as SubscriptionPeriod | null,
    allowDp: row.allow_dp,
    allowFreeShipping: row.allow_free_shipping,
    variantAttributes: row.variant_attributes,
    isFeatured: row.is_featured,
    isRecommended: row.is_recommended,
    finalPrice: computeFinalPrice(row.price, row.discount_percent),
    averageRating: row.manual_rating,
    soldCount: row.manual_sold_count
  };
}

function toAdminRecord(row: ProductRow): ProductAdminRecord {
  return {
    ...toRecord(row),
    costPrice: normalizeMoney(row.cost_price),
    downloadLink: row.download_link
  };
}

/** `GET /api/v1/commerce/products` query filters — see `domain/product-sort.ts`'s header for the `sort` values. */
export type ProductListFilters = {
  categoryId?: string | null;
  status?: ProductStatus;
  q?: string;
  sort?: ProductSort;
  featured?: boolean;
  recommended?: boolean;
};

/**
 * One literal `ORDER BY` clause per {@link ProductSort} value — never built
 * from the request string directly, so there is no path from caller input to
 * arbitrary SQL text. `price_asc`/`price_desc` sort the STORED `price`, never
 * `finalPrice` — see `domain/product-sort.ts`'s header for why.
 */
const ORDER_BY_SQL: Record<ProductSort, string> = {
  newest: "created_at DESC, id DESC",
  price_asc: "price ASC, id ASC",
  price_desc: "price DESC, id ASC",
  name: "name ASC, id ASC"
};

/** Escapes `\`, `%`, `_` so a caller's search term cannot smuggle in `LIKE` wildcards of its own. */
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

async function queryProductRows(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null,
  filters: ProductListFilters
): Promise<{ rows: ProductRow[]; nextCursor: string | null }> {
  const sort = filters.sort ?? "newest";
  const categoryIdParam = filters.categoryId ?? null;
  const statusParam = filters.status ?? null;
  const featuredParam = filters.featured ?? null;
  const recommendedParam = filters.recommended ?? null;
  const qLike =
    filters.q && filters.q.trim().length > 0
      ? `%${escapeLikeTerm(filters.q.trim())}%`
      : null;

  // Keyset pagination stays scoped to `sort=newest` — see `ORDER_BY_SQL`'s
  // comment. A cursor supplied alongside any other sort is rejected by the
  // ROUTE (400) before this ever runs, so treating it as "no cursor" here is
  // unreachable defence, not the primary guard.
  const cursorCreatedAt =
    sort === "newest" ? (cursor?.createdAt ?? null) : null;
  const cursorId = sort === "newest" ? (cursor?.id ?? null) : null;

  const rows = (await tx`
    SELECT ${tx.unsafe(PRODUCT_COLUMNS)},
           ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND (${categoryIdParam}::uuid IS NULL OR category_id = ${categoryIdParam}::uuid)
      AND (${statusParam}::text IS NULL OR status = ${statusParam})
      AND (${featuredParam}::boolean IS NULL OR is_featured = ${featuredParam})
      AND (${recommendedParam}::boolean IS NULL OR is_recommended = ${recommendedParam})
      AND (
        ${qLike}::text IS NULL
        OR name ILIKE ${qLike} ESCAPE '\\'
        OR sku ILIKE ${qLike} ESCAPE '\\'
      )
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY ${tx.unsafe(ORDER_BY_SQL[sort])}
    LIMIT ${PRODUCT_LIST_LIMIT}
  `) as (ProductRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  const nextCursor =
    sort === "newest" && rows.length === PRODUCT_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { rows, nextCursor };
}

export type ProductListPage = {
  items: ProductRecord[];
  nextCursor: string | null;
};

/** One filtered, sorted, keyset-paginated page of live products — public shape (no `costPrice`). */
export async function listProducts(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null = null,
  filters: ProductListFilters = {}
): Promise<ProductListPage> {
  const { rows, nextCursor } = await queryProductRows(
    tx,
    tenantId,
    cursor,
    filters
  );
  return { items: rows.map(toRecord), nextCursor };
}

export type ProductAdminListPage = {
  items: ProductAdminRecord[];
  nextCursor: string | null;
};

/** As {@link listProducts}, but includes `costPrice` — `src/pages/admin/commerce.astro` only. */
export async function listProductsForAdmin(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null = null,
  filters: ProductListFilters = {}
): Promise<ProductAdminListPage> {
  const { rows, nextCursor } = await queryProductRows(
    tx,
    tenantId,
    cursor,
    filters
  );
  return { items: rows.map(toAdminRecord), nextCursor };
}

export async function fetchProductById(
  tx: Bun.SQL,
  tenantId: string,
  productId: string
): Promise<ProductRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(PRODUCT_COLUMNS)}
    FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND id = ${productId} AND deleted_at IS NULL
  `) as ProductRow[];

  return rows[0] ? toRecord(rows[0]) : null;
}

/** As {@link fetchProductById}, but includes `costPrice` — admin edit-form prefill only. */
export async function fetchProductByIdForAdmin(
  tx: Bun.SQL,
  tenantId: string,
  productId: string
): Promise<ProductAdminRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(PRODUCT_COLUMNS)}
    FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND id = ${productId} AND deleted_at IS NULL
  `) as ProductRow[];

  return rows[0] ? toAdminRecord(rows[0]) : null;
}

/** `GET /api/v1/commerce/products/by-slug/{slug}` — the storefront's detail fetch by URL key. */
export async function fetchProductBySlug(
  tx: Bun.SQL,
  tenantId: string,
  slug: string
): Promise<ProductRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(PRODUCT_COLUMNS)}
    FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND slug = ${slug} AND deleted_at IS NULL
  `) as ProductRow[];

  return rows[0] ? toRecord(rows[0]) : null;
}

/** Fetches a product regardless of `deleted_at` — `restoreProduct`'s own lookup, and nothing else. */
async function fetchProductRowIncludingDeleted(
  tx: Bun.SQL,
  tenantId: string,
  productId: string
): Promise<ProductRow | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(PRODUCT_COLUMNS)}
    FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND id = ${productId}
  `) as ProductRow[];

  return rows[0] ?? null;
}

/**
 * Public row insert fields shared by `INSERT`/`RETURNING` — kept close to
 * `createProduct` since (unlike `PRODUCT_COLUMNS`) it names VALUES, not a
 * plain column list.
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
        price, discount_percent, stock, status, label, label_color,
        price_level_2, price_level_3, price_level_4, cost_price,
        min_purchase, weight_grams, manual_rating, manual_sold_count,
        with_insurance, insurance_required, insurance_fee,
        promo_banner_show, promo_banner_title, promo_banner_subtitle,
        promo_banner_badge, promo_banner_icon, promo_banner_color,
        size_chart_type, size_chart_media_id, size_chart_details,
        service_form, subscription_period, download_link,
        allow_dp, allow_free_shipping, variant_attributes,
        is_featured, is_recommended
      )
      VALUES (
        ${tenantId}, ${input.categoryId}, ${input.type}, ${input.sku}, ${input.name},
        ${input.slug}, ${input.description}, ${input.digitalNote},
        ${input.price}, ${input.discountPercent}, ${input.stock}, 'draft',
        ${input.label}, ${input.labelColor},
        ${input.priceLevel2}, ${input.priceLevel3}, ${input.priceLevel4}, ${input.costPrice},
        ${input.minPurchase}, ${input.weightGrams}, ${input.manualRating}, ${input.manualSoldCount},
        ${input.withInsurance}, ${input.insuranceRequired}, ${input.insuranceFee},
        ${input.promoBannerShow}, ${input.promoBannerTitle}, ${input.promoBannerSubtitle},
        ${input.promoBannerBadge}, ${input.promoBannerIcon}, ${input.promoBannerColor},
        ${input.sizeChartType}, ${input.sizeChartMediaId}, ${input.sizeChartDetails}::jsonb,
        ${input.serviceForm}::jsonb, ${input.subscriptionPeriod}, ${input.downloadLink},
        ${input.allowDp}, ${input.allowFreeShipping}, ${input.variantAttributes}::jsonb,
        ${input.isFeatured}, ${input.isRecommended}
      )
      RETURNING ${tx.unsafe(PRODUCT_COLUMNS)}
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
 * @throws {InvalidSizeChartFieldsError} the MERGED next state (existing row
 *   patched by `input`) fails `reconcileSizeChart`'s cross-field rule.
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
  // The ADMIN fetch (includes `costPrice`) so the `COALESCE`-by-hand pattern
  // below can preserve it on a patch that never mentions it — `costPrice` is
  // absent from the public `ProductRecord`, but the UPDATE still has to
  // leave it untouched when the caller does not send it.
  const existing = await fetchProductByIdForAdmin(tx, tenantId, productId);
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

  // Same load-bearing-ordering rule as `status` above: the merged next state
  // is checked BEFORE the UPDATE runs.
  const sizeChart = reconcileSizeChart({
    sizeChartType: input.sizeChartType ?? existing.sizeChartType,
    sizeChartMediaId:
      input.sizeChartMediaId !== undefined
        ? input.sizeChartMediaId
        : existing.sizeChartMediaId,
    sizeChartDetails:
      input.sizeChartDetails !== undefined
        ? input.sizeChartDetails
        : existing.sizeChartDetails
  });
  if (!sizeChart.valid) {
    throw new InvalidSizeChartFieldsError(sizeChart.errors);
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
        price_level_2 = ${input.priceLevel2 === undefined ? existing.priceLevel2 : input.priceLevel2},
        price_level_3 = ${input.priceLevel3 === undefined ? existing.priceLevel3 : input.priceLevel3},
        price_level_4 = ${input.priceLevel4 === undefined ? existing.priceLevel4 : input.priceLevel4},
        cost_price = ${input.costPrice === undefined ? existing.costPrice : input.costPrice},
        min_purchase = ${input.minPurchase ?? existing.minPurchase},
        weight_grams = ${input.weightGrams ?? existing.weightGrams},
        manual_rating = ${input.manualRating === undefined ? existing.manualRating : input.manualRating},
        manual_sold_count = ${input.manualSoldCount ?? existing.manualSoldCount},
        with_insurance = ${input.withInsurance ?? existing.withInsurance},
        insurance_required = ${input.insuranceRequired ?? existing.insuranceRequired},
        insurance_fee = ${input.insuranceFee === undefined ? existing.insuranceFee : input.insuranceFee},
        promo_banner_show = ${input.promoBannerShow ?? existing.promoBannerShow},
        promo_banner_title = ${input.promoBannerTitle === undefined ? existing.promoBannerTitle : input.promoBannerTitle},
        promo_banner_subtitle = ${input.promoBannerSubtitle === undefined ? existing.promoBannerSubtitle : input.promoBannerSubtitle},
        promo_banner_badge = ${input.promoBannerBadge === undefined ? existing.promoBannerBadge : input.promoBannerBadge},
        promo_banner_icon = ${input.promoBannerIcon === undefined ? existing.promoBannerIcon : input.promoBannerIcon},
        promo_banner_color = ${input.promoBannerColor === undefined ? existing.promoBannerColor : input.promoBannerColor},
        size_chart_type = ${sizeChart.value.sizeChartType},
        size_chart_media_id = ${sizeChart.value.sizeChartMediaId},
        size_chart_details = ${sizeChart.value.sizeChartDetails}::jsonb,
        service_form = ${input.serviceForm === undefined ? existing.serviceForm : input.serviceForm}::jsonb,
        subscription_period = ${input.subscriptionPeriod === undefined ? existing.subscriptionPeriod : input.subscriptionPeriod},
        download_link = ${input.downloadLink === undefined ? existing.downloadLink : input.downloadLink},
        allow_dp = ${input.allowDp ?? existing.allowDp},
        allow_free_shipping = ${input.allowFreeShipping ?? existing.allowFreeShipping},
        variant_attributes = ${input.variantAttributes === undefined ? existing.variantAttributes : input.variantAttributes}::jsonb,
        is_featured = ${input.isFeatured ?? existing.isFeatured},
        is_recommended = ${input.isRecommended ?? existing.isRecommended},
        updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${productId} AND deleted_at IS NULL
      RETURNING ${tx.unsafe(PRODUCT_COLUMNS)}
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

/**
 * The tenant's soft-deleted products, newest-deleted first — `src/pages/admin
 * /commerce.astro`'s "Deleted products" section, so a viewer holding
 * `products.restore` has something to restore. Same shape as
 * `office-directory.ts`'s `listDeletedOffices`; a plain top-N list rather
 * than keyset-paginated, since Issue #4/#23 never pagination-tested the
 * deleted set (it is expected to be small relative to the live catalog).
 */
export async function listDeletedProductsForAdmin(
  tx: Bun.SQL,
  tenantId: string
): Promise<ProductAdminRecord[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(PRODUCT_COLUMNS)}
    FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND deleted_at IS NOT NULL
    ORDER BY deleted_at DESC, id DESC
    LIMIT ${PRODUCT_LIST_LIMIT}
  `) as ProductRow[];

  return rows.map(toAdminRecord);
}

/**
 * Restores a soft-deleted product (Issue #23) — `office-directory.ts`'s
 * `restoreOffice` shape, adapted to this module's columns: no
 * `deleted_by`/`delete_reason`/`restored_by` (this module carries no
 * actor-stamp columns at all, `sql/901`'s header), so this only clears
 * `deleted_at` and stamps `restored_at`. Returns `null` when the id is
 * absent, in another tenant, or NOT currently soft-deleted (idempotent-safe:
 * a repeat restore is a "not found", never a silent no-op success).
 *
 * @throws {DuplicateProductSlugError} another LIVE product has since taken
 *   this product's slug.
 * @throws {DuplicateProductSkuError} another LIVE product has since taken
 *   this product's sku.
 */
export async function restoreProduct(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  productId: string,
  correlationId?: string
): Promise<ProductRecord | null> {
  const existing = await fetchProductRowIncludingDeleted(
    tx,
    tenantId,
    productId
  );
  if (!existing) return null;

  let rows: ProductRow[];

  try {
    rows = (await tx`
      UPDATE awcms_commerce_products
      SET deleted_at = NULL, restored_at = now(), updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${productId} AND deleted_at IS NOT NULL
      RETURNING ${tx.unsafe(PRODUCT_COLUMNS)}
    `) as ProductRow[];
  } catch (error) {
    if (error instanceof Bun.SQL.PostgresError) {
      if (
        String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
        error.constraint === PRODUCTS_SLUG_CONSTRAINT
      ) {
        throw new DuplicateProductSlugError(existing.slug);
      }
      if (
        String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
        error.constraint === PRODUCTS_SKU_CONSTRAINT
      ) {
        throw new DuplicateProductSkuError(existing.sku);
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
    message: "Product restored.",
    correlationId
  });

  return record;
}

// ---------------------------------------------------------------------------
// Relations composition — images[] / variants[], resolved through
// MediaLibraryPort. Kept in this file (rather than a separate module) because
// it is the one place `ProductRecord` is widened into the shape a GET route
// actually answers with, and every caller of it already imports this file.
// ---------------------------------------------------------------------------

export type ProductImageDTO = {
  id: string;
  productId: string;
  mediaObjectId: string;
  publicUrl: string | null;
  altText: string | null;
  sortOrder: number;
};

export type ProductVariantDTO = {
  id: string;
  productId: string;
  name: string;
  value: string;
  colorHex: string | null;
  imageMediaObjectId: string | null;
  imageUrl: string | null;
  sku: string | null;
  price: string | null;
  priceLevel2: string | null;
  priceLevel3: string | null;
  priceLevel4: string | null;
  stock: number;
  weightGrams: number;
  sortOrder: number;
};

export type ProductWithRelations = ProductRecord & {
  images: ProductImageDTO[];
  variants: ProductVariantDTO[];
  /**
   * `sizeChartMediaId` resolved to a public URL through the same
   * `MediaLibraryPort` batch that resolves `images[]`/`variants[]` (Issue
   * #26, a #23 follow-up): a storefront with no media client of its own can
   * render an image size chart from the DTO alone. `null` when the type is
   * not `image`, no media id is set, or the object is not publicly
   * resolvable — the same three-way silence `images[].publicUrl` keeps.
   */
  sizeChartImageUrl: string | null;
};

function toImageDTO(
  row: ProductImageRow,
  resolved: ReadonlyMap<string, ResolvedMediaReferenceDTO>
): ProductImageDTO {
  return {
    id: row.id,
    productId: row.product_id,
    mediaObjectId: row.media_object_id,
    publicUrl: resolved.get(row.media_object_id)?.publicUrl ?? null,
    altText: row.alt_text,
    sortOrder: row.sort_order
  };
}

function toVariantDTO(
  row: ProductVariantRow,
  resolved: ReadonlyMap<string, ResolvedMediaReferenceDTO>
): ProductVariantDTO {
  return {
    id: row.id,
    productId: row.product_id,
    name: row.name,
    value: row.value,
    colorHex: row.color_hex,
    imageMediaObjectId: row.image_media_object_id,
    imageUrl: row.image_media_object_id
      ? (resolved.get(row.image_media_object_id)?.publicUrl ?? null)
      : null,
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

/**
 * Batch-attaches `images[]`/`variants[]` to every product in `products` —
 * ONE round trip each for images, variants, and media resolution, regardless
 * of how many products are in the page (never N+1). GET routes only
 * (list/detail/by-slug); create/update/delete/restore return the plain
 * {@link ProductRecord} — a freshly mutated product's relations have not
 * changed as a side effect of that call.
 */
export async function attachProductRelations(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  products: readonly ProductRecord[]
): Promise<ProductWithRelations[]> {
  if (products.length === 0) return [];

  // Sequential, never `Promise.all` — `tx` is ONE reserved connection
  // (`tenant-route.ts`'s header: concurrent queries on one connection desync
  // it and strand the session holding its work-class slot).
  const productIds = products.map((product) => product.id);
  const imageRows = await listLiveProductImagesByProductIds(
    tx,
    tenantId,
    productIds
  );
  const variantRows = await listLiveProductVariantsByProductIds(
    tx,
    tenantId,
    productIds
  );

  const mediaObjectIds = new Set<string>();
  for (const image of imageRows) mediaObjectIds.add(image.media_object_id);
  for (const variant of variantRows) {
    if (variant.image_media_object_id) {
      mediaObjectIds.add(variant.image_media_object_id);
    }
  }
  for (const product of products) {
    if (product.sizeChartType === "image" && product.sizeChartMediaId) {
      mediaObjectIds.add(product.sizeChartMediaId);
    }
  }

  const resolvedMedia =
    mediaObjectIds.size > 0
      ? await mediaPort.resolveMediaReferences(tx, tenantId, [
          ...mediaObjectIds
        ])
      : new Map<string, ResolvedMediaReferenceDTO>();

  const imagesByProduct = new Map<string, ProductImageDTO[]>();
  for (const row of imageRows) {
    const list = imagesByProduct.get(row.product_id) ?? [];
    list.push(toImageDTO(row, resolvedMedia));
    imagesByProduct.set(row.product_id, list);
  }

  const variantsByProduct = new Map<string, ProductVariantDTO[]>();
  for (const row of variantRows) {
    const list = variantsByProduct.get(row.product_id) ?? [];
    list.push(toVariantDTO(row, resolvedMedia));
    variantsByProduct.set(row.product_id, list);
  }

  return products.map((product) => ({
    ...product,
    images: imagesByProduct.get(product.id) ?? [],
    variants: variantsByProduct.get(product.id) ?? [],
    sizeChartImageUrl:
      product.sizeChartType === "image" && product.sizeChartMediaId
        ? (resolvedMedia.get(product.sizeChartMediaId)?.publicUrl ?? null)
        : null
  }));
}
