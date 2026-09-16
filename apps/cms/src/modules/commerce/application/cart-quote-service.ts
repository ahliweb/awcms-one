/**
 * Fetches the DB snapshot `domain/cart-quote.ts`'s pure `quoteCart` needs,
 * then calls it — Issue #29. Used by both the public
 * `POST …/storefront/cart/quote` route (read-only) and
 * `application/order-directory.ts`'s `createOrderFromCart` (re-quotes inside
 * the write transaction so the two paths can never disagree on price).
 *
 * Every query here is scoped to `tenant_id` explicitly (never relies on RLS
 * alone, per the ABAC/RLS defense-in-depth rule) and batches by id — never
 * N+1 — the same discipline `product-directory.ts`'s `attachProductRelations`
 * already follows.
 */
import { fetchStoreSettings } from "./store-settings-directory";
import type {
  MediaLibraryPort,
  ResolvedMediaReferenceDTO
} from "../../_shared/ports/media-library-port";
import { listLiveProductImagesByProductIds } from "./product-image-directory";
import {
  quoteCart,
  type CartQuoteContext,
  type CartQuoteFlashSaleSnapshot,
  type CartQuoteLineInput,
  type CartQuoteProductSnapshot,
  type CartQuoteResult,
  type CartQuoteShippingInput,
  type CartQuoteVariantSnapshot,
  type CartQuoteVoucherRowLookup
} from "../domain/cart-quote";
import type { ProductStatus } from "../domain/product-status";
import type { ServiceFormField } from "../domain/service-form-validation";

type ProductSnapshotRow = {
  id: string;
  slug: string;
  name: string;
  sku: string;
  price: string;
  discount_percent: number;
  stock: number;
  status: string;
  min_purchase: number;
  weight_grams: number;
  with_insurance: boolean;
  insurance_required: boolean;
  allow_dp: boolean;
  allow_free_shipping: boolean;
  service_form: ServiceFormField[] | null;
};

type VariantSnapshotRow = {
  id: string;
  product_id: string;
  value: string;
  sku: string | null;
  price: string | null;
  stock: number;
  weight_grams: number;
};

type FlashSaleSnapshotRow = {
  /** The `awcms_commerce_flash_sale_products` row's own id — NOT the flash sale's id (that is `flash_sale_id` below). Kept only because a batch caller might want it later; `flashSaleId` on the mapped snapshot always comes from `flash_sale_id`. */
  id: string;
  flash_sale_id: string;
  product_id: string;
  variant_id: string | null;
  sale_price: string;
  quota: number;
  sold: number;
};

async function fetchProductSnapshots(
  tx: Bun.SQL,
  tenantId: string,
  productIds: readonly string[]
): Promise<Map<string, ProductSnapshotRow>> {
  const map = new Map<string, ProductSnapshotRow>();
  if (productIds.length === 0) return map;

  const rows = (await tx`
    SELECT id, slug, name, sku, price, discount_percent, stock, status,
           min_purchase, weight_grams, with_insurance, insurance_required,
           allow_dp, allow_free_shipping, service_form
    FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId}
      AND id = ANY(${tx.array([...new Set(productIds)], "uuid")}::uuid[])
      AND deleted_at IS NULL
  `) as ProductSnapshotRow[];

  for (const row of rows) map.set(row.id, row);
  return map;
}

async function fetchVariantSnapshots(
  tx: Bun.SQL,
  tenantId: string,
  variantIds: readonly string[]
): Promise<Map<string, VariantSnapshotRow>> {
  const map = new Map<string, VariantSnapshotRow>();
  if (variantIds.length === 0) return map;

  const rows = (await tx`
    SELECT id, product_id, value, sku, price, stock, weight_grams
    FROM awcms_commerce_product_variants
    WHERE tenant_id = ${tenantId}
      AND id = ANY(${tx.array([...new Set(variantIds)], "uuid")}::uuid[])
      AND deleted_at IS NULL
  `) as VariantSnapshotRow[];

  for (const row of rows) map.set(row.id, row);
  return map;
}

/** Active-window flash sales covering any of `productIds` — same `deriveFlashSaleStatus` rule `listActiveFlashSalesPublic` uses, inlined here since this query also needs the RAW `quota`/`sold` the public read model does not expose. */
async function fetchActiveFlashSaleSnapshots(
  tx: Bun.SQL,
  tenantId: string,
  productIds: readonly string[],
  now: Date
): Promise<Map<string, FlashSaleSnapshotRow>> {
  const map = new Map<string, FlashSaleSnapshotRow>();
  if (productIds.length === 0) return map;

  const rows = (await tx`
    SELECT fsp.id, fsp.flash_sale_id, fsp.product_id, fsp.variant_id, fsp.sale_price, fsp.quota, fsp.sold
    FROM awcms_commerce_flash_sale_products fsp
    JOIN awcms_commerce_flash_sales fs ON fs.id = fsp.flash_sale_id
    WHERE fsp.tenant_id = ${tenantId}
      AND fsp.deleted_at IS NULL
      AND fs.deleted_at IS NULL
      AND fs.status IN ('scheduled', 'active')
      AND fs.starts_at <= ${now}
      AND fs.ends_at >= ${now}
      AND fsp.product_id = ANY(${tx.array([...new Set(productIds)], "uuid")}::uuid[])
  `) as FlashSaleSnapshotRow[];

  for (const row of rows) {
    map.set(`${row.product_id}:${row.variant_id ?? ""}`, row);
  }
  return map;
}

async function fetchVoucherRow(
  tx: Bun.SQL,
  tenantId: string,
  code: string
): Promise<CartQuoteVoucherRowLookup> {
  const normalizedCode = code.trim().toUpperCase();
  const rows = (await tx`
    SELECT type, value, min_order, max_discount, quota, used_count, starts_at, ends_at
    FROM awcms_commerce_vouchers
    WHERE tenant_id = ${tenantId} AND code = ${normalizedCode}
      AND deleted_at IS NULL AND status = 'active'
  `) as {
    type: string;
    value: string;
    min_order: string;
    max_discount: string | null;
    quota: number;
    used_count: number;
    starts_at: Date;
    ends_at: Date;
  }[];

  const row = rows[0];
  if (!row) return { found: false };

  return {
    found: true,
    row: {
      type: row.type as "percentage" | "nominal" | "free_shipping",
      value: row.value,
      minOrder: row.min_order,
      maxDiscount: row.max_discount,
      quota: row.quota,
      usedCount: row.used_count,
      startsAt: row.starts_at,
      endsAt: row.ends_at
    }
  };
}

/**
 * Builds a {@link CartQuoteContext} for exactly the products/variants named
 * in `lines`, then runs the pure `quoteCart`. Exported so
 * `order-directory.ts` can call it a second time, inside its own write
 * transaction, for the authoritative pre-write re-quote.
 */
export async function buildCartQuote(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  input: {
    lines: CartQuoteLineInput[];
    shipping: CartQuoteShippingInput;
    voucherCode: string | null;
    insurance: boolean;
  },
  now: Date = new Date()
): Promise<CartQuoteResult> {
  const productIds = input.lines.map((line) => line.productId);
  const variantIds = input.lines
    .map((line) => line.variantId)
    .filter((id): id is string => id !== null);

  // Sequential, never `Promise.all` — `tx` is ONE reserved connection
  // (`tenant-route.ts`'s header: concurrent queries on one connection desync
  // it and strand the session holding its work-class slot).
  const productRows = await fetchProductSnapshots(tx, tenantId, productIds);
  const variantRows = await fetchVariantSnapshots(tx, tenantId, variantIds);
  const flashSaleRows = await fetchActiveFlashSaleSnapshots(
    tx,
    tenantId,
    productIds,
    now
  );
  const storeSettings = await fetchStoreSettings(tx, tenantId);

  const imageRows = await listLiveProductImagesByProductIds(tx, tenantId, [
    ...productRows.keys()
  ]);
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

  const products = new Map<string, CartQuoteProductSnapshot>();
  for (const [id, row] of productRows) {
    const mediaObjectId = firstImageMediaIdByProduct.get(id);
    const resolved = mediaObjectId
      ? resolvedMedia.get(mediaObjectId)
      : undefined;
    products.set(id, {
      id: row.id,
      slug: row.slug,
      name: row.name,
      sku: row.sku,
      price: row.price,
      discountPercent: row.discount_percent,
      stock: row.stock,
      status: row.status as ProductStatus,
      minPurchase: row.min_purchase,
      weightGrams: row.weight_grams,
      withInsurance: row.with_insurance,
      insuranceRequired: row.insurance_required,
      allowDp: row.allow_dp,
      allowFreeShipping: row.allow_free_shipping,
      serviceForm: row.service_form,
      imageUrl: resolved?.publicUrl ?? null,
      imageAlt: resolved?.altText ?? null
    });
  }

  const variants = new Map<string, CartQuoteVariantSnapshot>();
  for (const [id, row] of variantRows) {
    variants.set(id, {
      id: row.id,
      productId: row.product_id,
      value: row.value,
      sku: row.sku,
      price: row.price,
      stock: row.stock,
      weightGrams: row.weight_grams
    });
  }

  const flashSales = new Map<string, CartQuoteFlashSaleSnapshot>();
  for (const [key, row] of flashSaleRows) {
    flashSales.set(key, {
      flashSaleId: row.flash_sale_id,
      productId: row.product_id,
      variantId: row.variant_id,
      salePrice: row.sale_price,
      quota: row.quota,
      sold: row.sold
    });
  }

  const voucher = input.voucherCode
    ? {
        code: input.voucherCode,
        lookup: await fetchVoucherRow(tx, tenantId, input.voucherCode)
      }
    : null;

  const context: CartQuoteContext = {
    products,
    variants,
    flashSales,
    storeSettings,
    voucher,
    now
  };

  return quoteCart(
    {
      lines: input.lines,
      shipping: input.shipping,
      insurance: input.insurance
    },
    context
  );
}
