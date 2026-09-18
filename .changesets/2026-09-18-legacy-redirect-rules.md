---
bump: minor
type: structure
impact: public
---

# Rule-based legacy redirects for seputarborneo's rubrik/daerah/mitra/video/static/search URLs

Issue #28's redirect map only ever knows a URL an operator/import explicitly
recorded as a `awcms_seo_redirects` row — right for a single article, but
seeding one row per rubrik/daerah/mitra/video/static/search URL would mean
hundreds of rows for a handful of fixed, deterministic shapes that
seputarborneo's own `include/nav_menu.php`
(`seputarborneo_rubrik_resolve()`/`_kanonik()`) already encodes as a lookup
table, not a database query.

`apps/storefront/server/pengalihan-aturan.mjs` is a new, pure, table-driven
module for exactly those shapes, wired into `legacyRedirectLocation()`
**after** the row-based map — an operator-authored row always wins on
overlap. It covers `/rubrik/{slug}.html`, `/daerah/{kategori}.html` (plus 14
old city names), `/mitra-borneo/{slug}.html` (24 channels, matching issue
#57's own institution seed list), `/umum/{slug}.html` (UMUM's children are
ordinary rubriks here), `/rubriks/?news=&kt=&lanjut=` pagination,
`/video/?video={id}-{slug}.html`/`{id}_{slug}.html` (resolved only against a
known `/news/{id}-…` row, never a guessed slug), the three static pages, the
search box (302, not 301 — a search result is not permanently moved), and
`/img/?news={id}`/`/index.php`/`/?subscribed=1`.

- `apps/storefront/server/penyaji.mjs`'s `legacyRedirectLocation()` now
  falls through to the new module on a row-map miss; its return shape grew
  to allow `{ location, status }` for the one 302 case, while every
  existing caller (including
  `apps/storefront/tests/berita-penyaji-legacy.test.ts`, unedited) keeps
  working against the plain-string 301 shape it already returned.
- `apps/storefront/tests/pengalihan-aturan.test.ts` covers every rule
  (encoded/decoded input, trailing slash or not), the documented
  `WISATA`/`Wisata` collision (both intentionally land on
  `/rubrik/wisata`), and a loop guard proving no rule's destination matches
  any rule's own source shape.
- `docs/routing.md`/`.id.md`'s "Legacy redirects" section documents the full
  table.
