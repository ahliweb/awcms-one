# `apps/storefront` — the public BjekMart storefront

The public Astro storefront for `awcms-one` (borneojek-mart's re-platform):
catalog listing, product detail, site chrome (header/nav/search/footer),
CMS-driven identity and theme, static/contact pages, and the SEO/robots/
feed surface a public site needs. Fully static output, fetching
`apps/cms`'s API at BUILD time only — this document explains that rule in
full below, because it is the one invariant every file in this app is
written to protect.

## The static/runtime rule

This app builds once (`astro build`) into flat files under
`apps/storefront/dist/client/`, served afterwards by a plain Bun HTTP
process (`apps/storefront/server/penyaji.mjs`, bundled by `bun run build`
into that same `dist/` output tree). **The running container never talks to
`apps/cms` and holds no API credential at runtime.** Every page's
content — the catalog, the site's identity, its brand colors, its static
pages — is fetched once, while `astro build` runs, and baked into the
output.

This is a security property, not a performance one: a compromise of the
running storefront container reaches no customer data, because there is no
live credential in it to steal. The trade-off, stated plainly rather than
hidden: price, stock, identity, and every CMS-authored page are only as
fresh as the last build. That is the right trade for this stage of the
re-platform (see the root `AGENTS.md`/`README.md` for the wider "increment"
framing); once checkout exists, a runtime read becomes necessary, and that
must be a deliberate, separately argued change to
`apps/storefront/astro.config.mjs`'s `output: "static"` line — never a
drift.

Two files exist specifically to prove this rule holds without a live CMS:

- `apps/storefront/scripts/stub-awcms.mjs` — a local stand-in for
  `apps/cms`, answering every endpoint this app calls from the fixtures
  committed under `apps/storefront/tests/fixtures/awcms/`.
- `apps/storefront/tests/build-smoke.test.ts` — starts that stub, runs a
  real `astro build` against it, and asserts the pages below actually land
  in `dist/client/` with no inline `<script>`/`<style>` anywhere (the CSP
  invariant below).

## Page inventory

| Route | What it is | Data source |
| --- | --- | --- |
| `/` | Home: slider, popular categories, flash-sale strip, featured/recommended products, promo section, public vouchers, testimonials, recent news, promo popup (issue #27) | `GET /api/v1/commerce/products`, `/categories`, and the marketing read models |
| `/produk` | Catalog listing — grid + sidebar, client-side search/filter/sort/pagination over `/index/produk.json` | `GET /api/v1/commerce/products`, `/categories` |
| `/kategori/{slug}` | One page per category (its subtree's products, breadcrumb, `CollectionPage` JSON-LD) | same as above |
| `/flash-sale` | Active + scheduled flash sales, sale price vs. normal price, quota, live countdown | `GET /api/v1/commerce/flash-sales/active` |
| `/product/{slug}` | Product detail: image gallery, variant picker, tiered prices, service-form fields, size chart, promo banner, add-to-cart, share, related products, `Product`/`Offer`/`BreadcrumbList` JSON-LD | same as above |
| `/kontak` | Contact card + `mailto:`/WhatsApp links | `GET /api/v1/site-profile/composed` |
| `/cari` | Client-side product search over `/index/produk.json`; `noindex, follow` | `/index/produk.json` (build-time index) |
| `/halaman/{slug}` | CMS static/legal pages (privacy, TOS, shopping guide, and — once #28's news pages exist — Redaksi/Pedoman Media Siber/Disclaimer), rendered from Portable Text | `GET /api/v1/blog/pages/public[/​{slug}]` |
| `/404` | Not-found page with search + top nav links | none |
| `/robots.txt` | Allow-all + sitemap line + disallowed paths | deployment identity |
| `/sitemap-index.xml`, `/sitemap-{n}.xml` | Registry-driven sitemap, split at 5000 URLs/file | every registered source |
| `/feed.xml` | RSS of products (newest-first is approximated — see that route's own docblock for why the DTO has no timestamp to sort by) | `GET /api/v1/commerce/products` |
| `/manifest.webmanifest` | Web app manifest | site identity + theme + bundled favicon |
| `/theme-tokens.css` | Build-time-generated `--color-primary/secondary/accent` stylesheet | `GET /theming/{tenantCode}/tokens.css` |
| `/product-labels.css` | Build-time-generated per-product badge-color stylesheet | derived from the catalog fetch |
| `/berita`, `/berita/{slug}`, `/berita/feed.xml` | News front page, article detail, RSS 2.0 (issue #28) | `GET /api/v1/blog/posts`/`terms`/`institutions` |
| `/rubrik/{slug}`, `/rubrik/{slug}/halaman/{n}`, `/rubrik/{slug}/feed.xml` | Hierarchical rubrik (category) archive + pagination + feed | same as above |
| `/daerah/{slug}` | Region archive, reached via an institution's `regionCode` | `GET /api/v1/blog/institutions`, `/api/v1/idn-regions/regions` |
| `/mitra/{slug}` | Institution ("Mitra") landing | `GET /api/v1/blog/institutions` |
| `/video`, `/video/{slug}` | Video-news index + detail (a post with a `videoNews` block) | `GET /api/v1/blog/posts` |
| `/tag/{slug}`, `/penulis/{slug}`, `/arsip/{yyyy}/{mm}` | Tag, author (byline-based), and monthly archives | `GET /api/v1/blog/posts`/`terms` |
| `/cari-berita` | Client-side search over `/index/berita.json` | `/index/berita.json` (build-time index) |
| `/index/produk.json` | The product search/listing index every client-side catalog surface reads | derived from the catalog fetch |
| `/csp.json` | The external origins this build references, read at startup by `apps/storefront/server/penyaji.mjs` to widen `img-src`/`connect-src` — see "Content-Security-Policy" below | derived from every image URL the CMS sent, plus `PUBLIC_AWCMS_ORIGIN` |
| `/index/berita.json`, `/index/pengalihan-legacy.json` | The search index, and the legacy-URL redirect map `apps/storefront/server/penyaji.mjs` reads at startup | `GET /api/v1/blog/posts`, `/api/v1/seo/redirects` |
| `/keranjang` | Cart — renders `localStorage`, re-quotes live, voucher/quantity/remove, "Lanjut ke checkout" (issue #30) | `POST <PUBLIC_AWCMS_ORIGIN>/api/v1/commerce/storefront/cart/quote` |
| `/checkout` | One-page, five-step checkout: contact → address → shipping → payment → review → place order | the same quote endpoint, plus `POST …/orders` |
| `/pesanan` | Order tracking by `?kode=`; phone from `sessionStorage`/a form, never the URL | `GET …/orders/{code}`, `POST …/orders/{code}/{payment-confirmations,cancel}` |
| `/wishlist` | `localStorage`-only saved-products list; heart button on `ProductCard.astro` | none (client-side only) |
| `/index/wilayah-provinsi.json`, `/index/wilayah-kabupaten-{code}.json`, `/index/wilayah-kecamatan-{code}.json` | Checkout address region indexes, scoped to `PUBLIC_WILAYAH_PROVINSI` | `GET /api/v1/idn-regions/regions` |

Every non-static-asset route above is prerendered — there is no
`prerender = false` anywhere in this app, and none should be added without
revisiting the static/runtime rule above first.

## Site chrome (issue #24)

`apps/storefront/src/layouts/BaseLayout.astro` renders a header/footer
component pair around every page: skip link first in the DOM, `<header>`/
`<nav aria-label>`/`<main id="konten">`/`<footer>` landmarks, and visible
`:focus-visible` styles throughout. The mobile nav is a native
`<details>`/`<summary>` disclosure — no JavaScript is involved in opening
or closing it; the only client-side `<script>` blocks in this app (the
header's cart-item count, and `/cari`'s query echo) are ordinary
Astro-bundled external modules, never inline — `script-src 'self'`
(`apps/storefront/server/penyaji.mjs`) does not allow any other kind.
Every route this issue's own chrome links to but does not build a page for
yet (`/produk`, `/kategori/{slug}`, `/flash-sale`, `/berita`, and the rest —
#27/#28/#30) is declared once, as a constant, so those issues never need to
touch the chrome files again.

Brand identity and colors come from `apps/cms` at build time:

- The site-identity client (`GET /api/v1/site-profile/composed`: store
  name, tagline, contact details, address, social links). A 403/404 (a
  build credential minted before the module existed, or an older `apps/cms`)
  degrades to BjekMart's own public defaults — a legitimate state, not an
  error. Anything else (5xx, timeout, unreachable) fails the build loudly,
  the same rule the product-catalog fetch already applies.
- The theme client (`GET /theming/{tenantCode}/tokens.css`, **not**
  `GET /api/v1/theming` as the original issue text names — that endpoint is
  session-gated and, verified against `apps/cms`'s own theming module, never
  actually exposes a published version's resolved token values, only
  descriptor defaults, an unpublished draft, and version metadata with no
  config). `tokens.css` is the public route `apps/cms` itself built for
  exactly this purpose — see that client's own docblock for the full
  reasoning, and for why `--color-secondary` has no CMS equivalent at all in
  the registered base theme and always renders BjekMart's own default.

Two known, deliberate deviations from the issue text, recorded here as the
brief this issue was implemented under asks:

1. **No `<img>` logo, and no CMS-uploaded favicon.** The composed identity
   endpoint returns a logo/favicon as media object ids, resolvable only
   through a media-object client this app does not have — increment 1
   (`AGENTS.md`) explicitly excludes product/media imagery from this
   re-platform slice, and issue #24's own file checklist names no such
   client for this app. The brand mark is the store NAME; a bundled default
   SVG icon serves as this deployment's favicon.
2. **`/kontak` has no maps iframe and no FAQ accordion.** Neither a
   maps-embed URL nor an FAQ list exists anywhere on the real site-profile
   schema (verified against `apps/cms`'s own module and its OpenAPI
   fragment) — the page renders every field the endpoint actually returns
   and omits the two that would otherwise have to be invented.

## News surface (issue #28)

`/berita`, `/rubrik/{slug}`, `/daerah/{slug}`, `/mitra/{slug}`, `/video`,
`/tag/{slug}`, `/penulis/{slug}`, `/arsip/{yyyy}/{mm}`, `/cari-berita` —
seputarborneo/beritasampit parity over the CMS's `blog_content` module.
`apps/storefront/src/lib/berita.ts` is the domain layer (mirrors
`apps/storefront/src/lib/catalog.ts`'s shape: one memoized, once-per-build
index; pages never see a term id, an institution id, or a keyset cursor);
`apps/storefront/src/lib/awcms/{blog,wilayah,lembaga,iklan}.ts` are the raw,
field-verified fetchers.

Deliberate deviations from the issue text, recorded here as the brief this
issue was implemented under asks:

1. **No hero `<img>`, no real gallery/ad-creative image, no YouTube
   `<iframe>` embed.** This app still has no media-object client (the same
   gap issue #24 recorded) — a post's `featuredMediaId`/a gallery item's
   `mediaObjectId`/an ad's `mediaPublicUrl` are either bare ids this app
   cannot resolve to a URL, or (the ad case) a real URL this app's CSP
   (`img-src 'self'`, `apps/storefront/server/penyaji.mjs`) has no exemption
   for, and widening that CSP is outside this issue's file ownership (only
   the legacy-redirect hook there is granted).
   `apps/storefront/src/lib/portable-text.ts` renders `videoNews` as a real, semantic outbound link (never an
   `<iframe>`) and a captioned `gallery` item as a real `<figure>`/
   `<figcaption>` with no `<img>` — see that file's own docblock for the
   full reasoning, including why this independently reaches the same
   conclusion the sibling `media-lenterakalteng` app's own ADR-0046 does.
2. **No `article:published_time` Open Graph tag, no `rel=prev/next`, no
   `noindex` beyond page 1.** `BaseLayout.astro` (issue #24, outside this
   issue's file ownership) has no mechanism for a page to add extra
   `<meta>`/`<link>` tags. The same publish/update timestamps are present,
   machine-readable, in every article's `NewsArticle` JSON-LD.
3. **"Terpopuler" is always "latest", never a `visitor_analytics` rollup.**
   No such endpoint was part of this issue's verified-safe read scope.
4. **No footer ad slot.** The verified `AD_PLACEMENT_KEYS`
   (`apps/storefront/src/lib/awcms/blog.ts`) has header/in-article/sidebar
   slots and no footer one at all.
5. **A region's URL slug is DERIVED from its name**
   (`apps/storefront/src/lib/berita.ts`'s `slugifyName`) —
   `idn_admin_regions` issues a `code`, never a slug. An
   institution's own slug, by contrast, passes through from the CMS
   unchanged.
6. **"Internal tag links" needed no renderer change.** Verified against
   `apps/cms`'s `internal-tag-linking.ts`: awcms's own auto-linking is a
   render-time HTML transform on the CMS's own themed pages, never an
   authored Portable Text node — a genuine internal link is already carried
   by the ordinary `link` annotation issue #24 built, and every article
   additionally renders an explicit tag list.
7. **No "transcript link" for a video post.** The verified `videoNews`
   schema (`provider`/`videoId`/`title`/`caption`/`thumbnailMediaObjectId`/
   `durationSeconds`/`sourceLabel`) has no transcript field of any kind —
   there is nothing for this app to link to without inventing one.

## Catalog surface (issue #27)

The full shopper-facing catalog: the home page, `/produk`, `/kategori/{slug}`,
`/flash-sale`, `/cari`, and a product detail page that renders everything the
product model carries — images, variants, tiered prices, service-form fields,
size chart, promo banner, flash-sale price.

Three things about it are load-bearing and easy to undo by accident:

1. **No price arithmetic happens here.** `price`, `finalPrice`, a variant's
   price, a flash-sale price and every tier price are displayed exactly as
   `apps/cms` computed them (ADR-0003); `apps/storefront/src/lib/harga.ts` is the only file
   that converts a price string to a number, and only to format it. A unit
   test greps `src/` for any other `Number(`/`parseFloat(` on a price-shaped
   field.
2. **The cart is a browser-local contract, not a server one.**
   `apps/storefront/src/lib/keranjang-kontrak.ts` defines it — `localStorage` key
   `awcms-one:keranjang:v1`, shape `{id, lines, updatedAt}`, a
   `keranjang:berubah` event dispatched on every write, which the header's
   count listens for. Issue #30's checkout reads exactly this shape; the
   `id` is also the idempotency key an order is created with.
3. **Every client-side script is an external module** under `apps/storefront/src/scripts/`,
   because `script-src 'self'` has no `'unsafe-inline'` and never will.

### Content-Security-Policy: the one exemption, and why it is derived

Product photos are the first thing this storefront references off its own
origin. `images[].publicUrl` comes from `apps/cms`'s `media_library` and
points at that deployment's public media origin (R2, a CDN, or the CMS host
— a deployment's choice, not this app's), so a bare `img-src 'self'` blocks
every one of them **silently**: correct HTML, green build, broken page.

So the policy is widened, by exactly the origins this build actually
references and no others:

- `apps/storefront/src/pages/csp.json.ts` collects every image URL from the same memoized
  fetches the pages rendered from, and writes `dist/client/csp.json`
  (`{version, imgSrc, connectSrc}`) via `apps/storefront/src/lib/csp-asal-media.ts`.
- `apps/storefront/server/penyaji.mjs` reads that file **once at startup**
  (`readCspOrigins`), re-validates every origin (`sanitizeOrigins` — an
  absolute `http(s)` origin with no path, credential, wildcard or separator
  character, or it is dropped), and composes the served policy with
  `buildCsp`.
- A missing, malformed or unknown-version artifact degrades to the baseline
  `img-src 'self'` — images stop rendering, which is visible and fixed by a
  rebuild, rather than a policy silently wider than any build asked for.

It is DERIVED rather than configured (`PUBLIC_MEDIA_ORIGIN`-style) because a
configured origin is one more value to keep in step with the CMS's own
configuration, and a wrong one fails in exactly the silent way this
mechanism exists to prevent. The trade: a catalog with no images yet emits
no origins, so the first product photo needs a rebuild before it renders —
the same rebuild that page already needs (ADR-0002).

### `BaseLayout.astro`'s `head` slot

`<slot name="head" />` is the single extension point in `<head>`, last in
document order so a page can override what the layout already declared
without displacing the charset declaration. `/cari` uses it for
`<meta name="robots" content="noindex, follow">` — `robots.txt`'s
`Disallow: /cari` asks a crawler not to fetch the page, the meta tag tells
one that already has it not to index it, and the two are not
interchangeable. **Never put a `<script>` in this slot**: that would escape
the `script-src 'self'` guarantee the whole app rests on.

## Cart, checkout, order tracking, wishlist (issue #30)

This is the one place ADR-0002's "static build, no runtime CMS credential"
rule meets a real WRITE — the architecture revision tracked at
https://github.com/ahliweb/awcms-one/issues/31 (to be recorded there as an
ADR). The chosen answer is not a runtime route (`prerender = false` stays
absent everywhere — see `apps/storefront/tests/checkout-guard-no-prerender.test.ts`)
but the anonymous, cross-origin commerce endpoint pattern awcms already uses
elsewhere (its own newsletter form, site search, comments): the **browser**
calls `<PUBLIC_AWCMS_ORIGIN>/api/v1/commerce/storefront/*` directly. The CMS
resolves the tenant from the request `Origin` header and answers with CORS —
no cookie, no bearer token, ever. The exact request/response shapes are
fixed by a contract document shared with the CMS-side issue (#29) building
the same routes in parallel; `apps/storefront/src/lib/toko-klien.ts` is this
app's one implementation of the BROWSER half of it.

- **`PUBLIC_AWCMS_ORIGIN`** (required, build-time, deliberately `PUBLIC_`) —
  the CMS origin cart/checkout/tracking POST to. Validated by
  `apps/storefront/src/lib/awcms/toko-origin.ts`, called from
  `apps/storefront/src/pages/csp.json.ts` (a page every build
  unconditionally prerenders) so an unset or malformed value **fails the
  build**, naming the variable — a checkout page that silently posts nowhere
  is the failure this exists to prevent. The same value becomes this
  build's `connect-src` CSP entry, via the identical `csp-asal-media.ts`
  artifact mechanism issue #27 built for `img-src` — never a second
  mechanism.
- **`PUBLIC_WILAYAH_PROVINSI`** (optional, default every Kalimantan
  province) — which provinces' administrative regions
  (`apps/storefront/src/lib/awcms/wilayah-checkout.ts`) get baked into the
  `/index/wilayah-*.json` files the checkout address step fetches
  client-side (same-origin, no CORS/CSP concern at all) — so a deployment
  never bakes in the ~90,000-village national dataset by default.
- **The cart contract stays issue #27's** (`keranjang-kontrak.ts`); this
  issue adds `clearCart()` (`keranjang-klien.ts`) — a FRESH cart id, not a
  cleared `lines` array on the same one, because `cart.id` doubles as the
  order's `idempotencyKey` and must never be reused after the order it
  named has already been placed.
- **The wishlist is a brand-new, parallel, `localStorage`-only contract**
  (`wishlist-kontrak.ts`/`wishlist-klien.ts`), the same pattern as the cart
  but with no server quote at all — a bookmark, not a purchase intent.
  `ProductCard.astro` gained an additive `[data-wishlist]` heart button;
  `apps/storefront/src/scripts/wishlist-tombol.ts` wires up every such
  button SITE-WIDE via event delegation, imported once from `Header.astro`
  (the same place the cart-count script already is) rather than from every
  page that happens to render a card.
- **Every page degrades**: a `<noscript>` block explains that JavaScript is
  required and offers a generic WhatsApp contact link; once JavaScript HAS
  run but a live quote/checkout call fails (CMS down, tenant unresolved), the
  same pages build a REAL cart-summary WhatsApp link instead
  (`apps/storefront/src/lib/wa-fallback.ts`) — pure and unit-tested with no
  DOM.
- **A phone number never appears in a URL.** `/pesanan?kode=` carries only
  the order code; the phone lives in `sessionStorage`
  (`apps/storefront/src/lib/pesanan-sesi.ts`'s `PESANAN_PHONE_KEY`), written
  once by `checkout.ts` on a successful order and read by `pesanan.ts`.
- **`/pesanan/{kode}` does not exist.** A per-code page cannot be
  prerendered (the order does not exist at build time, and enumerating every
  future order code is not a real option) — `/pesanan?kode={code}` is the
  actual URL shape, a documented, deliberate deviation from the issue's own
  `/pesanan/[kode]` naming.

### Browser-level tests (Playwright)

`apps/storefront/tests/e2e/checkout.e2e.ts` exercises add-to-cart → cart
quote renders totals → checkout submits an order → `/pesanan` shows it, plus
the neutral not-found state for a wrong phone — against a REAL built static
site (`bun run build`, stub-backed) served by `bun run serve`/preview and the
extended `apps/storefront/scripts/stub-awcms.mjs` state machine. Run it from
`apps/storefront`:

```bash
bun install   # once — @playwright/test is a devDependency of this workspace only
bun run test:e2e
```

This is a SEPARATE script (`test:e2e`), never part of `bun run build`/`bun
test`/the root suite: `bunfig.toml`'s root exclusion only ever kept
`apps/cms` out, and a browser dependency in the root `bun test` invocation
would make every contributor's `bun test` need Chromium installed to pass.
The spec file's own `*.e2e.ts` suffix (not `*.test.ts`) is what keeps it out
of `bun test`'s own file discovery, the same trap-avoidance the repo's
`playwright` skill documents for any project mixing a unit-test runner with
Playwright.

**Running it in CI later** (not wired into `.github/workflows/ci.yml` by
this change — that file is out of this issue's scope): a job would need (1)
`bunx playwright install chromium` (no `--with-deps` unless the runner image
already has the OS libraries, or is given root), (2) start
`apps/storefront/scripts/stub-awcms.mjs`, (3) a stub-backed `bun run build` with
`PUBLIC_AWCMS_ORIGIN` pointed at the stub's own origin, (4) `bun run serve`
(or `astro preview`) against that build, with `STUB_ALLOWED_ORIGIN` (the
stub's CORS allow-list) set to match whatever port step 4 actually listens
on, then (5) `bun run test:e2e` with `E2E_BASE_URL` pointed at step 4's
origin. Steps 2–4 are exactly what `apps/storefront/tests/checkout-build-smoke.test.ts`
already automates for the build-only assertions; the e2e job would be that
same shape with a real browser added on top.

## Environment variables

See `apps/storefront/.env.example` for the full, current list with
rationale. New in issue #24: `AWCMS_TENANT_CODE` (optional) — this tenant's
public code, used only by the theme client above; unset is a normal state
that falls back to BjekMart's default palette.

Every variable is read at BUILD time only. `apps/storefront/server/
penyaji.mjs` reads `PORT`/`HOST` and nothing else — a finished build never
contacts `apps/cms` again, and `/healthz` (added in issue #24) proves it: it
reports `{ ok: true, build: <id> }` from a build id file `astro build`'s
companion step writes, never a live CMS check.

## The stub workflow

Two terminals, from `apps/storefront`:

```bash
bun scripts/stub-awcms.mjs
# in a second terminal:
AWCMS_API_URL=http://localhost:4310 AWCMS_API_TOKEN=stub-token \
  SITE_URL=http://localhost:4321 bun run build
```

The stub answers every endpoint this app calls (`/api/v1/commerce/*`,
`/api/v1/site-profile/composed`, `/api/v1/blog/pages/public[/​{slug}]`,
`/theming/{tenantCode}/tokens.css`, and — issue #28 — `/api/v1/blog/
{posts,terms,institutions}`, `/api/v1/idn-regions/regions`, `/api/v1/
news-portal/ad-placements/active`, `/api/v1/seo/redirects`) straight from
the committed fixtures, and — issue #30 — `/api/v1/commerce/storefront/*`
as a small in-memory STATE MACHINE (quote → create order → track → confirm
payment → cancel) rather than a fixed fixture, since these routes are
mutations; `STUB_ALLOWED_ORIGIN` (default `http://localhost:4321`) is the
one `Origin` it answers, matching the anonymous cross-origin CORS contract
these routes implement for real.
under `apps/storefront/tests/fixtures/awcms/` — a reviewer can read the
exact response shape this app was built against as plain JSON/CSS, not a
shape hidden inside the script. It is not part of the production build or
image: nothing under `apps/storefront/src/`, `apps/storefront/
astro.config.mjs`, or `apps/storefront/server/penyaji.mjs` imports it, and
no `package.json` script wires it into `bun run build` — it is a manual,
explicit step for local/CI verification against a build with no live CMS to
reach.

## Test tiers

Run from the ROOT (`bun test`) — `bunfig.toml` only excludes `apps/cms`, so
this app's tests are part of the same root gate suite:

1. **Pure unit tests** (color math, the Portable Text renderer, the sitemap
   registry, theme-token parsing, site-identity merging, the route
   constants) — no network, no filesystem beyond a fixture, fast. These are
   what a change to any of that logic should be caught by.
2. **The server test** — the server's pure helpers directly (cache-control
   classification, the old `/products` redirect, build-id reading, CSS
   preload discovery), then real HTTP requests against a server built
   in-process (no `dist/` build needed) to assert headers, `/healthz`, and
   the CSS preload `Link` header end to end.
3. **The build smoke tests** — run a REAL `astro build` against the stub CMS
   above and inspect the actual `dist/client/*` output; each issue that
   needs one adds its OWN file rather than editing a prior issue's
   (`build-smoke.test.ts` #24, `katalog-build-smoke.test.ts` #27,
   `berita-build-smoke.test.ts` #28, `checkout-build-smoke.test.ts` #30).
   Each is bounded under ~60s; if `bun` cannot be spawned in the environment
   running the suite, it reports SKIPPED with a named reason rather than a
   false pass.
4. **Browser-level Playwright tests** (issue #30, `apps/storefront/tests/
   e2e/`) — the top of the pyramid, run by their OWN `bun run test:e2e`
   script from `apps/storefront`, never by `bun test`/the root suite (a
   browser dependency has no business gating every contributor's unit-test
   run). See "Cart, checkout, order tracking, wishlist" above for how to run
   it and how CI could run it later.
