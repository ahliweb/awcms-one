---
bump: minor
type: content
impact: public
---

# Storefront news surface (article/rubrik/daerah/mitra/video/tag/search)

`apps/storefront` gains the seputarborneo/beritasampit-parity news surface
over `apps/cms`'s `blog_content` module: `/berita` (front page + article
detail + RSS), a hierarchical `/rubrik/{slug}` archive (with pagination and
its own feed), `/daerah/{slug}` (region archive, reached via an
institution's region), `/mitra/{slug}` (institution landing), `/video`
(posts carrying a `videoNews` block), `/tag/{slug}`/`/penulis/{slug}`/
`/arsip/{yyyy}/{mm}`, and `/cari-berita` (client-side search over a
build-time index) — issue #28.

- `apps/storefront/src/lib/berita.ts` is the new domain layer (mirrors
  `apps/storefront/src/lib/catalog.ts`'s shape: one memoized,
  once-per-build index); `apps/storefront/src/lib/awcms/{blog,wilayah,
  lembaga,iklan}.ts` are the raw, field-verified fetchers, every shape
  checked against the actual route/application code rather than the issue
  text or the OpenAPI doc alone.
- `apps/storefront/src/lib/portable-text.ts` (issue #24) is EXTENDED, not
  replaced: a well-formed `videoNews` block now renders a real, semantic
  outbound link (never an `<iframe>` — this app's CSP has no exemption for
  one, and widening it is outside this issue's scope) and a captioned
  `gallery` item renders a real `<figure>`/`<figcaption>` (never an
  `<img>` — still no media-object client). Every one of issue #24's own
  existing assertions in `apps/storefront/tests/portable-text.test.ts`
  still passes unmodified.
- A static legacy-URL redirect map (seputarborneo's `/news/{id}-{slug}.html`,
  beritasampit's `/{yyyy}/{mm}/{dd}/{slug}/`) is baked at build time
  (`apps/storefront/src/lib/pengalihan-legacy.ts`,
  `apps/storefront/src/pages/index/pengalihan-legacy.json.ts`) from
  `apps/cms`'s own `awcms_seo_redirects` (`origin: "legacy_blog"`) and
  applied by a new, additive hook in `apps/storefront/server/penyaji.mjs`
  — read once at server startup, never at request time.
- A guard test (`apps/storefront/tests/berita-guard-no-news-route.test.ts`)
  asserts no `/news/**` route family is ever introduced — that vocabulary
  is reserved by awcms ADR-0071 for `ahliweb/awcms-astro`, not this
  storefront.
- Six deliberate scope trims, recorded in `apps/storefront/README.md`'s new
  "News surface" section: no hero/gallery/ad-creative `<img>` and no
  YouTube `<iframe>` embed (no media-object client, and CSP widening is
  outside this issue's file ownership); no `article:published_time`/
  `rel=prev/next`/`noindex` (`BaseLayout.astro` has no head-extension
  mechanism); "Terpopuler" is always "latest" (no `visitor_analytics`
  endpoint in this issue's verified scope); no footer ad slot (none exists
  server-side); a region's slug is derived from its name (no CMS-issued
  one); "internal tag links" needed no renderer change (awcms's own
  auto-linking is a CMS-side render-time transform, not an authored node).
