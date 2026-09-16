🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](seo.id.md)

# SEO

What `apps/storefront` emits for search engines and link previews — metadata, structured data, sitemaps, feeds, and the legacy-redirect map that preserves incoming links at cutover.

## Per-page metadata — unchanged mechanism from increment 1

Every page renders through `BaseLayout`, which sets a `<title>`, a truncated `<meta name="description">`, a `<link rel="canonical">`, and Open Graph tags (`og:type` fixed to `"website"` even on a product page — the structured price/availability data goes through JSON-LD instead, not `product:price:*` meta, which this app does not declare). There is still no `og:image` on any page.

## JSON-LD by page type

| Page | `@type` | Built by |
| --- | --- | --- |
| `/` (home) | *(none)* | Home emits no JSON-LD — a deliberate scope trim, not an oversight |
| `/product/{slug}` | `Product` + nested `Offer`, `AggregateRating` when a rating exists, `BreadcrumbList` | `apps/storefront/src/lib/jsonld-produk.ts` |
| `/kategori/{slug}` | `CollectionPage` + `BreadcrumbList` | `apps/storefront/src/lib/jsonld-produk.ts`'s `buildCategoryPageSchema()` |
| `/berita/{slug}` | `NewsArticle` + `BreadcrumbList` (`@graph`, combining multiple nodes in one script block) | `apps/storefront/src/lib/jsonld-berita.ts` — author is a `Person` node when a byline exists, else `Organization`; publisher is always `Organization` |

`offers.price` on the product page is still the **raw** `numeric(14,2)` decimal string, unformatted — schema.org's validator wants a plain decimal, not a locale-formatted one. `availability` is derived from `stock` (`InStock`/`OutOfStock`), never carried as an independent field.

## The JSON-LD escaping is a real XSS defence, not a formality — unchanged, now exercised by more pages

`BaseLayout.astro`'s `jsonForScript()` replaces `<`, `>`, and `&` with `\uXXXX` JSON escapes before any CMS-supplied string reaches a `<script type="application/ld+json">` block — closing the same stored-XSS surface increment 1's `docs/seo.md` first documented (a product/article/category name containing `</script><script>...` would otherwise break out of the JSON-LD block and execute). Every new JSON-LD emitter added in increment 2 (`jsonld-produk.ts`'s `Offer`/`AggregateRating`, `jsonld-berita.ts`'s `NewsArticle`) routes through the same `jsonForScript()` — there is exactly one escaping function in this app, not one per emitter.

## `noindex` pages

`checkout`, `pesanan`, `cari`, `wishlist`, and `keranjang` all carry `<meta name="robots" content="noindex, follow">` via `BaseLayout`'s `head` slot — none of them is a page a search result should ever land a reader on directly. `robots.txt` additionally `Disallow`s the fetch for the same five paths plus `/api/`.

## Sitemaps and feeds

`apps/storefront/src/lib/sitemap.ts`'s `registerSitemapSource(name, source)` registers a named URL-producing function; twelve sources are registered across catalog and news (`static-routes`, `static-pages`, `berita-front`, `berita-posts`, `berita-video`, `berita-rubrik`, `berita-daerah`, `berita-mitra`, `berita-tag`, `katalog-produk`, `katalog-kategori`, `katalog-product-detail`). `chunkSitemapEntries` splits the combined result into chunks of at most 5,000 URLs each; `sitemap-index.xml` enumerates the resulting `/sitemap-{n}.xml` files. `feed.xml` (products) and `berita/feed.xml` + per-rubrik `rubrik/{slug}/feed.xml` (news, RSS 2.0, `content:encoded`) are separate, hand-built feeds, not sitemap sources.

## The legacy-redirect map

Every incoming seputarborneo (`/news/{id}-{slug}.html`) or beritasampit (`/{yyyy}/{mm}/{dd}/{slug}/`) URL is resolved against a map built from `apps/cms`'s own `awcms_seo_redirects` rows and served with a real `301` by `apps/storefront/server/penyaji.mjs` — see [`docs/routing.md`](routing.md) for the exact mechanism. This is the increment-2 answer to increment 1's "not built: sitemap, feed, robots.txt" line — all three now exist, and this redirect map is what makes cutover from either legacy platform not cost every indexed link and bookmark.

## Canonical URLs

Every canonical URL is still absolute, built from `SITE_URL`, matching the live site's URL shape for products — see [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.md).

## Not built

Structured data for the catalog listing page (`/produk`) itself — only category pages and product detail pages carry JSON-LD. An `og:image` on any page (no CMS-media client for it yet in this app — see [`docs/cms.md`](cms.md)). A `product:price:*` Open Graph namespace (the JSON-LD `Offer` node carries this instead, deliberately, per "Per-page metadata" above).
