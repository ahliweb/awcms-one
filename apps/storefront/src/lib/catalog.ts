/**
 * The commerce domain layer — the seam between awcms and every page.
 *
 * Mirrors the SHAPE of `src/lib/content.ts` in the sibling `awcms-astro` /
 * `media-lenterakalteng` templates this app is modelled on (issue #5): a
 * memoized, once-per-build fetch for each resource, and a hard failure
 * whenever a response looks emptier than it honestly should. It does not
 * mirror that file's SIZE — a product catalog carries no locales,
 * translations, or sections, so none of the machinery those concerns need
 * is reproduced here.
 *
 * `getProducts()` / `getProduct(slug)` / `getCategories()` are the contract:
 * pages call these three and never `awcmsGet` directly, and never see a
 * query parameter, a cursor, or an envelope.
 */
import { awcmsGet } from "./awcms/client";

// ---------------------------------------------------------------------------
// DTO contract
//
// Declared LOCALLY and on purpose not this file's to redesign: every field
// below is copied VERBATIM from issue #5, which shares it with the CMS-side
// commerce module (issue #4). Editing a field here without editing it there
// is a contract break neither build can see. Issue #6 replaces this block
// with `export type { ... } from "@awcms-one/kontrak"`.
// ---------------------------------------------------------------------------

export type ProductType = "physical" | "digital" | "service" | "subscription";
export type ProductStatus = "draft" | "active" | "inactive" | "archived";

export type CommerceCategory = {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  icon: string | null;
};

export type CommerceProduct = {
  id: string;
  categoryId: string | null;
  type: ProductType;
  sku: string;
  name: string;
  slug: string;
  description: string | null;
  digitalNote: string | null;
  /**
   * `numeric(14,2)` from PostgreSQL, carried as a STRING so the API never
   * loses precision converting it to a JSON number. Format it for display
   * with `formatPrice` below; never `parseFloat`/`Number` it for
   * arithmetic — that is how a stored `19.10` becomes a computed
   * `19.099999999999998`. This app does no such arithmetic: it displays the
   * price awcms sends and the discount PERCENTAGE awcms sends, and never
   * computes a discounted amount itself (see `discountPercent` below).
   */
  price: string;
  discountPercent: number;
  stock: number;
  status: ProductStatus;
  label: string | null;
  labelColor: string | null;
};

// ---------------------------------------------------------------------------
// Fetching
//
// Endpoint paths follow the `/api/v1/{module}/{resource}` convention every
// other awcms module already uses (`/api/v1/blog/posts`,
// `/api/v1/media/objects`, …). They are NOT copied from a live commerce
// endpoint: at the time this app was built, the commerce module (issue #4)
// had not yet landed in this worktree's `apps/cms` — no route, no OpenAPI
// fragment. If the real paths differ once #4 merges, this is the one place
// that needs to change.
// ---------------------------------------------------------------------------

const PRODUCTS_PATH = "/api/v1/commerce/products";
const CATEGORIES_PATH = "/api/v1/commerce/categories";

/** Assumed page size for the products list; halved or doubled costs nothing but a few more/fewer requests. */
const PAGE_SIZE = 100;

/**
 * A runaway-loop backstop, not a content limit.
 *
 * Unlike the measured backstop in the sibling template's `content.ts` (which
 * cites a benchmarked memory/time curve), this number is NOT measured —
 * nothing about this catalog's real scale exists to measure yet. 200 pages
 * of 100 is 20,000 products, chosen only as "clearly larger than a single
 * mart's catalog will be for a long time." Re-derive it the same way that
 * file did — a real measurement — before raising it.
 */
const MAX_PAGES = 200;

type ProductListResponse = {
  products: CommerceProduct[];
  nextCursor: string | null;
};

type CategoryListResponse = {
  categories: CommerceCategory[];
};

/**
 * Walks the products list with a keyset cursor, exactly like the sibling
 * template's blog traversal: `status=active` is a REQUEST to awcms, not a
 * guarantee, so `getProducts()` below re-checks it on every row rather than
 * trusting the filter was honoured.
 */
async function listAllProducts(): Promise<CommerceProduct[]> {
  const products: CommerceProduct[] = [];
  let cursor: string | undefined;

  for (let page = 1; ; page += 1) {
    const response = await awcmsGet<ProductListResponse>(PRODUCTS_PATH, {
      status: "active",
      limit: PAGE_SIZE,
      cursor
    });

    products.push(...response.products);

    if (!response.nextCursor) return products;

    if (page >= MAX_PAGES) {
      throw new Error(
        `Stopped after ${MAX_PAGES} pages (${products.length} products) and ` +
          `awcms still returned a cursor.\n\n` +
          `Two causes, and they need different answers:\n` +
          `  - The cursor is not advancing. awcms would have to be returning ` +
          `the same page forever; the product count above tells you which, ` +
          `because it would be a multiple of ${PAGE_SIZE} with duplicate slugs.\n` +
          `  - This catalog really is that large. Then raise MAX_PAGES in ` +
          `src/lib/catalog.ts — but measure first; this backstop was chosen, ` +
          `not benchmarked.\n\n` +
          `What is NOT an answer is returning what has been collected so ` +
          `far: a short list that looks complete publishes a storefront ` +
          `missing an unknown number of products, with every gate green.`
      );
    }

    cursor = response.nextCursor;
  }
}

let productsCache: Promise<CommerceProduct[]> | undefined;

/**
 * Every product this build is willing to publish: fetched once, memoized,
 * and filtered to `status === "active"` — re-checked here rather than
 * trusted from the `status=active` request above, because this is the last
 * place that can tell "awcms honoured the filter" apart from "awcms ignored
 * it and sent everything".
 *
 * `getStaticPaths()` in `src/pages/product/[slug].astro` calls this to build every
 * product page in one traversal, so it costs one request set for the whole
 * build no matter how many pages Astro renders from it.
 */
export async function getProducts(): Promise<CommerceProduct[]> {
  productsCache ??= (async () => {
    const all = await listAllProducts();
    const active = all.filter((product) => product.status === "active");

    // A filter that can only ever REMOVE needs a floor. One product held
    // back is an editorial state (a merchant unpublished it) and builds
    // fine; ALL of them held back is not — it is a status filter awcms
    // ignored, or a tenant with nothing published yet. Both publish a
    // storefront with zero products and every gate green, which is worse
    // than a build that says so.
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

/**
 * A single product by slug, read from the SAME cached list `getProducts()`
 * already fetched — never a second request per product. Fetching one at a
 * time would turn a catalog of N products into N+1 requests against a
 * build-time-only credential, for data one traversal already holds in
 * memory (the same reasoning the sibling template's `content.ts` gives for
 * batching its media lookups rather than resolving them per-article).
 */
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

/**
 * Every category, fetched once and memoized. Unlike products, an empty
 * result is not treated as suspicious: a catalog with no categories yet
 * (products all uncategorised) is a normal, buildable state, not a sign
 * awcms ignored anything.
 */
export async function getCategories(): Promise<CommerceCategory[]> {
  categoriesCache ??= (async () => {
    const response = await awcmsGet<CategoryListResponse>(CATEGORIES_PATH);
    return response.categories;
  })();

  return categoriesCache;
}

// ---------------------------------------------------------------------------
// Presentation helpers derived from the DTO
//
// Small, pure functions co-located with the fields they decorate rather than
// split into their own file — the same placement the sibling template uses
// for values derived from one field of one row (e.g. `videoNewsUntuk` beside
// `VideoNewsResolved` in its `content.ts`).
// ---------------------------------------------------------------------------

const priceFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR"
});

/**
 * The ONLY place `price` is converted out of its string form, and only for
 * display: `Intl.NumberFormat.prototype.format()` has no string overload, so
 * a single, terminal `Number(price)` fed straight into it and immediately
 * rounded to whole rupiah is not the "money arithmetic" issue #5 warns
 * against — that warning is about ACCUMULATING float error across
 * calculations (a discount applied, a total summed), which this app never
 * does. It shows the discount as the PERCENTAGE awcms sends
 * (`discountPercent`) rather than computing a discounted price, so it never
 * has to invent a rounding rule that might disagree with whatever a future
 * checkout computes.
 */
export function formatPrice(price: string): string {
  const value = Number(price);

  if (!Number.isFinite(value)) {
    throw new Error(
      `formatPrice: "${price}" is not a finite number. awcms declares price ` +
        `as numeric(14,2), so a value that does not parse is a changed ` +
        `response shape, not a product with no price.`
    );
  }

  return priceFormatter.format(value);
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Whether `value` is a 6-digit `#rrggbb` hex color this app knows how to pair a readable foreground against. */
export function isValidHexColor(value: string): boolean {
  return HEX_COLOR.test(value.trim());
}

/** WCAG relative luminance (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance) of a validated `#rrggbb` string. */
function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    );

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Picks black or white text for readability against an arbitrary,
 * CMS-supplied background color — `label`/`labelColor` on `CommerceProduct`
 * is a merchandiser-chosen badge color with no fixed palette, and assuming
 * white text is always readable on it is exactly the bug issue #5 calls out
 * by name: a pale badge color (a light yellow "Baru" tag, say) with white
 * text fails contrast outright.
 *
 * Compares the WCAG contrast ratio of BOTH candidates against the
 * background and returns whichever is higher, rather than testing the
 * luminance against a single midpoint threshold — the two contrast formulas
 * (against white, against black) are not symmetric around one, so a fixed
 * threshold picks the worse option for a real range of colors.
 *
 * Known limit, stated rather than hidden: for a color near the middle of the
 * luminance range, NEITHER pure black nor pure white may reach the 4.5:1
 * body-text minimum — picking the higher-contrast one is the best a
 * function of the background color alone can do without altering the
 * merchandiser's chosen color, which is out of scope for this app to do
 * silently.
 */
export function contrastingForeground(hex: string): "#000000" | "#ffffff" {
  if (!isValidHexColor(hex)) {
    throw new Error(
      `contrastingForeground: "${hex}" is not a 6-digit hex color (e.g. ` +
        `"#1a2b3c"). Callers are expected to check isValidHexColor() first — ` +
        `see labelClassName(), which never passes anything else through.`
    );
  }

  const luminance = relativeLuminance(hex);
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  const contrastWithBlack = (luminance + 0.05) / 0.05;

  return contrastWithWhite >= contrastWithBlack ? "#ffffff" : "#000000";
}

/**
 * The CSS class `src/pages/product-labels.css.ts` generates for a given
 * `labelColor`, or `undefined` when there is nothing safe to render — either
 * no color was set, or awcms sent something that is not a 6-digit hex (free
 * text, `rgb(...)`, a typo). `undefined` degrades to the plain badge style
 * in `global.css`, which still shows the label TEXT; it never blocks the
 * build over one merchandiser's bad color value.
 */
export function labelClassName(hex: string | null | undefined): string | undefined {
  if (!hex || !isValidHexColor(hex)) return undefined;
  return `label-bg-${hex.trim().replace("#", "").toLowerCase()}`;
}
