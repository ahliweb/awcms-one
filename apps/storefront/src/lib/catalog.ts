/**
 * The commerce domain layer — the seam between awcms and every page.
 *
 * Mirrors the SHAPE of `src/lib/content.ts` in the sibling `awcms-astro` /
 * `media-lenterakalteng` templates this app is modelled on (issue #5): a
 * memoized, once-per-build fetch for each resource, and a hard failure
 * whenever a response looks emptier than it honestly should.
 *
 * `getProducts()` / `getProduct(slug)` / `getCategories()` are the contract:
 * pages call these three and never `awcmsGet` directly, and never see a
 * query parameter, a cursor, or an envelope. Issue #27 (catalog parity)
 * extends this file with the relations (`images[]`/`variants[]`) #23 added
 * to the wire shape, plus the pure, build-and-browser-shared helpers the
 * listing/search/category/detail pages need: a category tree, subtree
 * resolution, a search-index builder, and variant matching. Price display
 * moved OUT of this file to `src/lib/harga.ts` (issue #27's own file list) —
 * see that file for why, and for the grep-guarded rule this file's helpers
 * below are careful never to break (no `Number()`/`parseFloat()` on a price
 * field anywhere here; ordering/range comparisons go through
 * `harga.ts`'s `comparePrices`/`priceToNumber`).
 */
import { awcmsGet } from "./awcms/client";
import type { ProductType, ProductStatus } from "@awcms-one/kontrak";
import { isValidHexColor, contrastingForeground } from "./warna";
import { comparePrices, formatPrice, priceToNumber } from "./harga";

export type { ProductType, ProductStatus };
export { isValidHexColor, contrastingForeground };

/**
 * Re-exported for backward compatibility: `src/profil/toko/pages/feed.xml.ts` (issue
 * #24, outside this issue's file ownership) still imports `formatPrice`
 * from this module. Price formatting itself now lives in `src/lib/
 * harga.ts` (issue #27's own file list — "all price display, no
 * arithmetic") for every NEW caller; this is a pass-through, not a second
 * implementation.
 */
export { formatPrice };

// ---------------------------------------------------------------------------
// DTO contract
//
// `ProductType`/`ProductStatus` are IMPORTED from `@awcms-one/kontrak`
// (issue #6). `SizeChartType`/`SubscriptionPeriod`/`ServiceFormFieldType`/
// `ProductSort` are NOT — `packages/kontrak/src/katalog.ts` already exports
// them (its own docblock names all four as landing "for #23"), but
// `packages/kontrak/src/index.ts` — the package's only importable entry,
// `exports: {".": "./src/index.ts"}` in its `package.json`, no subpath
// exports declared — re-exports just `ProductType`/`ProductStatus`.
// `packages/kontrak/**` is outside this issue's scope (`apps/storefront/**`
// only), so these four are declared locally below instead, verbatim from
// the same `apps/cms/src/modules/commerce/domain/*.ts` files katalog.ts
// already cites — the identical "declared locally, with a comment" choice
// this file already made for `CommerceProduct`/`CommerceCategory` (their row
// shapes live in `application/`, out of kontrak's scope for a different,
// also-documented reason — see below).
//
// `CommerceCategory`/`CommerceProduct` stay declared LOCALLY: their row
// shapes (`CategoryRecord`/`ProductRecord`, plus the `images[]`/`variants[]`
// relations `attachProductRelations` widens them with) live in
// `apps/cms/src/modules/commerce/application/{category,product}-directory.ts`,
// not `domain/`, so they are out of `@awcms-one/kontrak`'s scope by the same
// rule that keeps that package from reaching into `application/` at all.
// Every field below is copied VERBATIM from `apps/cms`'s `toRecord()`/
// `toImageDTO()`/`toVariantDTO()` functions — editing a field here without
// editing it there is a contract break neither build can see.
// ---------------------------------------------------------------------------

/** `apps/cms/.../domain/size-chart.ts`'s `SizeChartType` — see the note above. */
export type SizeChartType = "none" | "image" | "table";

/** `apps/cms/.../domain/subscription-period.ts`'s `SubscriptionPeriod` — see the note above. */
export type SubscriptionPeriod = "day" | "week" | "month" | "year";

/** `apps/cms/.../domain/service-form-validation.ts`'s `ServiceFormFieldType` — see the note above. */
export type ServiceFormFieldType = "text" | "textarea" | "select" | "number" | "date";

/** `apps/cms/.../domain/product-sort.ts`'s `ProductSort` — kept here for the SAME reason, even though this app never sends `sort` to awcms (see "Fetching" below): the produk-index filter/sort below reuses this exact vocabulary so a URL's `?urut=` value means one thing everywhere. */
export type ProductSort = "newest" | "price_asc" | "price_desc" | "name";

/** One `service_form` field — `apps/cms/.../domain/service-form-validation.ts`'s `ServiceFormField`, structural (not re-exported by kontrak — see file header). */
export type ServiceFormField = {
  id: string;
  type: ServiceFormFieldType;
  label: string;
  required: boolean;
  options: string[] | null;
};

/** One `variant_attributes` option — `apps/cms/.../domain/variant-attributes-validation.ts`'s `VariantAttributeOption`. */
export type VariantAttributeOption = {
  name: string;
  description: string | null;
};

/** One `variant_attributes` group — same file's `VariantAttributeGroup`. Descriptive metadata only; see `findVariantForSelection` below for what this does and does not let the storefront match against a concrete variant row. */
export type VariantAttributeGroup = {
  name: string;
  options: VariantAttributeOption[];
};

export type CommerceCategory = {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  icon: string | null;
  /** Live products directly IN this category — never the subtree total. See `collectCategorySubtreeIds`/`productsInCategorySubtree` below for the subtree count a category PAGE needs instead. */
  productCount: number;
};

/** `ProductImageDTO`, verbatim — `images[].publicUrl` is the URL to render; `null` means the media object is not publicly resolvable (render a placeholder, never a broken `<img>`). */
export type CommerceProductImage = {
  id: string;
  productId: string;
  mediaObjectId: string;
  publicUrl: string | null;
  altText: string | null;
  sortOrder: number;
};

/** `ProductVariantDTO`, verbatim — `imageUrl` (not `imageMediaObjectId`) is the URL to render for this variant. */
export type CommerceProductVariant = {
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

/**
 * `ProductRecord` + the `images[]`/`variants[]` relations `ProductWithRelations`
 * adds — every field awcms's product GET routes actually return, verbatim.
 *
 * `downloadLink` is carried here because `toRecord()` still returns it as of
 * #23/PR #37 — but per the #26⇄#27 contract
 * (`commerce-public-read-models.md`, "Notes for the storefront (#27)"), it
 * is being REMOVED from the public DTO once #26 merges (a digital product's
 * download link must only be delivered after purchase, #29), and until then
 * **no page in this app reads it**. Grep for `.downloadLink` before adding
 * a page that would.
 */
export type CommerceProduct = {
  id: string;
  categoryId: string | null;
  type: ProductType;
  sku: string;
  name: string;
  slug: string;
  description: string | null;
  digitalNote: string | null;
  /** `numeric(14,2)` STRING — format with `harga.ts`, never `Number()`/`parseFloat()` it (ADR-0003). */
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
  /** ⚠ Never rendered — see this type's own docblock above. */
  downloadLink: string | null;
  allowDp: boolean;
  allowFreeShipping: boolean;
  variantAttributes: VariantAttributeGroup[] | null;
  isFeatured: boolean;
  isRecommended: boolean;
  /** `price` after `discountPercent`, exact — awcms computed this, never recompute it here. */
  finalPrice: string;
  averageRating: string | null;
  soldCount: number;
  images: CommerceProductImage[];
  variants: CommerceProductVariant[];
};

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const PRODUCTS_PATH = "/api/v1/commerce/products";
const CATEGORIES_PATH = "/api/v1/commerce/categories";

/** The page size both commerce list routes fix server-side (`PRODUCT_LIST_LIMIT`/`CATEGORY_LIST_LIMIT`, both 100). Not sent as a request parameter — see `MAX_PAGES` below for the backstop this bounds. */
const SERVER_PAGE_SIZE = 100;

/**
 * A runaway-loop backstop, not a content limit — see this constant's
 * original docblock in the increment-1 revision of this file (git history)
 * for the full "not measured, chosen" reasoning. 200 pages of
 * `SERVER_PAGE_SIZE` is 20,000 rows.
 */
const MAX_PAGES = 200;

type CommercePage<T> = {
  items: T[];
  nextCursor: string | null;
};

/** Walks a keyset-paginated commerce list to exhaustion, one cursor hop at a time. Shared by `listAllProducts`/`listAllCategories` — both resources page identically. */
async function listAllPages<T>(path: string, resourceNoun: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;

  for (let page = 1; ; page += 1) {
    const response = await awcmsGet<CommercePage<T>>(path, { cursor });

    items.push(...response.items);

    if (!response.nextCursor) return items;

    if (page >= MAX_PAGES) {
      throw new Error(
        `Stopped after ${MAX_PAGES} pages (${items.length} ${resourceNoun}) and ` +
          `awcms still returned a cursor.\n\n` +
          `Two causes, and they need different answers:\n` +
          `  - The cursor is not advancing. awcms would have to be returning ` +
          `the same page forever; the ${resourceNoun} count above tells you ` +
          `which, because it would be a multiple of ${SERVER_PAGE_SIZE} with ` +
          `duplicate slugs.\n` +
          `  - This catalog really is that large. Then raise MAX_PAGES in ` +
          `src/lib/catalog.ts — but measure first; this backstop was chosen, ` +
          `not benchmarked.\n\n` +
          `What is NOT an answer is returning what has been collected so ` +
          `far: a short list that looks complete publishes a storefront ` +
          `missing an unknown number of ${resourceNoun}, with every gate green.`
      );
    }

    cursor = response.nextCursor;
  }
}

function listAllProducts(): Promise<CommerceProduct[]> {
  return listAllPages<CommerceProduct>(PRODUCTS_PATH, "products");
}

function listAllCategories(): Promise<CommerceCategory[]> {
  return listAllPages<CommerceCategory>(CATEGORIES_PATH, "categories");
}

/** Exhaustiveness backstop over `ProductStatus` — see `isPubliclyVisible` below. */
function assertNeverProductStatus(value: never): never {
  throw new Error(`Unhandled ProductStatus: ${String(value)}`);
}

/** Whether a product with this status should ever reach the public storefront. An exhaustive `switch`, not a bare `=== "active"` comparison, so a status awcms adds later cannot silently fall through as "not active". */
function isPubliclyVisible(status: ProductStatus): boolean {
  switch (status) {
    case "active":
      return true;
    case "draft":
    case "inactive":
    case "archived":
      return false;
    default:
      return assertNeverProductStatus(status);
  }
}

let productsCache: Promise<CommerceProduct[]> | undefined;

/**
 * Every product this build is willing to publish: fetched once, memoized,
 * and filtered with `isPubliclyVisible` — a CLIENT-SIDE check, because the
 * products route accepts no `status` filter this app ever sends (it fetches
 * the whole catalog once, unfiltered, and does every filter/sort/search
 * client- or build-side over that one snapshot — see `filterProdukIndex`
 * below).
 */
export async function getProducts(): Promise<CommerceProduct[]> {
  productsCache ??= (async () => {
    const all = await listAllProducts();
    const active = all.filter((product) => isPubliclyVisible(product.status));

    if (active.length === 0 && all.length > 0) {
      throw new Error(
        `awcms returned ${all.length} product(s) and NOT ONE has status ` +
          `"active". Either the status filter was ignored, or every product ` +
          `in this tenant is a draft, inactive, or archived. Building ` +
          `anyway would publish a storefront with zero products and every ` +
          `gate green.`
      );
    }

    return active;
  })();

  return productsCache;
}

/** A single product by slug, read from the SAME cached list `getProducts()` already fetched — never a second request per product. */
export async function getProduct(slug: string): Promise<CommerceProduct> {
  const products = await getProducts();
  const product = products.find((candidate) => candidate.slug === slug);

  if (!product) {
    throw new Error(
      `No active product with slug "${slug}" in the cached catalog. This is ` +
        `a routing bug, not an awcms failure: getStaticPaths() only ever ` +
        `requests a slug that getProducts() just returned, so this can only ` +
        `happen if getProduct() is called with a slug from somewhere else.`
    );
  }

  return product;
}

let categoriesCache: Promise<CommerceCategory[]> | undefined;

/** Every category, fetched once and memoized. An empty result is a normal, buildable state (a catalog with no categories yet), not a sign awcms ignored anything. */
export async function getCategories(): Promise<CommerceCategory[]> {
  categoriesCache ??= listAllCategories();
  return categoriesCache;
}

/** A single category by slug, read from the cached list — `getCategories()` never runs twice for one build regardless of how many category pages call this. */
export function getCategoryBySlug(
  categories: readonly CommerceCategory[],
  slug: string
): CommerceCategory | undefined {
  return categories.find((category) => category.slug === slug);
}

// ---------------------------------------------------------------------------
// Category tree / subtree resolution
//
// awcms's category rows carry only `parentId` — one level of self-reference,
// not a materialized path or a depth column. Every tree/subtree question
// this app asks (the sidebar tree, "products of the subtree" for a category
// page) is answered by walking that one column here, once per build, rather
// than assuming a fixed depth. Live data (`mart-home.json`) goes two levels
// deep (e.g. "Roti dan Kue" -> "hh"); nothing below assumes a bound.
// ---------------------------------------------------------------------------

export type CategoryNode = CommerceCategory & { children: CategoryNode[] };

/** Builds the top-level forest, each node carrying its own `children` recursively. A category whose `parentId` points at a category NOT in `categories` (soft-deleted, or absent) is treated as its own root — the same "a dangling reference degrades gracefully" rule `category-directory.ts`'s own README documents for a live PRODUCT pointing at a soft-deleted category. */
export function buildCategoryTree(categories: readonly CommerceCategory[]): CategoryNode[] {
  const byId = new Map<string, CategoryNode>();
  for (const category of categories) {
    byId.set(category.id, { ...category, children: [] });
  }

  const roots: CategoryNode[] = [];
  for (const category of categories) {
    const node = byId.get(category.id);
    if (!node) continue;

    const parent = category.parentId ? byId.get(category.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/** Every category id in `rootId`'s subtree, INCLUDING `rootId` itself — a breadth-first walk over `parentId`, not a fixed-depth assumption. Used to answer "products of the subtree" for `/kategori/[slug]` without a recursive SQL query this app has no database connection to run. */
export function collectCategorySubtreeIds(
  categories: readonly CommerceCategory[],
  rootId: string
): Set<string> {
  const childIdsByParent = new Map<string, string[]>();
  for (const category of categories) {
    if (category.parentId === null) continue;
    const siblings = childIdsByParent.get(category.parentId) ?? [];
    siblings.push(category.id);
    childIdsByParent.set(category.parentId, siblings);
  }

  const subtreeIds = new Set<string>([rootId]);
  const queue: string[] = [rootId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const childId of childIdsByParent.get(current) ?? []) {
      if (!subtreeIds.has(childId)) {
        subtreeIds.add(childId);
        queue.push(childId);
      }
    }
  }

  return subtreeIds;
}

/** Every LIVE product whose `categoryId` falls inside `categoryIds` — the filter `/kategori/[slug]` applies with `collectCategorySubtreeIds`'s result. */
export function productsInCategory(
  products: readonly CommerceProduct[],
  categoryIds: ReadonlySet<string>
): CommerceProduct[] {
  return products.filter(
    (product) => product.categoryId !== null && categoryIds.has(product.categoryId)
  );
}

// ---------------------------------------------------------------------------
// Variant matching
// ---------------------------------------------------------------------------

/**
 * Finds the variant row matching a set of selected option names, one per
 * `variantAttributes` group, IN GROUP ORDER.
 *
 * `variantAttributes` is DESCRIPTIVE metadata only — the set of attribute
 * groups/options a merchant has defined — "not a constraint enforced
 * against `awcms_commerce_product_variants` rows" (that table's own
 * validator, `variant-attributes-validation.ts`, says so explicitly). A
 * concrete variant ROW carries exactly one `{name, value}` pair, not an
 * array of per-group selections, and BjekMart's own live catalog data
 * (`mart-home.json`) only ever uses this with a SINGLE attribute group — the
 * option name lands straight in `variant.name` (e.g. group "Mie Gacoan",
 * option "Suit" -> `variant.name === "Suit"`). This function matches the
 * FIRST selection against `variant.name` and, when a product genuinely
 * defines a SECOND group, the second selection against `variant.value` —
 * which covers every real shape this schema has ever carried. A THIRD group
 * has no field left to encode it and cannot be matched here; that is a real
 * limit of the upstream schema, not an oversight, and is worth restating if
 * a product ever needs one.
 */
export function findVariantForSelection(
  variants: readonly CommerceProductVariant[],
  selectedOptionNames: readonly string[]
): CommerceProductVariant | undefined {
  if (selectedOptionNames.length === 0) return undefined;

  const [first, second] = selectedOptionNames;
  return variants.find(
    (variant) => variant.name === first && (second === undefined || variant.value === second)
  );
}

/** The first image with a resolvable URL, or `null` — the card/thumbnail/OG image every listing surface needs one of. */
export function primaryProductImage(
  product: CommerceProduct
): { url: string; alt: string } | null {
  const image = product.images.find((candidate) => candidate.publicUrl !== null);
  return image ? { url: image.publicUrl as string, alt: image.altText ?? product.name } : null;
}

// ---------------------------------------------------------------------------
// Tiered pricing
// ---------------------------------------------------------------------------

export type PriceTierRow = { level: 1 | 2 | 3 | 4; label: string; price: string };

const DEFAULT_TIER_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "Harga Normal",
  2: "Harga Level 2",
  3: "Harga Level 3",
  4: "Harga Level 4"
};

/**
 * The "Reseller / Agen / Distributor" table the product detail page renders
 * — one row per level that actually HAS a price, level 1 always present.
 * When `variant` carries its own price for a level, that price wins over the
 * product's (a variant's own tier is a full override, never blended with the
 * product's); when the variant is `null` or leaves a level `null`, the
 * product's own tier is used. `customerLevels` (from
 * `src/lib/awcms/pemasaran.ts`'s store settings) supplies the real level
 * NAMES; a level with no matching entry falls back to a generic label rather
 * than hiding the row — a store that has not configured level names yet
 * still gets a usable table.
 */
export function buildPriceTiers(
  product: CommerceProduct,
  variant: CommerceProductVariant | null,
  customerLevels: ReadonlyArray<{ level: number; name: string }>
): PriceTierRow[] {
  const labelFor = (level: 1 | 2 | 3 | 4): string =>
    customerLevels.find((entry) => entry.level === level)?.name ?? DEFAULT_TIER_LABELS[level];

  const rows: PriceTierRow[] = [
    { level: 1, label: labelFor(1), price: variant?.price ?? product.finalPrice }
  ];

  const higherTiers: readonly [2 | 3 | 4, string | null][] = [
    [2, variant?.priceLevel2 ?? product.priceLevel2],
    [3, variant?.priceLevel3 ?? product.priceLevel3],
    [4, variant?.priceLevel4 ?? product.priceLevel4]
  ];

  for (const [level, price] of higherTiers) {
    if (price !== null) rows.push({ level, label: labelFor(level), price });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Search/listing index — the build-time JSON `src/profil/toko/pages/index/produk.json.ts`
// serves and every client-side filter/sort/paginate control on `/produk` and
// `/cari` reads. Kept deliberately small per row (issue #27: "id, slug,
// name, sku, category, price, finalPrice, image, label, rating, sold,
// stock, inFlashSale") — this is what ships to every visitor's browser, not
// the full `CommerceProduct`.
// ---------------------------------------------------------------------------

export type ProdukIndexEntry = {
  id: string;
  slug: string;
  name: string;
  sku: string;
  categorySlug: string | null;
  categoryName: string | null;
  price: string;
  finalPrice: string;
  image: { url: string; alt: string } | null;
  label: string | null;
  labelColor: string | null;
  rating: string | null;
  sold: number;
  stock: number;
  inFlashSale: boolean;
};

/** Builds one index row per LIVE product, in the SAME order `products` arrives in (newest-first, from awcms) — `filterProdukIndex`'s `sort: "newest"` relies on that order rather than re-deriving it from a field this index does not carry. */
export function buildProdukIndex(
  products: readonly CommerceProduct[],
  categoriesById: ReadonlyMap<string, CommerceCategory>,
  flashSaleProductIds: ReadonlySet<string>
): ProdukIndexEntry[] {
  return products.map((product) => {
    const category = product.categoryId ? categoriesById.get(product.categoryId) : undefined;
    const image = primaryProductImage(product);

    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      sku: product.sku,
      categorySlug: category?.slug ?? null,
      categoryName: category?.name ?? null,
      price: product.price,
      finalPrice: product.finalPrice,
      image,
      label: product.label,
      labelColor: product.labelColor,
      rating: product.averageRating,
      sold: product.soldCount,
      stock: product.stock,
      inFlashSale: flashSaleProductIds.has(product.id)
    };
  });
}

export type ProdukIndexFilter = {
  q?: string;
  categorySlug?: string;
  sort?: ProductSort;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  flashSaleOnly?: boolean;
};

function normalizeSearchTerm(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Filters and sorts a produk-index snapshot — the ONE implementation
 * `/produk`'s sidebar controls, `/cari`'s query box, and their respective
 * `src/scripts/*.ts` DOM wiring all call, so "what matches a search term" is
 * never answered twice. Price comparisons go through `harga.ts`'s
 * `priceToNumber`/`comparePrices` — never a bare `Number()`/`parseFloat()`
 * here — so this file stays clean of the grep guard `tests/
 * katalog-harga.test.ts` enforces over `src/`.
 */
export function filterProdukIndex(
  items: readonly ProdukIndexEntry[],
  filter: ProdukIndexFilter
): ProdukIndexEntry[] {
  let result = items.slice();

  const q = filter.q ? normalizeSearchTerm(filter.q) : "";
  if (q) {
    result = result.filter(
      (item) =>
        normalizeSearchTerm(item.name).includes(q) || normalizeSearchTerm(item.sku).includes(q)
    );
  }

  if (filter.categorySlug) {
    const categorySlug = filter.categorySlug;
    result = result.filter((item) => item.categorySlug === categorySlug);
  }

  if (filter.inStockOnly) {
    result = result.filter((item) => item.stock > 0);
  }

  if (filter.flashSaleOnly) {
    result = result.filter((item) => item.inFlashSale);
  }

  if (filter.minPrice !== undefined) {
    const min = filter.minPrice;
    result = result.filter((item) => priceToNumber(item.finalPrice) >= min);
  }

  if (filter.maxPrice !== undefined) {
    const max = filter.maxPrice;
    result = result.filter((item) => priceToNumber(item.finalPrice) <= max);
  }

  const sort = filter.sort ?? "newest";
  if (sort === "price_asc") {
    result = result.sort((a, b) => comparePrices(a.finalPrice, b.finalPrice));
  } else if (sort === "price_desc") {
    result = result.sort((a, b) => comparePrices(b.finalPrice, a.finalPrice));
  } else if (sort === "name") {
    result = result.sort((a, b) => a.name.localeCompare(b.name, "id"));
  }
  // "newest" (the default): keep the incoming order — already newest-first.

  return result;
}

export const PRODUK_PAGE_SIZE = 24;

export type ProdukPage<T> = { items: T[]; page: number; totalPages: number; totalItems: number };

/** Slices a (typically already-filtered) list into one page, clamping `page` into range rather than returning an empty page for an out-of-range value — a stale `?halaman=` in a bookmarked/shared URL degrades to the last real page instead of "no results". */
export function paginateProdukIndex<T>(
  items: readonly T[],
  page: number,
  pageSize: number = PRODUK_PAGE_SIZE
): ProdukPage<T> {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const requested = Math.trunc(page);
  const safePage = Number.isFinite(requested) && requested > 0 ? Math.min(requested, totalPages) : 1;
  const start = (safePage - 1) * pageSize;

  return { items: items.slice(start, start + pageSize), page: safePage, totalPages, totalItems };
}

// ---------------------------------------------------------------------------
// Label badge — unchanged from increment 1, still consumed by
// `src/profil/toko/pages/product-labels.css.ts` (outside this issue's ownership).
// ---------------------------------------------------------------------------

/** The CSS class `src/profil/toko/pages/product-labels.css.ts` generates for a given `labelColor`, or `undefined` when there is nothing safe to render. */
export function labelClassName(hex: string | null | undefined): string | undefined {
  if (!hex || !isValidHexColor(hex)) return undefined;
  return `label-bg-${hex.trim().replace("#", "").toLowerCase()}`;
}
