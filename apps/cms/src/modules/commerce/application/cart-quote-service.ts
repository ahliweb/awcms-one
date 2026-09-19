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
  type CartQuoteCourierContext,
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
import { resolveShippingRateProvider } from "../infrastructure/shipping-rate-provider-resolver";
import {
  findCachedDestinationId,
  findCachedRatesForCouriers,
  getCourierRates
} from "./shipping-rate-directory";

/** `shipping-rate-provider-resolver.ts` resolves the concrete provider from `COMMERCE_SHIPPING_RATE_PROVIDER`; this is the same value used as the cache's own `provider` column. */
function resolveShippingRateProviderKey(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const provider = env.COMMERCE_SHIPPING_RATE_PROVIDER;
  return provider === "rajaongkir" || provider === "log" ? provider : null;
}

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

/** Cart weight BEFORE `quoteCart` resolves lines — needed to fetch courier rates (bucketed by weight), which must happen before the pure `quoteCart` call. Uses the same "variant weight if present, else product weight" rule `resolveLine` uses; does not apply status/stock filtering (an estimate, not a priced line). */
function estimateWeightGrams(
  lines: CartQuoteLineInput[],
  products: Map<string, ProductSnapshotRow>,
  variants: Map<string, VariantSnapshotRow>
): number {
  return lines.reduce((sum, line) => {
    const variant = line.variantId ? variants.get(line.variantId) : undefined;
    const product = products.get(line.productId);
    const weightGrams = variant
      ? variant.weight_grams
      : (product?.weight_grams ?? 0);
    return sum + weightGrams * Math.max(line.quantity, 0);
  }, 0);
}

/**
 * Issue #107 — resolves `context.courier` for `quoteCart`. `providerSql`,
 * when present, means the caller may call the provider (the public quote
 * route only); when absent (`order-directory.ts`'s re-quote, running inside
 * its own write transaction), only ALREADY-cached rates are considered —
 * never a live provider call from inside a DB transaction (ADR-0006/0010).
 */
async function resolveCourierContext(
  tx: Bun.SQL,
  tenantId: string,
  settings: Awaited<ReturnType<typeof fetchStoreSettings>>,
  destination: { districtCode: string } | null | undefined,
  weightGrams: number,
  providerSql?: Bun.SQL
): Promise<CartQuoteCourierContext | null> {
  if (!settings.shipping.courier.enabled) return null;

  const provider = resolveShippingRateProvider();
  const providerKey = resolveShippingRateProviderKey();
  if (!provider || !providerKey) return null;

  if (!destination) {
    return {
      enabled: true,
      destinationProvided: false,
      options: [],
      unavailableReason: null
    };
  }

  const originId = settings.shipping.courier.originDestinationId;
  const couriers = settings.shipping.courier.couriers;
  if (!originId || couriers.length === 0) {
    return {
      enabled: true,
      destinationProvided: true,
      options: [],
      unavailableReason: "Kurir belum dikonfigurasi."
    };
  }

  if (providerSql) {
    const result = await getCourierRates(
      providerSql,
      tenantId,
      {
        districtCode: destination.districtCode,
        weightGrams,
        originId,
        couriers
      },
      provider,
      providerKey
    );
    return {
      enabled: true,
      destinationProvided: true,
      options: result.available
        ? result.options.map((option) => ({
            serviceId: option.serviceId,
            courier: option.courier,
            service: option.service,
            name: option.name,
            cost: option.cost,
            etd: option.etd
          }))
        : [],
      unavailableReason: result.available ? null : result.reason
    };
  }

  const destinationId = await findCachedDestinationId(
    tx,
    tenantId,
    providerKey,
    destination.districtCode
  );
  if (!destinationId) {
    return {
      enabled: true,
      destinationProvided: true,
      options: [],
      unavailableReason: "Tujuan belum dikenali kurir"
    };
  }

  const cachedOptions = await findCachedRatesForCouriers(
    tx,
    tenantId,
    providerKey,
    originId,
    destinationId,
    weightGrams,
    couriers
  );

  return {
    enabled: true,
    destinationProvided: true,
    options: cachedOptions.map((option) => ({
      serviceId: option.serviceId,
      courier: option.courier,
      service: option.service,
      name: option.name,
      cost: option.cost,
      etd: option.etd
    })),
    unavailableReason:
      cachedOptions.length === 0 ? "Kurir tidak tersedia." : null
  };
}

/**
 * Builds a {@link CartQuoteContext} for exactly the products/variants named
 * in `lines`, then runs the pure `quoteCart`. Exported so
 * `order-directory.ts` can call it a second time, inside its own write
 * transaction, for the authoritative pre-write re-quote.
 *
 * `providerSql`, when present (the public quote route only), is the raw
 * pool client `getCourierRates` uses to open its OWN short transactions for
 * cache read/write around its provider call — deliberately NOT the `tx`
 * this function otherwise runs its own queries on, since a provider call
 * must never run while `tx`'s transaction is what the caller intends to
 * hold open (`order-directory.ts` never passes this).
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
    destination?: { districtCode: string } | null;
  },
  now: Date = new Date(),
  providerSql?: Bun.SQL
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

  const weightEstimateGrams = estimateWeightGrams(
    input.lines,
    productRows,
    variantRows
  );
  const courier = await resolveCourierContext(
    tx,
    tenantId,
    storeSettings,
    input.destination,
    weightEstimateGrams,
    providerSql
  );

  const context: CartQuoteContext = {
    products,
    variants,
    flashSales,
    storeSettings,
    voucher,
    now,
    courier
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
