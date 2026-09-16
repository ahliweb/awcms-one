---
bump: minor
type: structure
impact: public
---

# Storefront site chrome + foundation

`apps/storefront` gains the shared shell every future page needs before it
can be a page: header/nav/search/footer, site identity and brand colors
read from `apps/cms` at build time, static/contact pages, and the
sitemap/robots/feed/manifest surface a public site needs (issue #24).

- Header/footer/mobile-nav, a `<main id="konten">` landmark, and a skip
  link, all built from a new route-constants module — so #27/#28/#30 only
  add pages, never touch the chrome again.
- Site identity (`GET /api/v1/site-profile/composed`) and brand colors
  (`GET /theming/{tenantCode}/tokens.css` — corrected from the issue's
  originally named `GET /api/v1/theming`, which cannot answer this question;
  see `apps/storefront/README.md`) replace the old hardcoded `SITE_NAME`/
  footer, degrading to BjekMart's own public defaults when the CMS has
  nothing rather than failing the build.
- New pages: `/kontak`, `/halaman/[slug]` (CMS pages rendered from Portable
  Text), `/cari`, `/404`.
- New build-time surfaces: `robots.txt`, `sitemap-index.xml`/
  `sitemap-[n].xml` (a registry, so later issues register their own URLs
  without touching this issue's files again), `feed.xml`,
  `manifest.webmanifest`, `theme-tokens.css`.
- `apps/storefront/server/penyaji.mjs` gains `GET /healthz` (reports the
  build id written by a new build step) and a `Link: rel=preload` header
  for the build's CSS — still no `AWCMS_*` read at runtime.
- Two deliberate scope trims, recorded in `apps/storefront/README.md`: no
  CMS-uploaded logo/favicon image is resolved (this app has no
  media-object client, and product/media imagery stays out of scope for
  this re-platform slice), and `/kontak` has no maps iframe or FAQ
  accordion — neither field exists on the real `site_profile` schema.
