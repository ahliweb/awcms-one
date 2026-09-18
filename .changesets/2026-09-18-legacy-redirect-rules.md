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
overlap. It covers `/rubrik/{slug}.html` (including `VIDEO`/`video` → the
`/video` list, not a rubrik archive), `/daerah/{kategori}.html` (plus 14 old
city names), `/mitra-borneo/{slug}.html` (24 channels, matching issue #57's
own institution seed list), `/umum/{slug}.html` (UMUM's children are
ordinary rubriks here), `/rubriks/?news=&kt=&lanjut=` (the SAME dispatch as
`/{A}/{B}.html`, not a re-derived one), `/video/?video={id}-{slug}.html`/
`{id}_{slug}.html`/the bare `?video={id}` shape (resolved only against a
known `/video/?video={id}-…` row — a DIFFERENT id space from `/news/…`,
never a guessed slug), the three static pages, the search box (302, not
301 — a search result is not permanently moved), and
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

## Post-review corrections (PR #61)

Six defects found reviewing the first version of this change, all fixed on
the same branch:

1. The video rule (`?video={id}-…`) was matching the id against `/news/…`
   rows — `berita_red` (`/news/…`) and `berita_vid` (`/video/?video=…`) are
   two INDEPENDENT MariaDB id spaces (issue #58/B2), so this could redirect
   a reader to a numerically-coincidental, unrelated article. It now looks
   up a `/video/?video={id}-…`/`{id}_…` row exclusively, and also resolves
   the bare `?video={id}` shape the old homepage hard-coded.
2. The `/news/{id}…` id lookup only matched a hyphen separator; issue #58's
   importer documents an underscore template
   (`/news/{legacyId}_{slug}.html`), so a real row could silently miss. Now
   matches `-`, `_`, or `.` (a bare id with no slug).
3. `/rubriks/?news={A}&kt={B}` is exactly `/{A}/{B}.html` per `.htaccess`
   — it now reuses the same rubrik/daerah/mitra/umum dispatch instead of
   always answering `/rubrik/…`, so e.g. `news=daerah&kt=Sampit` correctly
   lands on `/daerah/kotawaringin-timur`, not `/rubrik/kotawaringin-timur`.
4. A `/rubriks/?news=` value that normalizes to empty (e.g. `%21%21%21`)
   no longer produces `Location: /rubrik/`.
5. `/rubrik/VIDEO.html`/`/rubrik/video.html` now redirect to `/video` (its
   own list page) instead of a `/rubrik/video` page this app does not have.
6. The `/news/…`/`/video/?video=…` id lookups now read from an
   `id -> target` index built once per row-based map object and cached
   (`WeakMap`), instead of an `Object.keys` scan repeated on every request
   — load-bearing once issue #58 (B2) imports seputarborneo's ~25k rows.
