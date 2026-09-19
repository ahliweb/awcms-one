🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](seo.id.md)

# SEO

What `apps/storefront` emits for search engines and link previews — metadata, structured data, sitemaps, feeds, and the legacy-redirect map that preserves incoming links at cutover.

## Per-page metadata — unchanged mechanism from increment 1

Every page renders through `BaseLayout`, which sets a `<title>`, a truncated `<meta name="description">`, a `<link rel="canonical">`, and the fixed Open Graph block (`og:type`, `og:url`, `og:title`, `og:description`, `og:site_name`, `og:locale`). `og:type` stays `"website"` on a product page — the structured price/availability data goes through JSON-LD instead, not `product:price:*` meta, which this app does not declare. Since issue #54 (increment 3, A8) `BaseLayout` also takes two optional props: `ogType` (`website` default, `article`, `video.other`) and `meta` (a typed list of `property=`/`name=` + `content=` pairs, rendered one `<meta>` each, immediately after the fixed block). A page that passes neither renders the exact `<head>` it rendered before — every store page does — so the tags below exist only where a news page asks for them.

## Open Graph and Twitter Card by page type (issue #54)

`apps/storefront/src/lib/meta-sosial.ts` builds the page-specific tags as plain data, the same pattern as the JSON-LD builders: one builder per `og:type`, so a page can never pair one type's `og:type` with another type's namespace (Open Graph silently ignores `article:*` under `video.other`, and vice versa).

| Page | `og:type` | Tags added | Built by |
| --- | --- | --- | --- |
| `/berita/{slug}` | `article` | `og:image` + `og:image:width`/`height`/`alt` when the featured image resolved (issue #47's `PostDetail.image`); `article:published_time`/`article:modified_time` (the same raw ISO 8601 `publishedAt`/`updatedAt` the `NewsArticle` JSON-LD carries); `article:section` (the rubrik name); one `article:tag` per tag; `twitter:card` = `summary_large_image` with an image, `summary` without; `twitter:title`, `twitter:description` (clamped to 200 characters), `twitter:image` | `articleSocialMeta(post)` |
| `/video/{slug}` | `video.other` | `og:image` = the post's own featured image when it resolved, else `https://i.ytimg.com/vi/{id}/hqdefault.jpg` — the same featured-image-first precedence `ArtikelCard.astro` uses for a card thumbnail, and the very same poster URL the card and the facade already load. Deliberately NOT `maxresdefault.jpg`: YouTube only serves that for uploads with an HD rendition and 404s the rest, and this app cannot tell which it has — a possibly-404 URL under a `summary_large_image` card is precisely the empty large-image card the `twitter:card` rule avoids; `hqdefault` exists for every valid id; `og:video:url` = `https://www.youtube-nocookie.com/embed/{id}`, the same privacy-enhanced player `video-facade.ts` swaps in on click; `video:release_date`, one `video:tag` per tag; `twitter:card` = `summary_large_image` always (a video post always has some poster) | `videoSocialMeta(post)` |
| `/berita`, `/rubrik/{slug}`, `/daerah/{slug}`, `/mitra/{slug}`, `/video`, `/tag/{slug}`, `/penulis/{slug}`, `/arsip/{yyyy}/{mm}` | `website` | The site logo (`identity.logoMediaId`, resolved through `apps/storefront/src/lib/awcms/media.ts`) as `og:image` + dimensions/alt and a `summary` card — only when the logo actually resolves; a missing or unresolved logo emits nothing, leaving the block exactly as it was. Applied once, in `BeritaLayout.astro` (the shell every news page renders through), never in `BaseLayout`, which is what keeps every store page's block unchanged | `listingSocialMeta(logo)` |
| `/rubrik/{slug}`, `/rubrik/{slug}/halaman/{n}` | `website` | `<link rel="prev">`/`<link rel="next">`, absolute URLs, through `BaseLayout`'s `head` slot (transferred by `BeritaLayout`); page 2's `prev` is the bare `/rubrik/{slug}` URL, never `/halaman/1`, matching the pagination component's own links; a single-page rubrik emits neither | `rubrikPaginationLinks(slug, page, totalPages)` |
| every store page (`/`, `/produk`, `/kategori/{slug}`, `/product/{slug}`, `/halaman/{slug}`, …) | `website` | none — the six fixed tags only, no `og:image`, no `twitter:*`. `apps/storefront/tests/meta-sosial-build-smoke.test.ts` holds these pages to a frozen snapshot of the pre-issue-54 block, in a build where the news listing pages DO gain the logo image | — |

Every `content` value is CMS text (an alt text, a rubrik or tag name, a description) and reaches the page only through Astro's HTML attribute escaping at the one render boundary in `BaseLayout` — the same escaping the six fixed tags already rely on for `og:title`/`og:description`. Nothing in this path uses `set:html`, and `jsonForScript()` (below) is deliberately NOT applied to attribute text: it produces JSON `\uXXXX` escapes, which are not HTML escapes and would render literally. `og:image` is additionally re-checked to be an `http(s)` URL before it is emitted, the same posture `parseSocialLinks` takes for a stored social URL.

Two things this issue considered and did not do: `noindex` on rubrik pages beyond page 1 (Google's own guidance is not to `noindex` paginated archives — `rel=prev/next` plus a self-referencing canonical per page is the shape it recommends), and `og:image:width`/`height` for the YouTube poster (this app has not fetched it and must not assert a size it has not seen).

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

`checkout`, `pesanan`, `cari`, `wishlist`, `keranjang`, `masuk`, `daftar`, and `akun` (issue #88) all carry `<meta name="robots" content="noindex, follow">` via `BaseLayout`'s `head` slot — none of them is a page a search result should ever land a reader on directly. `robots.txt` additionally `Disallow`s the fetch for the same paths (a bare `Disallow: /akun` covers every child account route, including `/akun/afiliasi` added by issue #93, S3 of #32) plus `/api/`.

## Referral capture (`?ref=`) never becomes part of a canonical URL (issue #93)

Every page can be reached with a `?ref={code}` query string appended — a shopper's own referral link. `apps/storefront/src/scripts/afiliasi-tangkap.ts`, mounted from `BaseLayout.astro` on every page (not a single route), reads and captures a valid `ref` value into `localStorage` on load, then calls `history.replaceState` to remove ONLY that one parameter from the visible URL. Two reasons this happens client-side, after the page has already rendered, rather than as a build-time or server-side redirect:

- **The referral must be captured before the query string can disappear.** A server-side redirect that strips `?ref=` before the page ever loads would have nowhere to persist the code first — this static site's server (`apps/storefront/server/penyaji.mjs`) holds no per-visitor state at all ([ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md)), so the ONLY place a referral can be remembered is the browser's own `localStorage`, which only JavaScript can write to.
- **`BaseLayout`'s own `<link rel="canonical">` already omits `?ref=` by construction** — every page's `canonicalPath` prop is the plain route (`/produk`, `/product/{slug}`, …), never a copy of `window.location.search`, so a `?ref=`-carrying URL was never going to be canonicalised to itself in the first place. `history.replaceState` cleaning the ADDRESS BAR (not the canonical tag, which needed no change) is what keeps a shopper's own bookmark or a later share of that same tab's URL from perpetuating the query string a crawler never saw canonicalised to begin with.

The removal touches `ref` only — every other query parameter on the URL (a search page's `?q=`, a paginated archive's own query string, anything else) is left completely untouched, matching this file's own "Disallow stops the fetch, noindex stops the index" posture for query-string-bearing pages elsewhere in this document: `/akun/afiliasi` itself (where the referral link `SITE_URL/?ref={code}` is generated for a shopper to share) is `noindex, follow` for the same reason every other account page is, not because of the query string it links out to.

## Sitemaps and feeds

`apps/storefront/src/lib/sitemap.ts`'s `registerSitemapSource(name, source)` registers a named URL-producing function; twelve sources are registered across catalog and news (`static-routes`, `static-pages`, `berita-front`, `berita-posts`, `berita-video`, `berita-rubrik`, `berita-daerah`, `berita-mitra`, `berita-tag`, `katalog-produk`, `katalog-kategori`, `katalog-product-detail`). `chunkSitemapEntries` splits the combined result into chunks of at most 5,000 URLs each; `sitemap-index.xml` enumerates the resulting `/sitemap-{n}.xml` files. `feed.xml` (products) and `berita/feed.xml` + per-rubrik `rubrik/{slug}/feed.xml` (news, RSS 2.0, `content:encoded`) are separate, hand-built feeds, not sitemap sources.

## Legacy redirects: two layers, rows first

Two mechanisms answer a legacy URL, in this order ([ADR-0013](adr/0013-rule-based-legacy-redirects-beside-the-row-based-map.md)):

1. **The row-based map** below — one `awcms_seo_redirects` row per URL, for facts nobody can derive (an article's old numeric id → its new slug).
2. **The rule module** (`apps/storefront/server/pengalihan-aturan.mjs`, issue #55) — seputarborneo's rubrik/daerah/mitra/UMUM archives, its `/rubriks/?news=&kt=&lanjut=` pagination, its `/video/?video=` shape, its three static pages, its search box and `/img/?news=`, all resolved from a finite table with no CMS row at all. Consulted only when the row map misses, so an operator-authored row always wins.

Search redirects with `302` (it is a query, not a moved document); everything else `301`. See [`docs/routing.md`](routing.md) for the full rule table.

## The legacy-redirect map

Every incoming seputarborneo (`/news/{id}-{slug}.html`) or beritasampit (`/{yyyy}/{mm}/{dd}/{slug}/`) URL is resolved against a map built from `apps/cms`'s own `awcms_seo_redirects` rows and served with a real `301` by `apps/storefront/server/penyaji.mjs` — see [`docs/routing.md`](routing.md) for the exact mechanism. This is the increment-2 answer to increment 1's "not built: sitemap, feed, robots.txt" line — all three now exist, and this redirect map is what makes cutover from either legacy platform not cost every indexed link and bookmark.

## Canonical URLs

Every canonical URL is still absolute, built from `SITE_URL`, matching the live site's URL shape for products — see [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.md).

## Not built

Structured data for the catalog listing page (`/produk`) itself — only category pages and product detail pages carry JSON-LD. An `og:image` on any STORE page (`/`, `/produk`, `/kategori/{slug}`, `/product/{slug}`, `/halaman/{slug}`) — issue #54 built the tag mechanism and uses it on every news page, but the product DTO's own `images[].publicUrl` is not yet wired into it, and the site-logo fallback is deliberately scoped to the news shell so the store pages' block stayed provably unchanged this wave. The composed site profile's `defaultSocialMediaId` — the CMS's own purpose-built "default share image" field — is not yet surfaced by `apps/storefront/src/lib/awcms/profil.ts`, so the listing fallback uses `logoMediaId` for now; wiring `defaultSocialMediaId` first, with the logo as its fallback, is the natural next step. A `product:price:*` Open Graph namespace (the JSON-LD `Offer` node carries this instead, deliberately, per "Per-page metadata" above).
