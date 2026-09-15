🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](routing.id.md)

# Routing

Every route `apps/storefront` publishes, and how each one is derived. All of it is static (see [ADR-0002](adr/0002-static-output-with-build-time-fetch-for-the-storefront.md)) — there is no server-side routing decision made at request time; everything below is decided at `astro build`.

## Routes

| Path | Source | Derived from |
| --- | --- | --- |
| `/` | [`apps/storefront/src/pages/index.astro`](../apps/storefront/src/pages/index.astro) | The catalog grid — every product `getProducts()` returns |
| `/product/{slug}` | [`src/pages/product/[slug].astro`](../apps/storefront/src/pages/product/[slug].astro) | One page per product, via `getStaticPaths()` (below) |
| `/product-labels.css` | [`apps/storefront/src/pages/product-labels.css.ts`](../apps/storefront/src/pages/product-labels.css.ts) | One CSS class per distinct `labelColor` the catalog actually uses — see [`docs/ui-ux.md`](ui-ux.md) |
| `/products` (any query string) | 301 in [`apps/storefront/server/penyaji.mjs`](../apps/storefront/server/penyaji.mjs) | Redirects to `/` — see below |

## `getStaticPaths()`: one page per active product

```ts
export async function getStaticPaths() {
  const products = await getProducts();
  return products.map((product) => ({
    params: { slug: product.slug },
    props: { product }
  }));
}
```

`getProducts()` ([`apps/storefront/src/lib/catalog.ts`](../apps/storefront/src/lib/catalog.ts)) is the single source every product page is generated from: it fetches and memoizes the whole catalog once per build, then filters to `status === "active"` via an exhaustive `switch` that fails to compile the moment `apps/cms` adds a fifth `ProductStatus` value without the storefront being told what it means (see [ADR-0004](adr/0004-a-type-only-contract-package-with-an-import-direction-gate.md)). Every product page this build ever emits therefore corresponds to exactly one live, active product at build time — there is no path a `draft`, `inactive`, or `archived` product can reach.

## URL shape: `/product/{slug}`, no trailing slash

`astro.config.mjs` sets `trailingSlash: "never"` site-wide and `build.format: "file"`, so the file this build emits (`dist/client/product/{slug}.html`) and the URL it is served at are byte-identical — no directory-index rewrite, no redirect between what is indexed and what is served. This shape was chosen deliberately to match the live borneojek-mart site's own existing URLs; see [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.md) for the sitemap evidence and the trade-off against the originally-planned `/{slug}` shape.

## `/products` → `/` (301), `category_slug` dropped by design

The live site's old catalog URL, `/products` — with or without a query string such as `?category_slug=kebutuhan-pokok-qy01` — redirects to `/` with a `301`, matched on path only so the query string never defeats the match (`isProductsRedirect` in `apps/storefront/server/penyaji.mjs`). This is one hardcoded rule in the same file that already sets every other response header, not a generated redirect-data file. The `category_slug` filter such a URL might carry is **dropped by design, not lost by oversight** — see the next section.

## Category listing pages: not built

There is no route that lists products by category. `awcms_commerce_categories` exists and every product carries a `categoryId`, so the data to build one is present — but nothing in this slice reads it that way; `getCategories()` is used only to resolve a product's own category name for display on its detail page and on catalog cards. A reader who lands on `/products?category_slug=...` from an old bookmark reaches the catalog root, unfiltered, rather than a 404 or a silently-ignored filter.

## Not built

Search, a sitemap, an RSS/Atom feed, a `robots.txt` route (there is none — the four routes listed above are the whole route table), and any route that reads `apps/cms` at request time. Every route above is fully determined at build time, with no server-rendered page anywhere in this app.
