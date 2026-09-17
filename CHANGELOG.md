# Changelog

Every entry below is folded from `.changesets/` by `bun run release`, which also tags the release. The version is `MAJOR.MINOR.PATCH`, tagged `vX.Y.Z`; the next version is the largest `bump` declared among the changesets a release folds (see [`.changesets/README.md`](.changesets/README.md)) — never a level chosen at release time from a list of file names.

## [0.3.0] — 2026-09-17

### `bun run check:cms` is green again inside the subtree embed

`apps/cms/tests/version-check.test.ts` asserted that more than 20 git tags were examined — true in a clone of `ahliweb/awcms`, false by construction here, where `git tag` answers with this repo's own `v0.x` line and upstream's tags are deliberately never fetched. The whole CMS gate chain was red on a clean `main` because of it (issue #22).

- The non-vacuity floor is skipped only when `apps/cms` is embedded inside a larger repository; the namespace-conformance and version-not-behind assertions still run.
- `AGENTS.md` now carries a "known local divergences" list under the subtree section, so the next `git subtree pull` conflict on this file is expected rather than a surprise.

### Commerce transactional surface: customers, addresses, orders, payment confirmations, reviews

The transactional half of mart.borneojek.com — customers, addresses, cart quoting, orders and their lifecycle, payment confirmations, reviews (issue #29, epic #21) — plus the **anonymous, cross-origin storefront API** a statically built site calls from the browser with no bearer token, the same pattern already hardened for newsletter/site-search/comments.

- Eight new tables `awcms_commerce_{customers,customer_addresses,orders,order_items,order_events,payment_confirmations,reviews,wishlists}` (`sql/165`–`167`), 7 new permissions (`orders`/`customers`: `read`/`update` only — no admin route creates or hard-deletes either; `reviews`: `read`/`update`/`delete`), 7 new domain events (`order.{created,paid,status_changed,cancelled,expired}`, `voucher.redeemed`, `review.published`), one new scheduled job (`commerce:orders:expire`), 3 new admin screens.
- `domain/cart-quote.ts` composes #23's price calculation and #26's voucher arithmetic in the exact order the storefront contract specifies: subtotal → voucher discount → shipping (zeroed by voucher or store threshold) → insurance (`max(minFee, subtotal × ratePercent)`) → tax (percent of subtotal − discount) → total — every figure a `numeric(14,2)` string, integer-cent arithmetic throughout.
- Anonymous routes under `/api/v1/commerce/storefront/*`: cart quote, order creation (idempotent by a client-supplied key, re-quoting the cart inside the write transaction), order tracking (`orderCode` + phone as the credential, checked inside the query — an unknown code, a wrong phone, and another tenant's order all answer the same neutral 404), payment confirmations, cancel, reviews. Tenant is resolved from the request Origin/Host through `awcms_tenant_domains`, never a caller-supplied header.
- Idempotency reuses the shared `awcms_idempotency_keys` store (it needs only a tenant id, not a principal) rather than a bespoke column. Payment-proof upload answers `503 MEDIA_UNAVAILABLE` in this increment — the existing upload-session flow requires an authenticated principal a guest checkout does not have, and building a second, unreviewed anonymous auth seam for it was judged out of scope; a payment confirmation without a proof image is still fully accepted, and the public store-settings read model now says `payment.proofUpload: false` so the storefront hides the control.
- Customers are guest-checkout rows identified by phone (E.164, kept in the clear — it is also the tracking credential) — real personal data, but not addressable by this codebase's own ADR-0094 subject vocabulary (`tenant_user`/`identity`/`profile`), since there is no account behind a phone number yet (accounts are issue #32). All eight new tables are therefore `unreachableBySubject: true`, the same shape `commerce.testimonials` already uses for free-text personal data with no subject-id column — a genuine erasure/export request is handled as an ordinary admin lookup, outside the automated engine's scope by construction.
- `tools/seed-borneojek-mart.ts` registers the tenant's storefront origins in `awcms_tenant_domains` (manually attested `active`, the one place this script reaches Postgres directly instead of through HTTP — a fresh domain otherwise starts `pending_verification` and this script has no real DNS record to prove) and seeds one customer with two orders in different states (`pending_payment`, `paid`) through the anonymous order-creation path itself.

### Commerce marketing surface: flash sales, vouchers, sliders, testimonials, promo popup, store settings

Everything mart.borneojek.com's home page and promotions run on, as tenant-scoped tables in the one `commerce` module (issue #26, epic #21) — with a public read model per family that `apps/storefront` bakes the home page from, and six admin screens.

Why one module rather than three (the decision is recorded by issue #31, https://github.com/ahliweb/awcms-one/issues/31): every admission touches the same shared registries, and an order references products, flash-sale prices and vouchers as one aggregate.

- New tables `awcms_commerce_{flash_sales,flash_sale_products,vouchers,sliders,testimonials,popups,store_settings}` (`sql/161`–`164`), 22 new permissions, two flash-sale events fired by the `commerce:flash-sales:tick` job, 20 new OpenAPI operations.
- Voucher arithmetic is exact (integer cents, `maxDiscount` cap); `POST …/vouchers/validate` is a read — redemption belongs to the order (#29). Flash-sale status is derived from the window and persisted by the tick, never trusted from the column. At most one active popup per tenant, enforced by a partial unique index.
- Store settings are one versioned `jsonb` document per tenant; the public read model never carries a bank account number, holder, or QRIS reference. `DELETE` resets to defaults by stamping `deleted_at`, which is also what lets the singleton answer the retention question with a column rather than an exemption.
- Two #23 follow-ups: `downloadLink` (a digital product's paid asset) leaves the public product DTO for the admin record; `sizeChartImageUrl` joins it.
- Two latent defects found while proving the seed end to end: batch reads of images/variants bound a JS array straight into `= ANY(…)` (fails on two or more ids — now `tx.array(…)::uuid[]`, with a regression test); and `Bun.SQL` decodes a stored `0.00` as `"0"` through a parameterised query — every money field now passes through `normalizeMoney` so the wire shape is always two decimals.
- `tools/seed-borneojek-mart.ts` applies the #23 product fields and variants, seeds one flash sale, two vouchers, three testimonials, one popup and the live store-settings block (bank account a placeholder), and issues the storefront build credential with every marketing `read`. Product images and sliders stay recorded under `future`: both need a media object, and media objects need the R2-backed upload session.

### `commerce` reaches full BjekMart product-model parity

Issue #23 (part of epic #21) brings `apps/cms`'s `commerce` module from Issue #4's
13-column catalog core to the full legacy `commerce_bj_mart.products` shape, and
gives it the two related tables a real product page cannot render without.

- `awcms_commerce_products` gains every column Issue #4 deliberately deferred:
  tiered pricing (`price_level_2/3/4`), admin-only `cost_price`, weight,
  minimum purchase, manual rating/sold-count, insurance, promo banners, a size
  chart (image or table), a service intake form, subscription period, a
  digital download link, deposit/free-shipping flags, variant attributes, and
  explicit `is_featured`/`is_recommended` merchandising flags.
- Two new tables, `awcms_commerce_product_images` and
  `awcms_commerce_product_variants`, with their own CRUD routes under
  `/api/v1/commerce/products/{id}/{images,variants}`. `commerce` now depends
  on `media_library` so a product image's public URL resolves through
  `MediaLibraryPort`, the same capability `blog_content` already consumes.
- `GET /api/v1/commerce/products` gains `?categoryId=&status=&q=&sort=&
  featured=&recommended=` filters; every product response carries a
  server-computed `finalPrice` (exact integer-cents arithmetic, never a
  float) plus resolved `images[]`/`variants[]`. A new
  `GET .../products/by-slug/{slug}` route serves the storefront's detail
  fetch. `GET /api/v1/commerce/categories` gains `?parentId=` and a computed
  `productCount` per row.
- Restore endpoints for both categories and products
  (`POST .../{id}/restore`), the shape `office-directory.ts` already
  established, with a new `restore` permission on both activity codes.
- `/admin/commerce` is now a full product CRUD screen (filters, create/edit,
  an images picker sourced from the media registry, a variants editor,
  status transition, soft delete, restore); `/admin/commerce-categories` is
  a new category CRUD screen. Both are off `NOT_YET_SCREENED`.
- `packages/kontrak` re-exports the four new unions (`SizeChartType`,
  `SubscriptionPeriod`, `ServiceFormFieldType`, `ProductSort`) from
  `apps/cms`'s `domain/*.ts`, type-only, per ADR-0004.

Deliberate scope decisions, recorded here for #31 to fold into the schema/API
docs:

- `awcms_commerce_categories` also gained a `restored_at` column (the issue's
  own column table only listed it for products) — both restore endpoints need
  the same "when" fact, and this module's README already treats
  `awcms_offices`' restore shape as the precedent for both tables alike.
- Keyset pagination (`cursor`/`nextCursor`) stays scoped to the default
  `sort=newest`; `price_asc`/`price_desc`/`name` return a single bounded page
  (`PRODUCT_LIST_LIMIT` = 100, `nextCursor: null`) rather than a keyset walk
  ordered by a second column.
- `sizeChartMediaId`/a variant's `imageMediaObjectId` are validated as
  UUID-shaped only, not checked for live/verified existence — unlike a
  product IMAGE row's `mediaObjectId`, which is the one write path this issue
  checks against `MediaLibraryPort.isMediaReferenceSafe` before insert. A
  stale/foreign id in either scalar field simply resolves to no public URL at
  render time; RLS still keeps it from crossing a tenant boundary.
- `apps/cms/scripts/client-asset-budget.ts`'s `APP_BUDGET_BYTES` raised
  218,000 -> 219,000 B for the two admin screens' client script (4,974 B,
  measured on a clean build) — no new CSS, both screens reuse the existing
  admin design-system classes.

### Local PostgreSQL via docker compose, seed the BjekMart tenant, CI job for check:cms

Increment 2 needed a real PostgreSQL somewhere before `apps/cms` could migrate, run, or be seeded at all — issue #1's epic explicitly deferred it past increment 1's no-database foundation. This closes that gap for local development and CI, without touching production provisioning (still not done — see `docs/deployment.md`).

- `compose.yaml` + `docker/postgres-init/` — a disposable `postgres:18.4`, project `awcms-one`, host port 5433. Creates ONLY the `LOGIN` half of the three roles `apps/cms`'s own migrations (`sql/019`, `sql/022`) already create `NOLOGIN` and passwordless on purpose; every `GRANT` stays the migrations' job.
- `bun run db:up` / `db:down` / `db:reset` — new root scripts.
- `tools/seed-borneojek-mart.ts` (`bun run db:seed:cms`) — an idempotent HTTP client of `apps/cms`'s own `/api/v1/*` surface (never a direct import of its internals, since that module is mid-flight on another branch). Bootstraps the `borneojek-mart` tenant + owner, the 8-category catalog, one representative product per commerce `type`, a handful of blog terms/pages/posts, the site profile, and a read-only machine credential scoped to `commerce.products.read`/`commerce.categories.read` — the same shape `apps/storefront`'s build token needs. `tools/seed-data/*.json` separates each resource's `current` (what the API accepts today) from `future` (images, variants, `service_form`, `subscription_period`, tiers — issue #23's fields), so landing those is a data change, not a script restructure. `tools/seed-assets/` carries small, self-generated SVG placeholders for the extension point — no downloads from the live site.
- `.github/workflows/ci.yml` — new `check-cms` job (`needs: check`, `timeout-minutes: 20`): `apps/cms`'s own full `bun run check` against `DATABASE_URL=""`, then migrate + `bun test tests/integration/` against a real `postgres:18.4` service, with a job-summary line recording the DB-gated skip count before and after. Not yet a required status on `main` — `docs/alur-kerja-pengembangan.md` records the exact `gh api` command and the "green twice in a row" condition for a maintainer to run it.
- `docs/deployment.md` — the full local sequence, in order, with real values; what the seed script deliberately does not seed (legacy shipping/payment/customer-level settings with no API surface today) and why.
- `docs/alur-kerja-pengembangan.md` — the CI section now describes both jobs.
- Root `.env.example` — every new variable (`POSTGRES_*`, `AWCMS_*_PASSWORD`, `AWCMS_BASE_URL`, `SEED_*`), each with the consequence of leaving it unset.

### Storefront catalog parity: home, listing, category, flash sale, product detail

The public storefront now matches mart.borneojek.com's catalog surface end
to end, still static (ADR-0002): a real home page (slider, popular
categories, a flash-sale strip with a live countdown, featured/recommended
products, a promo section, a public-voucher strip, testimonials, recent
news, a promo popup), `/produk` (grid + sidebar, client-side search/filter/
sort/paginate over a build-time JSON index), `/kategori/[slug]`,
`/flash-sale`, and a full `/product/[slug]` (image gallery, tiered pricing,
variant picker, service-form fields, "Tambah ke keranjang", share buttons,
related products, structured data).

Why this shape rather than a thinner slice: increment 1 (issue #5) proved
the stack with a bare catalog grid and a minimal detail page — this closes
the gap to what a shopper on the live site actually sees, using the full
product/category model issue #23 landed and the marketing read models issue
#26 is landing in parallel (every marketing fetch is isolated to
`apps/storefront/src/lib/awcms/pemasaran.ts` and tolerates a 404 until then).

- The `localStorage` cart contract issue #30 builds on:
  `apps/storefront/src/lib/keranjang-kontrak.ts` — key `awcms-one:keranjang:v1`, shape
  `{id, lines, updatedAt}`, event `keranjang:berubah` dispatched on every
  write. Replaces increment-1's placeholder `"cart"` array key.
- Price display moved to `apps/storefront/src/lib/harga.ts`, the only place a price string
  is ever converted to a number — grep-guarded by a unit test over `src/`
  (ADR-0003).
- **The CSP now carries one exemption, derived rather than configured.**
  Product photos live on the CMS's public media origin, which a bare
  `img-src 'self'` blocks silently — correct HTML, green build, broken
  page. `apps/storefront/src/pages/csp.json.ts` writes the origins this build actually
  references to `dist/client/csp.json`; `apps/storefront/server/penyaji.mjs` reads it once
  at startup, re-validates every origin, and widens `img-src` by exactly
  those. A missing or malformed artifact degrades to the baseline policy
  (images stop rendering) rather than to a wider one.
- `BaseLayout.astro` gained a single `head` slot, last in `<head>`, for the
  per-page tags the layout does not model; `/cari` uses it for
  `noindex, follow` alongside the existing `Disallow: /cari` (the two do
  different jobs — one stops the fetch, the other stops the indexing).

### Storefront cart, checkout, order tracking, and wishlist

The storefront can now place a real order while staying 100% static
(ADR-0002 intact): no `prerender = false`, no runtime credential. This is
the architecture revision tracked at
https://github.com/ahliweb/awcms-one/issues/31 (to be recorded there as an
ADR — draft text is in this change's own pull request description): the
browser calls the CMS's anonymous, cross-origin storefront commerce
endpoints directly (`/api/v1/commerce/storefront/*`, issue #29's own
contract — awcms ADR-0103/0107/0118's established pattern, the same one the
newsletter form, site search, and comments already use), the CMS resolves
the tenant from the request `Origin`, and answers with CORS — never a
cookie, never a bearer token.

- **`PUBLIC_AWCMS_ORIGIN`** — the one new build-time variable, deliberately
  `PUBLIC_`-prefixed (an origin is not a secret) unlike `AWCMS_API_TOKEN`.
  `apps/storefront/src/lib/awcms/toko-origin.ts` validates it and is called
  from `apps/storefront/src/pages/csp.json.ts` — a page every build
  unconditionally prerenders — so an unset or malformed value **fails the
  build**, naming the variable, rather than shipping a checkout page that
  silently posts nowhere. The CSP's `connect-src` gains exactly this one
  origin, via the SAME artifact mechanism issue #27 built for `img-src`
  (`csp-asal-media.ts`'s `connectSrc` field, unused until now) — no second
  mechanism.
- **`apps/storefront/src/lib/toko-klien.ts`** — one function per endpoint
  (quote, create order, track, confirm payment, upload-session/finalize,
  cancel, review), every request `mode: "cors"` / `credentials: "omit"` /
  only a `Content-Type` header, envelope unwrapped into a typed
  `TokoApiError` carrying `code`/`details` (field errors, a fresh quote on
  `CART_CHANGED`, `Retry-After` on `RATE_LIMITED`).
- **`/keranjang`** — renders the `localStorage` cart (issue #27's contract),
  re-quotes it live, flags stale price/stock/min-purchase inline (never
  silently corrects), voucher code, quantity/remove, "Lanjut ke checkout".
- **`/checkout`** — one page, five progressively-disclosed steps (contact →
  address → shipping → payment → review); address regions come from
  `apps/storefront/src/lib/awcms/wilayah-checkout.ts`, baked at BUILD time
  into `/index/wilayah-{provinsi,kabupaten-*,kecamatan-*}.json`
  (`PUBLIC_WILAYAH_PROVINSI`, default every Kalimantan province) rather than
  the national ~90,000-village dataset; `VALIDATION_ERROR.details[].field`
  maps to an inline error next to the field it names.
- **`/pesanan`** — order tracking by `?kode=`; the phone comes from
  `sessionStorage` or a form, **never the URL**; status timeline, payment
  instructions while `pending_payment`, a countdown to `expiresAt`, a
  payment-confirmation form, cancel while cancellable.
- **`/wishlist`** — `localStorage`-only; `ProductCard.astro` gains an
  additive `[data-wishlist]` heart button, wired site-wide by
  `apps/storefront/src/scripts/wishlist-tombol.ts` (imported once from
  `Header.astro`, the same way the cart-count script already is).
- Every script above is an external module; every page has a `<noscript>`
  fallback offering a WhatsApp order link
  (`apps/storefront/src/lib/wa-fallback.ts`), is keyboard-reachable, uses
  `aria-live="polite"` for quote/status updates, and carries
  `noindex, follow` via the `head` slot issue #27 added.
- `apps/storefront/scripts/stub-awcms.mjs` (local/CI verification only,
  never shipped) gains a small in-memory state machine for the same
  storefront endpoints, built against the identical #29⇄#30 contract
  document the CMS agent implements in parallel — plus proper
  `level`/`parentCode` filtering for `/api/v1/idn-regions/regions`, which
  the fixture's second province/district rows now need.
- Browser-level Playwright coverage (`apps/storefront/tests/e2e/`, run by
  its own `bun run test:e2e` inside `apps/storefront` — never the root
  `bun test`) exercises add-to-cart → quote → checkout → tracking, and the
  neutral not-found state for a wrong phone.

Deviation from the issue's literal file naming: the cart page's script is
`apps/storefront/src/scripts/keranjang.ts` (matching every other page-level
script's location), not the src/lib-rooted path one line of the issue body
named for it — every interactive script in this app already lives under
`apps/storefront/src/scripts/`, and the issue's own "every script is an
external module" sentence agrees with that location, not the one-off
mention.

### Storefront site chrome + foundation

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

### Storefront news surface (article/rubrik/daerah/mitra/video/tag/search)

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

### Increment-2 documentation refresh: ADR-0007..0010, mirrors, root skills, knowledge graph

Every root `docs/**` document, `README.md`/`AGENTS.md`/`SECURITY.md`, and `knowledge/curated/monorepo-map.md` described the repository as it stood after increment 1 (issue #1's slice: catalog listing + product detail, no live database). Nine implementation PRs (#34–#42, epic #21) since landed the full BjekMart/news-portal parity increment — a provisioned PostgreSQL, the complete `commerce` module (catalog depth, marketing, orders), and the complete public storefront (catalog, news, cart, checkout, order tracking, wishlist) — without a single governance document catching up. A reader following this repository's own documentation would have been told cart, checkout, and orders "do not exist yet" on a `main` where they had shipped weeks earlier.

- Rewrote every root `docs/**` document against the merged tree, verified file-by-file against the code rather than the original issue text (`arsitektur.md`, `api.md`, `cms.md`, `routing.md`, `pengujian.md`, `skema-basis-data.md`, `kamus-data.md`, `aksesibilitas.md`, `responsif.md`, `ui-ux.md`, `seo.md`); reconciled `deployment.md` and `alur-kerja-pengembangan.md` with the ops/marketing/orders PRs that postdated them.
- Added four ADRs: ADR-0007 (cart/checkout/order-tracking stay static; the browser calls `apps/cms`'s anonymous commerce endpoints directly — the revised decision from the epic's amendment), ADR-0008 (one `commerce` module, not three), ADR-0009 (guest checkout by order code + phone), ADR-0010 (manual payment and alternative courier first, gateways via outbox) — each with its Indonesian mirror, and `docs/adr/README.md`'s index updated both ways.
- Rewrote `README.md`/`AGENTS.md`'s "what is here today, and what is not" sections and gates tables for the current tree (the `check-cms` CI job, both `Check` and `check-cms` as required status checks, the local subtree divergence list); rewrote `SECURITY.md`'s attack-surface section to cover the storefront's anonymous commerce endpoints, the derived CSP, and rate limits.
- Added `.claude/skills/awcms-one-storefront` and `.claude/skills/awcms-one-commerce` (+ Indonesian mirrors, + a root skills index) — practical how-tos for adding a storefront page and a commerce table/endpoint, mirroring `apps/cms/.claude/skills/awcms-new-endpoint`'s format.
- Updated `knowledge/curated/monorepo-map.md`'s structural map for the current workspace layout.

Nothing here changes runtime behaviour; every change is documentation.

## [0.2.0] — 2026-09-15

### Architecture and reference documentation, describing the merged tree as it actually is

Adds `docs/` (issue #7): architecture, six ADRs, the database schema, a data dictionary mapping every `awcms_commerce_*` column to its legacy `commerce_bj_mart` source column, the commerce API, the CMS authoring workflow, storefront routing, SEO, accessibility, responsive design, UI/UX, testing, deployment, and the development workflow — plus `docs/README.md` as the index. Every document is mirrored to Indonesian (`docs:i18n:stamp`) and lands with `AGENTS.md`/`README.md` updated to describe the tree as it now is: every child issue of #1 (#2, #4, #5, #6, #11) has landed, so the "not here yet" framing both documents carried is retired.

- `bun run audit:dokumen`'s ADR-index and `ADR-NNNN`-citation checks run for real for the first time in this repository, now that `docs/adr/` exists — both green against the six ADRs landed here.
- Where the tree disagreed with the original issue text, the documents follow the tree: the URL shape (`/product/{slug}`, per the live-site evidence on issue #5), the real API envelope (`{ items, nextCursor }`, not the originally assumed shape), and the real, verified branch-protection settings (a required `Check` status check; no merge-strategy restriction) are what is documented, not what was planned.
- A pre-existing, unrelated defect surfaced by activating the ADR-citation check for the first time — a generated Obsidian note under `knowledge/generated/graphify/` extracts `packages/gerbang/audit-dokumen.mjs`'s own illustrative example (`` `ADR-0042` ``) as a false citation — is filed as [issue #15](https://github.com/ahliweb/awcms-one/issues/15) rather than patched here, since fixing it needs a change to `packages/gerbang/` or a knowledge-graph regeneration, both outside this change's own scope.

### audit:dokumen no longer reads knowledge/generated/

`bun run audit:dokumen` now skips `knowledge/generated/` the way it already skips `apps/cms/` (issue #15). Graphify's Obsidian export extracts notes from source code; it does not author them. The first false positive was concrete: the moment `docs/adr/` existed, the ADR-citation check fired on three generated notes quoting the gate's own illustrative example citation (a placeholder ADR number in a comment in `packages/gerbang/audit-dokumen.mjs`). Every other check in the gate would misfire on generated notes the same way — their links are wikilinks the gate does not parse, and a stale path in one is graph staleness, which `bun run audit:graf` deliberately leaves alone. `knowledge/curated/` and `knowledge/README.md` are authored and stay in scope; two fixture tests pin both sides of that line.

### apps/cms: the `commerce` module — catalog domain, persistence, migrations, API

Adds the `commerce` module to the embedded CMS (issue #4): categories (hierarchical) and products, the catalog core of the legacy `commerce_bj_mart` schema, as `awcms_commerce_categories` and `awcms_commerce_products` under PostgreSQL row-level security, with `GET`/`POST` list-and-create and `GET`/`PATCH`/`DELETE` by id at `/api/v1/commerce/{products,categories}`, an OpenAPI fragment, three domain events, and a read-only `/admin/commerce` screen.

- Every table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY` with a `tenant_id = current_setting('app.current_tenant_id')` policy. Proven, not declared: as the unprivileged `awcms_app` role, a query with no tenant context fails closed and an insert whose `tenant_id` differs from the session tenant is refused by the policy.
- `price` is `numeric(14,2)` and stays a **string** through the directory, the DTO, and the API — never a JS `number`. `discount_percent` and `stock` are `integer` with `CHECK` bounds.
- `status` (`draft`→`active`→`inactive`→`archived`, with legal transitions in the domain layer) and `deleted_at` are independent axes: unavailable-for-sale and deleted-by-the-merchant are different states.
- Migrations `sql/153`–`sql/155`. The full chain `001`→`155` was applied from an **empty** database, which is what a real deployment does. `sql/155` grants the lifecycle worker the rights the generic purge engine needs; `cursorColumn: "deleted_at"` means that engine is mathematically unable to purge a live row.
- Twenty-nine upstream files in `apps/cms/` are modified — the module registry, the event-type registry, the AsyncAPI and OpenAPI catalogues, the sidebar registry, the admin-screen coverage ledger, and the generated inventories and module-count lines that awcms's own `check` chain regenerates or enforces when a module is admitted. Each one is a future `git subtree pull` conflict point; the resolution is to re-run the generators after a sync, not to hand-merge generated output.
- The list endpoints return the awcms house envelope `{items, nextCursor}`; the storefront's local assumption of `{products}` / `{categories}` is reconciled in issue #6.

### Federated knowledge-graph workflow: root Graphify graph, `audit:graf`, safe Obsidian export

Adds a monorepo-level Graphify + Obsidian workflow (issue #11) without duplicating or corrupting the Graphify state already embedded inside `apps/cms` via the `ahliweb/awcms` subtree. Two graphs, federated on demand rather than one graph built twice — the same discipline the rest of this repo already applies to `apps/cms`'s own tree.

- Root `.graphifyignore` + a real, committed root graph (`graphify-out/graph.json`, 396 nodes) built `--code-only` — structural AST extraction, no LLM, no API key, no network, ever, by default. Excludes `apps/cms/**`, which already owns its own graph and its own gate.
- `bun run audit:graf` (alias `knowledge:check`) — the fourth `audit:*` gate, modelled on `apps/cms/scripts/graph-artifacts-check.ts`: tracked-artefact hygiene, report/graph agreement, chosen community names, `.graphifyignore` still excluding `apps/cms`, no duplicate-extracted node, the federated graph never tracked, and `apps/cms/graphify-out/` untouched by this repo's own tooling. Runs in CI (`.github/workflows/ci.yml`) — it reads only committed artefacts, no `graphify` installation needed.
- `bun run knowledge:graph:combine` — merges the root graph with `apps/cms/graphify-out/graph.json` into a gitignored, on-demand `graphify-out/combined/graph.json`, failing closed on a missing, malformed, empty, or `directed`-mismatched component graph (checks `graphify merge-graphs` itself does not make).
- `bun run knowledge:obsidian:export` — stages the root graph's Obsidian export, validates every file (rejecting a symlink, an unexpected extension, path traversal, or a curated-filename collision), and syncs only the allowlisted result to `knowledge/generated/graphify/`. `knowledge/curated/` is read only for collision-checking, never written.
- `packages/gerbang/lib/subtree-guard.mjs` guards every write both new tools perform; `tests/knowledge-no-subtree-write.test.mjs` runs both tools for real against a fixture tree and proves `apps/cms/` comes out byte-for-byte unchanged.
- `knowledge/README.md` + five thin `knowledge/curated/*.md` files record what code alone cannot state: ownership boundaries, cross-repo source-of-truth rules, the tracked/untracked table, and a nine-item threat model — no ISO/IEC certification claimed.
- `README.md`/`AGENTS.md` (and their Indonesian mirrors) revisit the earlier, now-outdated statement that `audit:graf` was not ported — it is, and both documents say why and what changed.

### packages/kontrak: the type-only DTO contract, and the storefront reconciled to the real envelope

Adds the fifth workspace member, `@awcms-one/kontrak` (issue #6): `ProductType`/`ProductStatus` re-exported, `export type` only, from `apps/cms`'s commerce domain layer (`apps/cms/src/modules/commerce/domain/{product-type,product-status}.ts`) — never hand-copied again. `tests/kontrak-arah-impor.test.mjs` guards the one-way import direction (`storefront -> kontrak -> cms`) that keeps `apps/cms`'s `git subtree pull` safe: a dependency pointing back at this repo's own code would turn every future sync into a merge conflict against code upstream never wrote.

Reconciles `apps/storefront/src/lib/catalog.ts` against the real commerce API that landed with issue #4, closing four mismatches a side-by-side review of the two merged PRs surfaced:

- Both list responses are read as `{ items, nextCursor }` — the awcms house keyset-page shape — not the invented `{ products }` / `{ categories }` this app shipped with, which would have crashed the build on `undefined`.
- Categories are now keyset-paginated with the same cursor walk products already use, not fetched as a single unpaginated page.
- `status` and `limit` are no longer sent as query parameters — the CMS route accepts only `cursor` and fixes the page size server-side; sending parameters it silently ignores was a lie in the request log.
- `getProducts()` now filters with an exhaustive `switch` (`isPubliclyVisible`) instead of a bare `status === "active"` comparison, so a `ProductStatus` `apps/cms` adds later cannot silently fall through — verified by hand: widening the union in a worktree turned `bun run check` red at that exact line (the captured error is in this change's pull request description).

`CommerceProduct`/`CommerceCategory` — the row DTO shapes — stay declared locally in `catalog.ts` rather than moving into `@awcms-one/kontrak`: they live in `apps/cms/src/modules/commerce/application/{product,category}-directory.ts`, not `domain/`, so they are out of that package's scope by its own rule (`application/` may carry I/O-bearing imports on other lines of the same file).

Fixtures (`apps/storefront/tests/fixtures/awcms/*.json`) and `apps/storefront/scripts/stub-awcms.mjs` now emit the real envelope too, so the offline build proof against the stub is honest rather than agreeing with the bug it used to ship with.

### Monorepo foundation: audit gates, release tooling, governance docs, and CI

Stands up the machinery `apps/storefront` (issue #5) and `packages/kontrak` (issue #6) will land into, modelled on `ahliweb/media-lenterakalteng`: `packages/gerbang`'s three audit gates (`audit:dokumen`, `audit:rilis`, `audit:translation`), `tools/rilis.mjs` + `cek-lockfile.mjs` + `docs-i18n-stamp.mjs`, the `.changesets/` convention itself, every governance document with its Indonesian mirror, and a CI workflow that runs the check job unconditionally.

- `bun install` resolves the workspace; `bun test` from the root is green and does not execute anything under `apps/cms/` (already excluded via `bunfig.toml`, proven here rather than merely trusted).
- Content, asset, and crawl gates (`audit:konten`, `audit:aset`, `audit:graf`, `audit:serapan`) are deliberately **not** ported: this repository has no built content, asset, or crawl surface yet for them to guard. Porting them now would ship gates that always pass trivially, which is worse than not having them — a green gate that checks nothing reads exactly like one that checked something and found it clean.
- `AGENTS.md` records the `git subtree` sync discipline for `apps/cms`: a subtree-sync PR must be merged with a merge commit, never squashed or rebased, or the next `git subtree pull` loses the merge base it needs.

### apps/storefront: the public catalog and product-detail storefront

Adds the fourth workspace member, `apps/storefront` (issue #5): an Astro app with `output: "static"` that fetches the catalog from `apps/cms` at **build** time and bakes it — the running container holds no API token and never reaches the database. Catalog at `/`, product pages at `/product/{slug}` with no trailing slash, matching the live `mart.borneojek.com` URL shape so indexed URLs, bookmarks, and shared links survive the cutover unchanged; `/products` (with or without a query string) 301s to `/`.

- `price` is carried as the `numeric(14,2)` **string** PostgreSQL emits and formatted only for display with `Intl.NumberFormat`; nothing in the app parses it into money arithmetic.
- The build fails loudly on a non-2xx, a `{success:false}` envelope, a catalog where no product is `active`, or a cursor that never terminates — a storefront that silently publishes an empty catalog is worse than a red build.
- CSP-strict by construction: `inlineStylesheets: "never"` and `assetsInlineLimit: 0`, so no inline `<style>`, `<script>`, or `data:` URI is ever emitted. CMS-supplied `labelColor` badges are compiled into a generated external stylesheet (`product-labels.css`) rather than inline styles, with a WCAG-contrast-chosen foreground.
- JSON-LD is written through an escaper that turns `<`, `>`, `&` into `\uXXXX` after `JSON.stringify` — the HTML parser closes a `<script>` at the first `</script>` regardless of `type`, so a product name containing one would otherwise break out of the data block. A committed fixture (`XSS-REGRESI-01`) guards it.
- The build is reproducible offline against `apps/storefront/scripts/stub-awcms.mjs` + `apps/storefront/tests/fixtures/awcms/`.
- The DTO unions are declared locally for now; issue #6 replaces them with a re-export from `@awcms-one/kontrak`.

## [0.1.0] — 2026-09-15

Initial workspace scaffolding, landed before the `.changesets/` convention itself existed — recorded here by hand rather than folded from a changeset entry.

- Bun workspace root (`workspaces: ["apps/*", "packages/*"]`), pinned toolchain (`bun@1.4.0`), and the dotfiles that govern it (`.gitignore`, `.editorconfig`, `.dockerignore`).
- `packages/config` — the shared `tsconfig.base.json` preset.
- `apps/cms` — `ahliweb/awcms` v10.3.0, embedded whole via `git subtree` with full history (closes #2).
