🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0002-static-output-with-build-time-fetch-for-the-storefront.id.md)

# ADR-0002 — The storefront is `output: "static"`, fetching the catalog at build time

- **Status:** Accepted
- **Date:** 15 September 2026
- **Decision maker:** ahliweb
- **Related:** [issue #1](https://github.com/ahliweb/awcms-one/issues/1); [issue #5](https://github.com/ahliweb/awcms-one/issues/5) (the storefront itself, and the decision recorded there); [`docs/arsitektur.md`](../arsitektur.md); [`docs/deployment.md`](../deployment.md)

## Context

`apps/storefront` is modelled on the sibling `ahliweb/awcms-astro`/`ahliweb/media-lenterakalteng` family — public sites that read from an `awcms` backend and publish HTML. That family made this same choice before this repository existed; issue #5 re-argues it here because increment 1 has no cart, no checkout, and no runtime write, which is exactly the case where a static build is strongest and a live request path buys nothing.

The alternative was `output: "server"` with `@astrojs/node` rendering each request on demand — reaching `apps/cms`'s API live, per visit.

## Decision

`apps/storefront` builds with `output: "static"` (`astro.config.mjs`). `astro build` fetches the full product and category catalog from `apps/cms`'s public API **once, at build time**, using a build-time-only, read-only Bearer token (`AWCMS_API_TOKEN`), and bakes every page to a flat file. `@astrojs/node`'s `standalone` adapter is present only to **serve** that build — `apps/storefront/server/penyaji.mjs` is a hand-written Bun HTTP server that hands requests to the adapter's file lookup and sets response headers; no route declares `prerender = false`, and the running container never opens a connection to `apps/cms` or its database at any point after the build finishes.

| | build-time static fetch | runtime server-rendered fetch |
| --- | --- | --- |
| Security | container holds no API token, no DB path — a storefront compromise reaches no customer data | a live credential and a live network path exist in the request path, at all times |
| Performance | every page is a static file; no per-request round trip to `apps/cms` | one or more `apps/cms` calls per request |
| SEO | fully rendered HTML at first byte, stable canonical URLs | same, if rendered server-side, but adds a live dependency to every crawl |
| Operational cost | an `apps/cms` outage does not take the storefront down | an `apps/cms` outage is a storefront outage |
| Freshness | price and stock are only as fresh as the last build | always current |

**The trade-off is stated plainly, not hidden:** price and stock are as fresh as the last build. For increment 1 — catalog listing and product detail, no cart — that is the right trade; a stale price on a page nobody can yet add to a cart costs nothing a rebuild does not fix. Once checkout exists, stock and price need a runtime read to avoid overselling or misquoting, and **that must be a deliberate, separately argued change to this decision — not a drift** that starts by adding "just one" runtime call and ends with the container quietly holding a live credential again.

CSP-strict build settings reinforce the same boundary from a different angle: `compressHTML: true`, `build.inlineStylesheets: "never"`, and `vite.build.assetsInlineLimit: 0` (`astro.config.mjs`) mean no stylesheet, script, or small asset is ever inlined — every one of them ships as a same-origin file, so `apps/storefront/server/penyaji.mjs`'s CSP (`style-src 'self'`, `script-src 'self'`, no `'unsafe-inline'` anywhere) needs no exemption to hold. `build.format: "file"` and `trailingSlash: "never"` keep the emitted file and the served URL byte-identical (see [ADR-0005](0005-product-urls-match-the-live-sites-shape.md)), so there is no directory-index rewrite standing between what is built and what a crawler indexes.

## Consequences

- A build that cannot reach `apps/cms`, or that gets back an error envelope, **fails loudly** (`apps/storefront/src/lib/awcms/client.ts`'s `awcmsGet` throws on a non-2xx or `{success: false}` response, with no retry). A static build is not a request path: the failure mode this app must avoid is a *successful* deploy that silently ships an empty or stale catalog, not a red build.
- `getProducts()` (`apps/storefront/src/lib/catalog.ts`) additionally refuses to build if `apps/cms` returns products but not one of them has `status: "active"` — the same reasoning one level up: a filter that can only ever narrow the catalog needs a floor, because a build that quietly publishes zero products with every gate green is worse than one that says why.
- Nothing in this increment reads `apps/cms` at request time. A runtime stock read, a live price check, or anything cart-shaped is explicitly **not built** — see [`docs/arsitektur.md`](../arsitektur.md) and [`docs/cms.md`](../cms.md) for the full list of what this slice excludes.
