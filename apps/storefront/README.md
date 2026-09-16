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
| `/` | Catalog grid | `GET /api/v1/commerce/products`, `/categories` |
| `/product/{slug}` | Product detail, `Product` JSON-LD | same as above |
| `/kontak` | Contact card + `mailto:`/WhatsApp links | `GET /api/v1/site-profile/composed` |
| `/cari` | Search landing (query echoed client-side; #27 fills in real results) | none — static shell |
| `/halaman/{slug}` | CMS static/legal pages (privacy, TOS, shopping guide, and — once #28's news pages exist — Redaksi/Pedoman Media Siber/Disclaimer), rendered from Portable Text | `GET /api/v1/blog/pages/public[/​{slug}]` |
| `/404` | Not-found page with search + top nav links | none |
| `/robots.txt` | Allow-all + sitemap line + disallowed paths | deployment identity |
| `/sitemap-index.xml`, `/sitemap-{n}.xml` | Registry-driven sitemap, split at 5000 URLs/file | every registered source |
| `/feed.xml` | RSS of products (newest-first is approximated — see that route's own docblock for why the DTO has no timestamp to sort by) | `GET /api/v1/commerce/products` |
| `/manifest.webmanifest` | Web app manifest | site identity + theme + bundled favicon |
| `/theme-tokens.css` | Build-time-generated `--color-primary/secondary/accent` stylesheet | `GET /theming/{tenantCode}/tokens.css` |
| `/product-labels.css` | Build-time-generated per-product badge-color stylesheet | derived from the catalog fetch |

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
`/theming/{tenantCode}/tokens.css`) straight from the committed fixtures
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
3. **The build smoke test** — the one test that runs a REAL `astro build`
   against the stub CMS above and inspects the actual `dist/client/*`
   output. Bounded under ~60s; if `bun` cannot be spawned in the environment
   running the suite, this test reports SKIPPED with a named reason rather
   than a false pass — it never silently reports green for a build that
   never ran.
