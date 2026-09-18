🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0013-rule-based-legacy-redirects-beside-the-row-based-map.id.md)

# ADR-0013 — Rule-based legacy redirects sit beside the row-based map, and a row always wins

- **Status:** Accepted
- **Date:** 18 September 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0005](0005-product-urls-match-the-live-sites-shape.md); issues #55, #58, #75; `docs/routing.md`

## Context

Increment 2 redirected legacy URLs from **rows**: one `awcms_seo_redirects` entry per URL, baked into the build (`/index/pengalihan-legacy.json`) and looked up by `apps/storefront/server/penyaji.mjs`. That is right for an article, whose old numeric id maps to a new slug by a fact nobody can derive — but seputarborneo's other legacy shapes are the opposite. Its rubrik, daerah and Mitra Borneo archives, its two static pages and its search box follow a finite, deterministic pattern that `include/nav_menu.php` itself encodes as a lookup table: 14 regencies, 24 institutions, a handful of rubriks. Seeding a row per URL would mean hundreds of rows for links that resolve identically forever.

## Decision

A pure, table-driven module (`apps/storefront/server/pengalihan-aturan.mjs`) resolves those shapes with no CMS row at all, and `legacyRedirectLocation()` consults it **only after** the row map misses.

| | Rows for everything | Rules for everything | Rows first, rules after (**chosen**) |
| --- | --- | --- | --- |
| Article ids | correct (a stored fact) | impossible to derive | correct |
| Archive URLs | hundreds of seeded rows to maintain | one table, no data | one table, no data |
| Conflict | n/a | n/a | an operator-authored fact beats a derived guess |
| Testability | needs a seeded CMS | pure functions | pure functions plus the existing row tests |

## Consequences

- Two **different** numeric id spaces are kept apart: `berita_red.id_ber` behind `/news/{id}-…` and `berita_vid.id_vid` behind `/video/?video={id}-…`. They are indexed separately; conflating them sends a video URL to an unrelated article.
- The CMS strips the query string from a redirect **source** path, so a video row is stored under the query-free synthetic key `/video/{id}-{slug}.html`; the exporter (#58) writes that shape and the rule module accepts both it and the historical `?video=` form.
- The build-time row map resolves a video post's slug to `/video/{slug}`, never `/berita/{slug}` — one canonical URL per post, as `getPosts()`/`getVideo()` already partition them.
- Search redirects with `302`, not `301`: it is a query, not a moved document.
- A separate, related trap was found and fixed the same way (#75): under `build.format: "file"` a landing page that also has children is emitted as a file **beside** a directory of the same name, and the node adapter rewrote the directory-shaped path to a missing `index.html`. `apps/storefront/server/penyaji.mjs` discovers those shadowed pages once at startup and rewrites to `{path}.html` as the last step before the adapter — after both redirect layers, so no redirect can be shadowed by it.
