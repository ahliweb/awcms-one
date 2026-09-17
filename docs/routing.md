🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](routing.id.md)

# Routing

Every route `apps/storefront` publishes — 41 route files under `apps/storefront/src/pages/`, all of it statically generated (`output: "static"`, `trailingSlash: "never"`, `build.format: "file"`, no `prerender = false` anywhere — enforced by [`apps/storefront/tests/checkout-guard-no-prerender.test.ts`](../apps/storefront/tests/checkout-guard-no-prerender.test.ts), which greps every page source rather than compiling it). Cart/checkout/order-tracking pages are static too — see [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md) for why their client-side JavaScript can call `apps/cms` live without the page itself being server-rendered.

## Catalog

| Path | Source | Notes |
| --- | --- | --- |
| `/` | `apps/storefront/src/pages/index.astro` | Slider, popular categories, flash-sale strip, featured/recommended products, testimonials, recent news, promo popup |
| `/produk` | `apps/storefront/src/pages/produk.astro` | Grid + sidebar (category tree, sort, price range, stock, flash-sale-only); client-side search/filter/sort/pagination over `/index/produk.json`, first page server-rendered so it stays indexable |
| `/kategori/{slug}` | `apps/storefront/src/pages/kategori/[slug].astro` | One page per live category |
| `/flash-sale` | `apps/storefront/src/pages/flash-sale.astro` | |
| `/product/{slug}` | `apps/storefront/src/pages/product/[slug].astro` | Gallery, variant picker, tiered/flash-sale price, size chart, service form, related products; `Product`/`Offer`/`BreadcrumbList` JSON-LD — see [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.md) for the URL shape itself |
| `/cari` | `apps/storefront/src/pages/cari.astro` | Catalog search; `noindex, follow` |

## News (mirrors seputarborneo/beritasampit)

| Path | Source | Notes |
| --- | --- | --- |
| `/berita` | `apps/storefront/src/pages/berita/index.astro` | Headline + one section per top-level rubrik, video strip, mitra strip, sidebar |
| `/berita/{slug}` | `apps/storefront/src/pages/berita/[slug].astro` | Article detail; `NewsArticle`+`BreadcrumbList` JSON-LD |
| `/berita/feed.xml` | `apps/storefront/src/pages/berita/feed.xml.ts` | RSS 2.0, 20 latest, full `content:encoded` |
| `/rubrik/{slug}` | `apps/storefront/src/pages/rubrik/[slug]/index.astro` | A parent rubrik's archive includes every descendant rubrik's posts |
| `/rubrik/{slug}/halaman/{n}` | `apps/storefront/src/pages/rubrik/[slug]/halaman/[n].astro` | Pagination |
| `/rubrik/{slug}/feed.xml` | `apps/storefront/src/pages/rubrik/[slug]/feed.xml.ts` | Per-rubrik RSS |
| `/daerah/{slug}` | `apps/storefront/src/pages/daerah/[slug].astro` | Region archive — reached via an institution's `regionCode`; a post itself carries no region field |
| `/mitra/{slug}` | `apps/storefront/src/pages/mitra/[slug].astro` | Institution landing page |
| `/video` | `apps/storefront/src/pages/video/index.astro` | |
| `/video/{slug}` | `apps/storefront/src/pages/video/[slug].astro` | Posts carrying a renderable `videoNews` block; partitioned from `/berita/{slug}` so no post has two canonical URLs |
| `/tag/{slug}` | `apps/storefront/src/pages/tag/[slug].astro` | |
| `/penulis/{slug}` | `apps/storefront/src/pages/penulis/[slug].astro` | Byline-based author archive |
| `/arsip/{yyyy}/{mm}` | `apps/storefront/src/pages/arsip/[yyyy]/[mm].astro` | WIB calendar month |
| `/cari-berita` | `apps/storefront/src/pages/cari-berita.astro` | Client-side search over `/index/berita.json` |

## Commerce runtime (browser calls `apps/cms` directly; pages themselves are static)

| Path | Source | Notes |
| --- | --- | --- |
| `/keranjang` | `apps/storefront/src/pages/keranjang.astro` | Renders the `localStorage` cart, re-quotes live, voucher code, no-JS WhatsApp fallback |
| `/checkout` | `apps/storefront/src/pages/checkout.astro` | One page, five progressively-disclosed steps: contact → address → shipping → payment → review |
| `/pesanan` | `apps/storefront/src/pages/pesanan.astro` | Tracking by `?kode=`; **not** `/pesanan/[kode]` — a per-code path cannot be prerendered under `output: "static"`, and there is no server-side catch-all to redirect from one shape to the other; the phone comes from `sessionStorage` or a form, never the URL |
| `/wishlist` | `apps/storefront/src/pages/wishlist.astro` | `localStorage`-only |

All four: `noindex, follow`, `aria-live="polite"` on quote/status updates, keyboard-reachable, a `<noscript>` fallback plus a JS-ran-but-CMS-down WhatsApp fallback (`apps/storefront/src/lib/wa-fallback.ts`).

## Static

| Path | Source |
| --- | --- |
| `/kontak` | `apps/storefront/src/pages/kontak.astro` |
| `/halaman/{slug}` | `apps/storefront/src/pages/halaman/[slug].astro` — CMS pages rendered from Portable Text |
| `/404` | `apps/storefront/src/pages/404.astro` |

## Discovery, feeds, and generated assets

| Path | Source |
| --- | --- |
| `/robots.txt` | `apps/storefront/src/pages/robots.txt.ts` — `Disallow`s `/keranjang`, `/checkout`, `/pesanan`, `/wishlist`, `/cari`, `/api/`; names `Sitemap:` |
| `/sitemap-index.xml` | `apps/storefront/src/pages/sitemap-index.xml.ts` |
| `/sitemap-{n}.xml` | `apps/storefront/src/pages/sitemap-[n].xml.ts` — chunked at 5000 URLs/file (`apps/storefront/src/lib/sitemap.ts`'s `registerSitemapSource`) |
| `/feed.xml` | `apps/storefront/src/pages/feed.xml.ts` — products |
| `/manifest.webmanifest` | `apps/storefront/src/pages/manifest.webmanifest.ts` |
| `/theme-tokens.css` | `apps/storefront/src/pages/theme-tokens.css.ts` — brand colors read from `apps/cms` at build time |
| `/product-labels.css` | `apps/storefront/src/pages/product-labels.css.ts` — one CSS class per distinct `labelColor` the catalog actually uses |
| `/csp.json` | `apps/storefront/src/pages/csp.json.ts` — the derived CSP artifact; see [`docs/arsitektur.md`](arsitektur.md) |
| `/index/produk.json`, `/index/berita.json` | Build-time search indexes for `/produk`/`/cari-berita`'s client-side filtering |
| `/index/pengalihan-legacy.json` | The legacy-redirect map, built from `awcms_seo_redirects` (below) |
| `/index/wilayah-provinsi.json`, `/index/wilayah-kabupaten-{provinceCode}.json`, `/index/wilayah-kecamatan-{cityCode}.json` | Address region data for checkout, baked at build time and scoped by `PUBLIC_WILAYAH_PROVINSI` (default every Kalimantan province) rather than the full ~90,000-village national dataset |

## Legacy redirects

`apps/storefront/server/penyaji.mjs`'s `legacyRedirectLocation()` looks up the incoming path (normalized: URI-decoded, query/fragment stripped, one trailing slash removed) against the map read once at server startup from `dist/client/index/pengalihan-legacy.json`. That file is built from `apps/cms`'s own `awcms_seo_redirects` rows (`origin: "legacy_blog"`) — only rows with `targetType: "relative_same_tenant"` are used (a `verified_external` row points off-site and is skipped); the CMS's own `target` column is not used verbatim — only its final path segment (the slug) is taken and rebuilt as `/berita/{slug}`, since `target` carries the CMS's own `/blog/{tenantCode}/{slug}` shape. Two rows that normalize to the same source path but disagree on destination fail the **build**, not a silent last-wins at request time.

Handled URL shapes: seputarborneo's `/news/{id}-{slug}.html` and beritasampit's `/{yyyy}/{mm}/{dd}/{slug}/` — both normalize correctly whether or not a trailing slash is present, at both build time (map key) and request time (lookup), including a real trailing-slash regression this build caught and fixed (`legacyRedirectLocation`'s own commit history, `apps/storefront/tests/berita-penyaji-legacy.test.ts`).

## `/products` → `/` (301), unchanged from increment 1

The live site's old catalog URL, `/products` — with or without a query string — still redirects to `/` with a `301`, matched on path only (`isProductsRedirect`/`PRODUCTS_REDIRECT_LOCATION` in `apps/storefront/server/penyaji.mjs`). This is a separate, hardcoded rule, distinct from the generated legacy-redirect map above — see [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.md).

## Not built

A per-code order-tracking path (`/pesanan/{code}` — see "Commerce runtime" above for why `?kode=` is the real, static-compatible shape). A CI job that runs the Playwright e2e suite (`apps/storefront/tests/e2e/checkout.e2e.ts`, `bun run test:e2e` inside `apps/storefront`) — it exists and passes locally, but is not wired into `.github/workflows/ci.yml` (outside the ops-owned CI file's scope for issue #30 — see [`docs/pengujian.md`](pengujian.md)).
