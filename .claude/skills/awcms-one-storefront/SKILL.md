---
name: awcms-one-storefront
description: Add or change a page/route in apps/storefront correctly. Use when adding a new URL, a new client-side script, or a new fetch from apps/cms. Enforces output:"static" with no prerender=false, the build-time-vs-browser-runtime split, the stub-backed build workflow, and the derived CSP.
---

🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](SKILL.id.md)

# awcms-one — Add a storefront page

Follow [`docs/arsitektur.md`](../../../docs/arsitektur.md), [`docs/routing.md`](../../../docs/routing.md), [ADR-0002](../../../docs/adr/0002-static-output-with-build-time-fetch-for-the-storefront.md), and [ADR-0007](../../../docs/adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md) for the full reasoning; this skill is the practical how-to.

## The one rule that governs every page in this app

**`apps/storefront` is `output: "static"`. No page may set `prerender = false`, ever — not even a page that needs live data.** A unit test (`apps/storefront/tests/checkout-guard-no-prerender.test.ts`) greps every file under `apps/storefront/src/pages` for the string and fails the build if it finds one. There are exactly two ways a page gets data, and every page in this app uses one or the other, never a third:

```mermaid
flowchart LR
  A[New page needs data] --> B{Known at BUILD time?}
  B -->|Yes — catalog, news, marketing, site profile| C["Fetch it in getStaticPaths()/frontmatter via apps/cms's OWNER API — AWCMS_API_TOKEN, server-side, build only"]
  B -->|No — a live quote, an order, a cart action| D["Ship a client-side script that calls apps/cms's ANONYMOUS storefront API directly from the browser — PUBLIC_AWCMS_ORIGIN, CORS, no credential"]
```

If you find yourself wanting a third option — a server-rendered route, a runtime credential in `apps/storefront/server/penyaji.mjs` — stop and read ADR-0007's trade-off table first. That exact idea was proposed and rejected for cart/checkout.

## Choose the profile group first (issue #137, ADR-0018 D2/D3)

Every page belongs to exactly one build-profile group — `shared`, `toko`, or `berita` — decided by [ADR-0018's profile matrix, kept current in `docs/template.md`](../../../docs/template.md#the-profile-matrix). Before adding a route, ask which group it belongs to:

- **Every profile ships it** (a page every deployment needs, regardless of commerce/news) → `shared` → the file goes under `apps/storefront/src/pages/**`, exactly as ordinary Astro file-based routing.
- **Only a commerce build ships it** (cart, checkout, product, category, account…) → `toko` → the file goes under `apps/storefront/src/profil/toko/pages/**`, same relative path it would have had under `src/pages/`.
- **Only a news build ships it** (article, rubric, author, region…) → `berita` → `apps/storefront/src/profil/berita/pages/**`.

`apps/storefront/integrations/profil.mjs` injects every page under an active group's `pages/**` before Astro scans `src/pages/` — the route pattern is derived from the file's path exactly like ordinary file-based routing (`feed.xml.ts` → `/feed.xml`), and no page in either location may set `prerender = false`. Register the route in `apps/storefront/src/config/routes.ts`'s `ROUTE_GROUPS` regardless of which group it is in — an unannotated key is a type error. Add the new file to the matrix in `docs/template.md` in the same change; `apps/storefront/tests/profil-integrasi.test.ts` fails the build if the tree and that table disagree. If the page adds a nav link, a footer link, a sitemap source, a feed, or a robots rule, wire it through `apps/storefront/src/config/profil.ts` (per-group lists) rather than adding a standalone conditional elsewhere — that module is the single place every profile-aware consumer reads from.

## Adding a build-time page (the common case: catalog, news, a static page)

1. Add the route file under the group's `pages/` directory chosen above (`apps/storefront/src/pages/` for `shared`, `apps/storefront/src/profil/<group>/pages/` for `toko`/`berita`) — Astro file-based routing either way (`foo/[slug].astro` → `/foo/{slug}`). Register it in `apps/storefront/src/config/routes.ts` if the route is one other pages link to.
2. Fetch its data in the page's frontmatter or a `getStaticPaths()`, through a function in `apps/storefront/src/lib/awcms/` (e.g. `catalog.ts`, `blog.ts`, `pemasaran.ts`) — never a raw `fetch()` inline in a page. These functions call `apps/cms`'s **owner** API (`AWCMS_API_TOKEN`, read-only, build-time only) and are memoized per build, so multiple pages reading the same resource do not refetch it.
3. If the page renders an image whose origin isn't already `'self'`, or otherwise needs a new external origin, check [`docs/arsitektur.md`](../../../docs/arsitektur.md)'s CSP section — `img-src` is *derived*, not configured; a new image field usually needs no CSP change at all, because `csp-asal-media.ts` collects origins from content automatically.
4. If the page should appear in the sitemap, register a source: `registerSitemapSource(name, asyncFn)` in `apps/storefront/src/lib/sitemap-sources.ts` or `sitemap-katalog.ts`.
5. If the page is transactional/personal (an account page, a search results page, anything that should not be indexed), add `<meta slot="head" name="robots" content="noindex, follow" />` through `BaseLayout`'s `head` slot, and add it to `robots.txt.ts`'s `Disallow` list.
6. Every user-facing string is Indonesian, unconditionally — no i18n framework in this app (see [`docs/ui-ux.md`](../../../docs/ui-ux.md)).
7. Keep the landmark/skip-link contract: `BaseLayout` renders no `<h1>` — your page owns exactly one. Every interactive element is a real, focusable HTML element — never a `<div>` with a click handler.

## Adding a runtime (browser-calls-`apps/cms`) page or script

This is the cart/checkout/order-tracking/wishlist pattern — use it only when the data genuinely cannot be known at build time (an individual shopper's cart, a specific order).

1. The page itself is still a plain static `.astro` file with **no** `prerender = false`. All the runtime behaviour lives in a client-side script (`apps/storefront/src/scripts/`), loaded as an ordinary external module (`script-src 'self'` has no `'unsafe-inline'` and never will — every script is a real file, never inline).
2. Call `apps/cms`'s **anonymous** API through `apps/storefront/src/lib/toko-klien.ts` — one function per endpoint, every request `mode: "cors"` / `credentials: "omit"`, only a `Content-Type` header. Never call `fetch()` against `apps/cms` directly from a new script; add a function to `toko-klien.ts` instead, so the error-envelope handling (`TokoApiError`, field-level `VALIDATION_ERROR`, `409 CART_CHANGED`, `429` with `Retry-After`) stays in one place.
3. `PUBLIC_AWCMS_ORIGIN` — read through `apps/storefront/src/lib/awcms/toko-origin.ts`'s `requireAwcmsOrigin()` — is the only way this app knows which CMS to call at runtime. It is validated once, at build time, from `apps/storefront/src/pages/csp.json.ts` (a page every build unconditionally prerenders), so a missing/malformed value fails the **build**, not a shopper's page load.
4. Provide three fallbacks, matching every existing runtime page: a `<noscript>` message, a JS-ran-but-CMS-unreachable WhatsApp fallback (`apps/storefront/src/lib/wa-fallback.ts`), and `aria-live="polite"` on the region that updates (see [`docs/aksesibilitas.md`](../../../docs/aksesibilitas.md)).
5. Never trust a build-time price/stock number into a write. The cart re-quotes live before checkout for exactly this reason — a static page's own numbers are a display, never an input to an order.

## Adding an authenticated (signed-in-customer) page

This is the `/akun*` pattern (issues #88/#90/#93) — a fourth variant of the runtime pattern above, for a page that needs to know whether the shopper is signed in, not just anonymous runtime data.

1. The page itself is still a plain static `.astro` file — a static SHELL rendering both the guest and signed-in states in markup, never a route that decides server-side. A client-side script (`apps/storefront/src/scripts/akun-*.ts`) reads the session via `bacaSesi()` (`apps/storefront/src/lib/akun-sesi.ts`) and toggles which state shows — the same split every existing `/akun*` page uses.
2. Never invent a second session shape. `akun-sesi.ts` owns the stored `{token, expiresAt, account}` shape (`localStorage` key `awcms-one:akun:v1`) and fires `akun:berubah` on change; `akun-klien.ts` is the one place that attaches `Authorization: Bearer …` to a request. Add a new account-scoped endpoint as a function in `akun-klien.ts`, matching the one-function-per-endpoint convention `toko-klien.ts` already established for the anonymous API.
3. **A `401 UNAUTHENTICATED` from any bearer-secured route clears the stored session** (`akun-klien.ts` calls `hapusSesi()` on it) — never leave a stale/expired token sitting in `localStorage` after a call reports it invalid. This is the one behaviour every authenticated page must inherit, not reimplement.
4. `noindex, follow` via `BaseLayout`'s `head` slot, same as every other transactional page, **plus** `robots.txt.ts`'s `Disallow` list — a bare `Disallow: /akun` already covers every child route, so a new page under `/akun/*` needs no `robots.txt` change; a new TOP-level account route (not under `/akun`) does.
5. Extend `apps/storefront/scripts/stub-awcms.mjs`'s `/account/*` state machine and `apps/storefront/tests/fixtures/awcms/customer-accounts.json` for a new endpoint, the same way you would extend the stub for a new anonymous endpoint — the fixture's two seeded orders (one before, one after `historyFrom`) exist specifically so a build-smoke test can prove a boundary like ADR-0016 D4's is respected, not merely that a list renders.
6. Add a dedicated build-smoke test (`akun-*-build-smoke.test.ts`) asserting the real, built HTML: the page exists, carries `noindex`, hides whatever should only appear once JavaScript proves a session, and has no inline script/style — the same standard `akun-build-smoke.test.ts`/`akun-dashboard-build-smoke.test.ts`/`afiliasi-build-smoke.test.ts` already hold every account page to.

## Three things increment 3 added that a new page must respect

1. **Media is resolved, never constructed.** A CMS field that carries an image is a bare id; resolve it with `resolveMedia` (`apps/storefront/src/lib/awcms/media.ts`) and render nothing when it does not resolve. Never build a URL from an id and an origin — [ADR-0011](../../../docs/adr/0011-storefront-media-resolves-through-the-media-objects-endpoint.md) exists because that guess was the obvious-looking wrong answer. If your page introduces a new image origin, it flows into the derived CSP automatically **only** because the page resolved it through that client; a hand-added origin in `csp.json.ts` is a smell.
2. **A client-side script is an external module, mounted once from a layout.** Inline `<script>` bodies never run under this app's CSP (`script-src 'self'`, no nonce on a static site). Put the code in `apps/storefront/src/scripts/`, `import` it from one `<script>` block in the layout that owns the surface, and make the markup work without it — the read-aloud player (`hidden` until proven supported) and the Daerah panel (fully rendered, only collapsed by script) are the two patterns to copy.
3. **A new page that is both a landing page and a parent of children needs no special handling — but know why.** Under `build.format: "file"` it is emitted as `name.html` beside `name/`, and `apps/storefront/server/penyaji.mjs` rewrites the shadowed path at startup ([issue #75](https://github.com/ahliweb/awcms-one/issues/75)). If you add such a page, add it to `apps/storefront/tests/penyaji-bayangan-build-smoke.test.ts`'s list rather than assuming the discovery covers it silently.

## Verifying your change

```bash
# terminal 1
bun scripts/stub-awcms.mjs
# terminal 2, inside apps/storefront
AWCMS_API_URL=http://localhost:4310 AWCMS_API_TOKEN=stub-token \
  PUBLIC_AWCMS_ORIGIN=https://cms.example.com SITE_URL=http://localhost:4321 bun run build
```

`apps/storefront/scripts/stub-awcms.mjs` serves every endpoint this app calls, including the storefront-commerce state machine (quote → create order → track → confirm payment → cancel) from fixtures under `tests/fixtures/awcms/`. If your page calls a new endpoint, extend the stub and its fixtures in the same change — a page whose only proof of correctness is "it compiled" is not proven.

```bash
bun run check         # astro check — type errors, checks every profile's src/profil/** too
bun test               # from the repo root — every storefront unit/build-smoke/route test runs here (SITE_PROFILE=toko, the default)
bun run test:e2e        # inside apps/storefront, only for a real cart/checkout/tracking change — Playwright, real Chromium
```

**If your page is not in the `shared` group, also run its own profile's smoke tests** — the default `bun test` pins `SITE_PROFILE=toko` (or builds all three, for the `profil-*` suites specifically), so a `berita`-only regression can otherwise hide behind a green default run:

```bash
cd apps/storefront
SITE_PROFILE=berita bun run check                                              # or landing
SITE_PROFILE=berita bun test tests/profil-build-smoke.test.ts tests/profil-routes.test.ts
```

Local CI runs exactly this as three legs (`local-ci/check-toko`, `local-ci/check-berita`, `local-ci/check-landing` — all three are required commit statuses on `main`, posted by `bun run ci:pr -- <n>`; ADR-0021); see [`docs/pengujian.md`](../../../docs/pengujian.md)'s "build-profile tier" for what each assertion actually proves.

`bun run audit:dokumen`/`audit:translation` (from the root) if you touched a `docs/**` file in the same change — see [`docs/pengujian.md`](../../../docs/pengujian.md) for what each tier actually proves.
