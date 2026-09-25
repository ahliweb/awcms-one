🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](deployment.id.md)

# Deployment

How `apps/storefront` is built and served, its environment variables, and — plainly, because it changes what "deploying this repository" even means today — that `apps/cms` cannot yet be deployed against a real database on borneojek's own infrastructure.

## Build, then serve — two separate steps, two separate trust levels

```bash
bun run build          # bun run check && astro build && build:build-id && build:penyaji
bun run serve          # bun dist/server/penyaji.mjs
```

`bun run build` (`apps/storefront/package.json`) runs `bun run check` (the type-check), then `astro build` (fetches the catalog, marketing surfaces, and news content from `apps/cms` using `AWCMS_API_TOKEN`, bakes every page to `dist/client/`, and writes the derived CSP artifact — see [`docs/arsitektur.md`](arsitektur.md)), then writes a build id, then `build:penyaji` (bundles `apps/storefront/server/penyaji.mjs` itself to `dist/server/penyaji.mjs` via `bun build --target=bun`). **Only the build step ever reads an `AWCMS_*` variable, and only the build step ever reads `AWCMS_API_TOKEN` at all.** `bun run serve` runs the already-built `dist/server/penyaji.mjs`, which reads `PORT`/`HOST` and, at startup only, its own built `csp.json` artifact — never a live `apps/cms` credential. This is the mechanical proof of [ADR-0002](adr/0002-static-output-with-build-time-fetch-for-the-storefront.md)'s claim that the *container* never talks to `apps/cms`: the served process's own source contains no code path that reads a credential or a URL that could reach it. **What increment 2 adds is a second, browser-side relationship** — cart, checkout, and order tracking pages ship client-side JavaScript that calls `apps/cms`'s anonymous `/api/v1/commerce/storefront/*` endpoints directly, cross-origin, from the reader's own browser, never from the container — see [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md).

### Build profiles (`SITE_PROFILE`, issue #137)

`bun run build`/`check`/`dev`/`serve` all honour `SITE_PROFILE ∈ {toko, berita, landing}` (default `toko`), read once at build time by `apps/storefront/src/config/profil.ts` — see [`docs/routing.md`](routing.md)'s "Build profiles" section for the mechanism and [`docs/template.md`](template.md) for the full matrix. Deploying a `berita`-only or `landing`-only site is the same two-step build-then-serve process above, with `SITE_PROFILE` set in the build environment; nothing about serving the resulting `dist/` differs — `apps/storefront/server/penyaji.mjs` derives what it can serve from the build it was given, the same way it already does for the CSP artifact. CI proves all three build (`ci.yml`'s `Check (toko|berita|landing)` matrix, all three required status checks on `main` alongside `check-cms`), and `.github/workflows/template-init-smoke.yml` additionally builds each profile after a real `bun run template:init` run — all four of that workflow's legs are required status checks too, since issue #182 — see [`docs/alur-kerja-pengembangan.md`](alur-kerja-pengembangan.md).

## Environment variables

Two separate `.env.example` files, one per workspace, deliberately not merged — `apps/storefront`'s own file documents only what it reads; it does not duplicate `apps/cms`'s.

### `apps/storefront/.env.example`

| Variable | Read | Purpose |
| --- | --- | --- |
| `SITE_URL` | Build time (also `astro.config.mjs` directly, before `apps/storefront/src/config/site.ts` runs) | The canonical absolute origin — canonical links, Open Graph URLs, and `Product` JSON-LD are all built from it |
| `SITE_NAME`, `SITE_DESCRIPTION` | Build time | Optional; sensible defaults so `bun run dev` works with no `.env` at all |
| `AWCMS_API_URL` | Build time only | Origin of the `apps/cms` instance to fetch the catalog, marketing, and news content from |
| `AWCMS_API_TOKEN` | Build time only | A **read-only** Bearer credential, scoped to every `read` permission the build fetches with — the commerce reads (catalog, marketing, and — where applicable — order export; issue #25) plus the 9 news-surface reads (issues #57 and #47: `blog_content.{posts,taxonomies,institutions,pages,ad_placements}.read`, `seo_distribution.redirect.read`, `site_profile.profile.read`, `idn_admin_regions.region.read`, `media_library.media.read`); the seed issues one credential covering all of them — never emitted into the build output; not prefixed `PUBLIC_`, deliberately, since Vite only inlines `PUBLIC_`-prefixed variables into client-reachable code |
| `AWCMS_API_TIMEOUT_MS` | Build time only, optional | How long one request to `apps/cms` may take before the build gives up (default 30000 ms) — a value that is not a positive number is refused outright, including `0`, which would otherwise mean "no limit" and restore the exact hang this deadline exists to prevent |
| `PUBLIC_AWCMS_ORIGIN` | Build time, and baked into the served CSP | **New in issue #30.** The `apps/cms` origin the *browser* calls at runtime for cart/checkout/order-tracking — deliberately `PUBLIC_`-prefixed, since it is an origin, not a secret (the same value every media URL already reveals). Validated by `apps/storefront/src/lib/awcms/toko-origin.ts`; an unset or malformed value fails the build outright, naming the variable, because `apps/storefront/src/pages/csp.json.ts` — a page every build unconditionally prerenders — calls the validator unconditionally. See [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md) and [`docs/arsitektur.md`](arsitektur.md) |
| `PUBLIC_WILAYAH_PROVINSI` | Build time, optional | Which Indonesian provinces' address-region data (`idn_admin_regions`) to bake into `/index/wilayah-*.json` for the checkout address form — default every Kalimantan province, deliberately not the full ~90,000-village national dataset |
| `PUBLIC_GA_ID` | Build time, and baked into the served CSP | **New in issue #56.** GA4's own Measurement ID (`G-…`). Unset, empty, or not shaped like one (`apps/storefront/src/lib/ga.ts`) and the build ships with no Google origin anywhere at all — see "The two switches" below |
| `PORT`, `HOST` | Runtime, by `apps/storefront/server/penyaji.mjs` only | Defaults `8080`/`0.0.0.0` — `0.0.0.0` because this process normally runs inside a container behind a reverse proxy, where a `localhost`-only listener is unreachable from outside the container and shows up as a health check failing for no stated reason |

### `apps/cms/.env.example`

A much larger file, owned entirely by `apps/cms` as embedded `ahliweb/awcms` code — this repository's root does not duplicate it (`AGENTS.md`'s "Configuration and toolchain": "every env variable a root-level script reads belongs in `.env.example`... `apps/cms` maintains its own `.env.example` for its own runtime configuration; this repo's root file does not duplicate it"). The variables that matter for understanding what a running `apps/cms` needs: `DATABASE_URL` (application role `awcms_app` — never the database owner role, which is a Postgres superuser that bypasses `FORCE ROW LEVEL SECURITY` outright, defeating the exact isolation [`docs/skema-basis-data.md`](skema-basis-data.md) documents), `APP_ENV`/`APP_URL`, and the HTTP listener variables (`PORT`, `HOST`, and optional in-process TLS certificate paths) its own standalone entrypoint reads.

**`EMAIL_ENABLED`/`EMAIL_PROVIDER` are load-bearing for customer login, not merely for outbound mail generally, since increment 4.** `POST account/otp/request` (issue #89) enqueues its 6-digit code through the same `email` module outbox every other transactional e-mail uses. With `EMAIL_ENABLED=false` (the default) or `EMAIL_PROVIDER=log`, the code goes to a `log` adapter instead of an inbox — a deployment left at these defaults can still exercise the whole OTP flow in development/CI, but a real, "production" customer cannot actually receive their login code until both are set (`EMAIL_ENABLED=true` and a real `EMAIL_PROVIDER`, e.g. `mailketing`). This is a deployment gate, not merely a feature flag: turning it on late is the difference between the account surface working end to end and every login silently only reaching the server log.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMAIL_ENABLED` | `false` | Whether the `email` module actually sends — `false` routes every message, including the OTP, to the `log` adapter |
| `EMAIL_PROVIDER` | unset (`log` when `EMAIL_ENABLED=false`) | `mailketing` (real adapter) or `log` (safe local/dev, no network) |
| `COMMERCE_ACCOUNT_OTP_RATE_LIMIT_MAX_PER_IP` / `_WINDOW_SEC` / `_MAX_PER_EMAIL` | 10 / 3600 / 5 | `account/otp/request`'s two-axis limit (issue #89) — an IP-only limit cannot protect the mailbox an OTP is sent to |
| `COMMERCE_ACCOUNT_OTP_VERIFY_RATE_LIMIT_MAX_PER_IP` / `_WINDOW_SEC` | 20 / 3600 | `account/otp/verify`'s own, looser per-IP budget — no per-e-mail axis, since the hashed code with 5 attempts already limits guessing one address |
| `COMMERCE_STOREFRONT_PUBLIC_URL` | unset | This deployment's public storefront origin, used only to build an enrolled affiliate's referral link (issue #92, `"${COMMERCE_STOREFRONT_PUBLIC_URL}/?ref=CODE"`); unset falls back to a relative `/?ref=CODE` rather than fabricating an origin |
| `COMMERCE_SHIPPING_RATE_PROVIDER` | unset | Issue #107 (contract #106 D4) — `rajaongkir` (real adapter) or `log` (safe local/dev, no network); unset means no live courier rates at all, regardless of `shipping.courier.enabled` on a tenant's own settings |
| `COMMERCE_RAJAONGKIR_API_KEY` | unset | Required when `COMMERCE_SHIPPING_RATE_PROVIDER=rajaongkir` — the Komerce API v2 `key` header value |
| `COMMERCE_RAJAONGKIR_BASE_URL` | `https://rajaongkir.komerce.id/api/v1` | Override for tests/dev only — never request input |
| `COMMERCE_RAJAONGKIR_TIMEOUT_MS` | `10000` | Per-call timeout (`withTimeout`) for both the destination-search and calculate-cost RajaOngkir calls |
| `COMMERCE_PAYMENT_GATEWAY` | unset | Issue #110 (contract #106 D3) — `midtrans` (real adapter) or `log` (deterministic, no network; refused when `NODE_ENV=production`); unset means `payment.method: "gateway"` is never `available`, regardless of `payment.gateway.enabled` on a tenant's own settings |
| `COMMERCE_MIDTRANS_SERVER_KEY` | unset | Required when `COMMERCE_PAYMENT_GATEWAY=midtrans` — the Basic-auth server key sent as `Authorization: Basic base64(ServerKey + ":")` |
| `COMMERCE_MIDTRANS_IS_PRODUCTION` | `false` | Selects the Snap/status API base URL (sandbox vs production) when the override below is unset |
| `COMMERCE_MIDTRANS_SNAP_BASE_URL` | `https://app.sandbox.midtrans.com` (sandbox) / `https://app.midtrans.com` (production) | Override for tests/dev only — never request input |
| `COMMERCE_MIDTRANS_STATUS_BASE_URL` | `https://api.sandbox.midtrans.com` (sandbox) / `https://api.midtrans.com` (production) | Override for tests/dev only — never request input |
| `COMMERCE_MIDTRANS_TIMEOUT_MS` | `15000` | Per-call timeout (`withTimeout`) for both `createSession` and `fetchStatus` |
| `COMMERCE_WEBHOOK_RATE_LIMIT_MAX` / `_WINDOW_SEC` | 120 / 60 | Issue #113 — per-IP rate limit on `POST /api/v1/commerce/webhooks/{provider}/{endpointToken}`, the same shared-limiter shape every storefront route uses |

**`COMMERCE_STOREFRONT_PUBLIC_URL` (already documented above for affiliate referral links) also builds the `log` payment-gateway provider's own `redirectUrl` (`"${COMMERCE_STOREFRONT_PUBLIC_URL}/pesanan?kode=...&gateway=log"`) and, when set, the Midtrans adapter's `callbacks.finish` URL.**

**Scheduled job — `commerce:payments:reconcile` (issue #113).** Run `bun run commerce:payments:reconcile` every 1-2 minutes via cron/systemd timer, the same way `commerce:orders:expire`/`commerce:whatsapp:dispatch` already are (`commerce/module.ts`'s own `jobs` descriptor names the recommended schedule for every job in this module, including this one). It reads the same `COMMERCE_PAYMENT_GATEWAY`/`COMMERCE_MIDTRANS_*` variables above and is a clean no-op when no provider is configured.

**`COMMERCE_WHATSAPP_ENABLED`/`COMMERCE_WHATSAPP_PROVIDER` are the same kind of deployment gate for WhatsApp login (issue #108, contract #106 D5).** `POST account/otp/request` with `via: "whatsapp"` answers `409 CHANNEL_UNAVAILABLE` until `COMMERCE_WHATSAPP_ENABLED=true`; the code then goes to a `log` adapter (dev/CI) unless `COMMERCE_WHATSAPP_PROVIDER` also names a real provider (`fonnte` or `meta`, each with its own credential variables below). WhatsApp is a login-only channel for an account that already exists — registration is unaffected and stays e-mail OTP only.

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMMERCE_WHATSAPP_ENABLED` | `false` | Gates BOTH claiming in `commerce:whatsapp:dispatch` and whether `via: "whatsapp"` is available on `otp/request` at all |
| `COMMERCE_WHATSAPP_PROVIDER` | unset (`log` when `COMMERCE_WHATSAPP_ENABLED=false`) | `fonnte`, `meta`, or `log` (safe local/dev, no network) |
| `COMMERCE_FONNTE_TOKEN` / `COMMERCE_FONNTE_API_BASE_URL` | unset / `https://api.fonnte.com` | Fonnte adapter credential/base URL |
| `COMMERCE_META_WA_TOKEN` / `COMMERCE_META_WA_PHONE_NUMBER_ID` / `COMMERCE_META_WA_OTP_TEMPLATE` / `COMMERCE_META_WA_API_BASE_URL` | all unset / `https://graph.facebook.com/v20.0` | Meta WhatsApp Cloud API adapter — `COMMERCE_META_WA_OTP_TEMPLATE` names the operator-approved template Meta requires for a template (OTP) message |

`PUBLIC_*` storefront variables are unchanged by increment 4 — the bearer session lives entirely in the browser's own `localStorage`, so no new build-time or runtime env var was needed on the `apps/storefront` side for accounts or affiliates.

## What may reach `apps/cms`: the build process, and — since issue #30 — the reader's browser

| | May reach |
| --- | --- |
| Build process (`astro build`) | `apps/cms`'s public owner API, over HTTPS, with the read-only build token |
| Running container (`bun dist/server/penyaji.mjs`) | Nothing outside itself — no `apps/cms`, no database, no external network call of any kind. This is unchanged since increment 1 |
| The reader's own browser | `apps/cms`'s anonymous `/api/v1/commerce/storefront/*` API, at `PUBLIC_AWCMS_ORIGIN`, `mode: "cors"` / `credentials: "omit"` — no cookie, no bearer token, ever; and, since issue #56, `POST /api/v1/analytics/collect` on the same origin, `credentials: "include"` this time (the module's own anonymous, `httpOnly` visitor-key cookie — see below) |

`apps/storefront/server/penyaji.mjs`'s own CSP is now derived rather than hand-configured — `img-src` and `connect-src` carry exactly the origins a given build actually referenced (product/media images, and `PUBLIC_AWCMS_ORIGIN`), re-validated at server startup and falling back to `'self'`-only on any missing/malformed artifact; see [`docs/arsitektur.md`](arsitektur.md) for the full mechanism. Every other CSP directive stays `'self'`/`'none'` — there is no third-party script or embed this app allows, except (issue #56) GA4's own two origins, and only when `PUBLIC_GA_ID` is configured — see "The two switches" immediately below.

## Visitor analytics: the two switches (issue #56)

`apps/storefront` always mounts its first-party visitor beacon
(`apps/storefront/src/scripts/analitik.ts`, `apps/storefront/README.md`'s "Visitor analytics
and the optional GA4 switch") on every page. Whether that beacon does
anything observable is two independent switches, on two different sides of
this repository, and a deployer who sets only one gets a real but
easy-to-miss half-state:

1. **`apps/cms`'s `VISITOR_ANALYTICS_ENABLED`** (`apps/cms/.env.example`,
   `apps/cms/src/modules/visitor-analytics/README.md`) — off by default. The
   storefront's beacon fires either way (`POST /api/v1/analytics/collect`
   always answers `202`, by design — see that route's own docblock), but
   with this switch off, nothing is recorded: no session, no event, no
   rollup for A3's "Terpopuler" to read. Turning the software switch on is
   not itself the lawful-basis/consent decision UU PDP requires — see that
   module's own "Privacy posture" section.
2. **`apps/storefront`'s `PUBLIC_GA_ID`** (`apps/storefront/.env.example`) —
   unset by default. Purely additive and independent of switch 1: GA4 is
   Google's own, separate analytics product, so a deployment can run the
   first-party beacon alone, GA4 alone (by setting only this variable — the
   beacon still fires either way, it just records nothing without switch 1),
   or both together.

Neither switch is required for a build to succeed; both default to "off",
which is what a fresh deployment of this repository ships with.

## The seeded tenant's storefront origins must be registered in `awcms_tenant_domains`

The anonymous storefront API resolves its tenant from the calling browser's `Origin` header against `apps/cms`'s `awcms_tenant_domains` table — an origin not registered there gets the same neutral refusal an unknown order code gets (see [`docs/api.md`](api.md)). `tools/seed-borneojek-mart.ts` registers `mart.borneojek.com` and `http://localhost:4321` (this repo's own dev default) as `active`, manually attested domains for the seeded tenant. A deployment that serves the storefront from a different origin must register that origin the same way before checkout will work at all — this is a real, easy-to-miss step, not an implementation detail.

## Local database (issue #25)

`compose.yaml` at the repo root provisions a disposable `postgres:18.4` for local development and CI — not production (see "Production PostgreSQL provisioning is not done" below). It creates ONLY what `apps/cms`'s own SQL migrations do not: the server itself, and the `LOGIN` half of the three roles the migrations create `NOLOGIN` and passwordless on purpose (`apps/cms/sql/019_awcms_db_role_separation.sql` creates `awcms_app`, `apps/cms/sql/022_awcms_db_worker_setup_roles.sql` creates `awcms_worker`/`awcms_setup` — a password is a secret and never belongs in a committed migration; see each file's own header). Every table, index, RLS policy and `GRANT` stays the migrations' job. `docker/postgres-init/01-create-least-privilege-roles.sh` does the one thing the migrations deliberately leave out, and nothing else — its own header explains why duplicating a `GRANT` here would drift the moment a migration narrows or widens one.

The full sequence, in order, with real values (`cp .env.example .env` at the root, `cp apps/cms/.env.example apps/cms/.env` first — see each file for what to edit):

```bash
cp .env.example .env                    # root — POSTGRES_*, AWCMS_*_PASSWORD, SEED_*
bun run db:up                           # postgres:18.4, project "awcms-one", host port 5433

# apps/cms/.env's own DATABASE_URL defaults to the OWNER/superuser shape on
# port 5432 — override it for THIS one command to point at the compose
# superuser on port 5433 instead. Never point apps/cms's own persisted
# DATABASE_URL at the owner: that role is a Postgres superuser and bypasses
# `FORCE ROW LEVEL SECURITY` outright.
DATABASE_URL=postgres://awcms:awcms_dev_password@localhost:5433/awcms \
  bun run db:migrate:cms

# One-off, only for a database that ran `db:migrate` against the `commerce`
# module's OLD sql/153-sql/168 file names (issue #72, ADR-0015): before its
# NEXT db:migrate, run
#   cd apps/cms && DATABASE_URL=<url> bun run db:commerce:renumber
# once. It updates the sixteen already-applied rows' recorded names/checksums
# to the new sql/901-sql/916 names; a fresh database (this one) needs it not
# at all, since it applies the new file names directly.

# db:migrate:cms now also applies sql/917-sql/923 (increment 4, epic #32):
# the customer account/OTP/session schema (917) plus its worker purge grants
# (918), the derived OTP e-mail template seed for existing tenants (919), the
# address default-per-customer partial unique index (920), and the affiliate
# program's schema — including orders.affiliate_id and
# store_settings.affiliate_commission_rate (921), its permission seed (922),
# and its worker purge grants (923). Nothing beyond the ordinary
# `db:migrate:cms` step above is needed to pick these up.

# Issue #57 — the news taxonomy's "Daerah" institutions and /daerah/{slug}
# archive resolve their region codes/names against `idn_admin_regions`
# (ADR-0046), which migrations only SCHEMA — the actual region rows are a
# separate, explicit import + activate step, apps/cms's own commands (still
# the OWNER connection above; `awcms_worker`'s grants are enough, but the
# owner connection this sequence already has open works too):
cd apps/cms
DATABASE_URL=postgres://awcms:awcms_dev_password@localhost:5433/awcms \
  bun run idn-regions:import --commit          # lands `validated`, prints a dataset code
DATABASE_URL=postgres://awcms:awcms_dev_password@localhost:5433/awcms \
  bun run idn-regions:activate -- --dataset <code printed above> --commit
cd ..

# Edit apps/cms/.env's DATABASE_URL to the LEAST-PRIVILEGE runtime role
# instead, matching root .env.example's documented defaults:
#   DATABASE_URL=postgres://awcms_app:awcms_app_dev_password@localhost:5433/awcms
# then, in a SECOND terminal, start the server this repo's seed script drives
# as an HTTP client — the same two-process pattern this document already
# uses for apps/storefront's own build verification below:
cd apps/cms && bun run dev              # or: bun run build && bun run start

# a THIRD terminal, from the repo root — idempotent, safe to re-run
bun run db:seed:cms
```

`tools/seed-borneojek-mart.ts` (`bun run db:seed:cms`) drives the running `apps/cms` from step above as an HTTP client of its own public `/api/v1/*` surface — the same interface `apps/storefront`'s build uses, and the only one issues #23/#26/#29 commit to keeping stable. Every step is idempotent (checks for the row before creating it); re-running it against the same tenant creates nothing new and exits 0. As of issue #29, it seeds:

- The `borneojek-mart` tenant and owner (`POST /api/v1/setup/initialize`), and its storefront origins in `awcms_tenant_domains` (see above).
- The 8-category catalog and one product per commerce `type` (physical/service/subscription/digital, the last a clearly-marked synthetic placeholder), with full BjekMart parity fields (images, variants, size charts, service forms) from `tools/seed-data/contoh/borneojek-mart/*.json`.
- The marketing surface: one flash sale with a product, two vouchers, three testimonials, a popup, and store settings.
- A handful of blog terms/pages/posts and the site profile, including six social links and a WhatsApp number.
- One customer with two orders in different states (`pending_payment`, `paid`), created through the anonymous order-creation path itself — not a backdoor — so the seed doubles as a proof that path works.
- A read-only machine credential — `storefront-build (baca-saja)` — scoped to every `read` permission `apps/storefront`'s build fetches with: the commerce reads (catalog, marketing, and order/customer/review reads) plus, since issue #57, the news-surface reads (blog posts/taxonomies/institutions/pages/ad placements, SEO redirects, the site profile, `idn-regions`, and media objects — each key copied from the `authorize` block of the route file the storefront actually calls; the exact list is `MACHINE_CREDENTIAL_PERMISSION_KEYS` in the script). It is the credential `AWCMS_API_TOKEN` above must carry. **Scope is reconciled on re-run, not just checked by name:** the machine-credential surface has no "widen scope" verb (`apps/cms/src/pages/api/v1/access/machine-credentials/` exposes only create and `{id}/revoke`), so when a tenant seeded before this scope grew still holds a same-named credential whose `allowedPermissionKeys` differ from the script's list, the script revokes it and issues a fresh one — printing the new token once with an `ACTION REQUIRED` line, because the old token fails on its very next request and every place that reads `AWCMS_API_TOKEN` must be updated before the next build. A credential whose scope already matches is left alone.
- **Issue #57** — the news IA's own reference taxonomy, modelled on seputarborneo's real structure (`include/nav_menu.php`'s `seputarborneo_taksonomi()`, verified 2026-09-18): an 8-rubrik `category` tree (politik, hukum, nasional, olahraga, wisata, daerah, mitra-borneo, umum) with umum's 5 topical children plus a `wisata-travel` child (seputarborneo's own `Wisata`/`WISATA` slug collision resolved this way — `awcms_blog_terms_slug_dedup`, `apps/cms/sql/035_awcms_blog_content_schema.sql`, is unique on `(tenant_id, taxonomy_type, slug)` with no `parent_id` component, so one tree cannot hold two `wisata` slugs); the 27-institution legislative/executive directory (`POST /api/v1/blog/institutions`) — seputarborneo's own 24-channel Mitra Borneo list (`seputarborneo_nav_mitra()`) plus a bare `Pemkab` for each of the 3 regencies that list leaves out (Kotawaringin Barat, Sukamara, Barito Selatan), added so all 14 Kalteng regencies/cities — not just the 11 the reference site's own list happens to name — have at least one institution to carry their `regionCode`, since region membership is institution-only (see the finding below); each `regionCode` resolved by NAME against `GET /api/v1/idn-regions/regions` at seed time (never hard-coded — this is why the `idn-regions:import`/`idn-regions:activate` step above is now part of this sequence); 44 sample news posts — at least two per rubrik (the 8 top-level ones AND umum's 6 children, so no `/rubrik/*` archive renders empty), and every one of the 27 institutions has at least one post filed to it through `institutionIds`, which (region membership being institution-only, see the finding below) is what makes all 14 `/daerah/*` and all 27 `/mitra/*` archives render with content instead of an empty state; the bodies are generic, clearly-marked placeholders (no real people or events), three carrying a Portable Text `videoNews` node with a clearly-marked placeholder YouTube id, since no real seputarborneo channel id was available to verify; three additional legal pages (`redaksi` — generic placeholders, deliberately NOT seputarborneo's own company/personnel data; `pedoman-media-siber` — Dewan Pers's public text, ported; `disclaimer` — genericized to this tenant); and 5 sample `legacy_blog`-origin redirects (`/news/{id}-{slug}.html` → this CMS's own `/blog/borneojek-mart/{slug}`) exercising `docs/routing.md`'s row-based legacy-redirect path. **Ad placements are the one part of this step that does not create anything in this local/CI deployment** — see "What this script still does not seed, and why" below.

**A finding that turned out to affect every page/post this script has ever seeded, not only issue #57's own** — `createBlogPage`/`createBlogPost` always write `status: 'draft'`, and until issue #57 nothing in this script ever transitioned either one past it, so `kebijakan-privasi`/`tos` and BjekMart's own 3 posts were, and would have stayed, invisible to `apps/storefront`'s build (`blog/pages/public.ts`'s predicate and `blog.ts`'s `getAllPosts()` both require `published`). Found while verifying issue #57's own "renders `/halaman/redaksi`"/"renders `/berita`" acceptance criteria against a REAL seeded local CMS instead of the stub (whose fixtures are canned, already-published data and never exercised this path). Fixed for every page/post this script creates, going forward and on re-run against an already-seeded tenant.

It prints the owner password and the machine credential token exactly once, on the run that creates them (or, for the token, on the run that rotates it — see the credential bullet above) — neither is stored anywhere by the script.

### A known gap: `SETUP_DATABASE_URL` / `awcms_setup` lacks a grant it needs

Found during issue #26's development: the `awcms_setup` role (the one `SETUP_DATABASE_URL` is meant to scope the one-time setup wizard to) lacks a grant on `awcms_principals` — `sql/112` grants that table to `awcms_app` only. Configuring `SETUP_DATABASE_URL` as documented upstream therefore 500s the setup wizard. The sequence above works around it by leaving `SETUP_DATABASE_URL` unset entirely (the wizard then runs under `apps/cms`'s own configured `DATABASE_URL`) — this is the documented local flow, not a fix. Raised as an upstream `ahliweb/awcms` issue; not something this repository's own migrations can correct, since `sql/112` is upstream, subtree-embedded code.

Proving the seeded catalog is servable:

```bash
curl -H "Authorization: Bearer <AWCMS_API_TOKEN printed above>" \
     -H "x-awcms-tenant-id: <tenantId printed above>" \
     http://localhost:4321/api/v1/commerce/products

cd apps/storefront && AWCMS_API_URL=http://localhost:4321 \
  AWCMS_API_TOKEN=<token> SITE_URL=http://localhost:4321 bun run build
```

`bun run build` prerenders one page per seeded product plus the catalog index, the marketing surfaces, and the seeded news content.

```bash
bun run db:down                         # stop the container, keep the volume
bun run db:reset                        # drop the volume too — a clean slate
```

### A Postgres 18 gotcha, recorded so the next person does not lose an hour to it

`postgres:18`'s official image refuses a volume mounted directly at `/var/lib/postgresql/data` — a pre-18 layout it no longer uses. `compose.yaml` mounts the named volume at `/var/lib/postgresql` instead. If a future edit to `compose.yaml` moves that mount point back, `bun run db:up` fails outright rather than starting a broken server.

### What this script still does not seed, and why

Product images, slider media, and payment-confirmation proof images are resolved through `media_library`'s existing reference mechanism (see [`docs/cms.md`](cms.md)) but not uploaded through a real R2 session here — `tools/seed-assets/` carries small, self-generated placeholder SVGs instead of real photos, and the anonymous payment-proof upload endpoints always answer `503 MEDIA_UNAVAILABLE`. RajaOngkir courier rates and a payment gateway have no field on any endpoint `apps/cms` exposes today, by design — see [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md) and [issue #33](https://github.com/ahliweb/awcms-one/issues/33). Customer accounts are not seeded — the seeded customer has no password, matching [ADR-0009](adr/0009-guest-checkout-by-order-code-and-phone.md) and [issue #32](https://github.com/ahliweb/awcms-one/issues/32).

**Ad placements (issue #57) are the one resource this script cannot create locally, at all**, and this is a harder gap than the placeholder-SVG one above: unlike a product image, `POST /api/v1/news-portal/ad-placements`'s `mediaObjectId` is REQUIRED and existence/status-checked against `awcms_news_media_objects` (`ad-placement-reference-validation.ts`) — only a `verified`/`attached` media object satisfies it, and reaching `verified` needs `finalizeNewsMediaUploadSession` to perform a real R2 `GET` + checksum, which needs `NEWS_MEDIA_R2_*` configured. This repo's local/CI compose stack provisions PostgreSQL only, no R2/S3-compatible object storage. `tools/seed-data/contoh/borneojek-mart/ad-placements.json` and the four correctly-sized placeholder PNGs under `tools/seed-assets/` (`ad-728x90.png`/`ad-970x250.png`/`ad-300x250.png`/`ad-300x600.png`) exist so the seed script's `ensureAdPlacements` step genuinely creates all 12 the moment a deployment DOES have `NEWS_MEDIA_R2_*` configured (`sidebar_middle` takes the 300x600 creative — seputarborneo's `kiri-tengah` slot is a half-page unit — the other two sidebar slots 300x250). Locally it prints one explanatory skip line, counting the placements actually left unapplied, instead of 12 failures, and creates nothing. **That degradation is reserved for exactly one refusal:** the create-session route's `502 PROVIDER_ERROR` ("News media R2 storage is not configured for this deployment", `apps/cms/src/pages/api/v1/media/news-images/upload-sessions/index.ts`), the only signal that the deployment has no R2 at all. Any other media failure — a `400` mime/size refusal, a `403` on the presigned PUT, a `422` or transient `502` from finalize, a network error, a rejected `POST .../ad-placements` — is a real failure of that run or its assets, is reported per placement, and makes the seed exit non-zero; it is never swallowed as "no R2 here".

## Importing seputarborneo (issue #58)

`tools/import-seputarborneo.ts` (`bun run import:seputarborneo`) is an EXPORTER: it reads seputarborneo.com's legacy MariaDB archive and writes the input files `apps/cms`'s own operator pipeline for exactly this job expects — `bun run blog:legacy:import` (`apps/cms/scripts/blog-legacy-import.ts`, Issue #599/ADR-0114 in upstream awcms). It makes no network call and needs no `apps/cms` running at all; the actual import runs from INSIDE `apps/cms`, against the SAME `borneojek-mart` tenant [`tools/seed-borneojek-mart.ts`](#local-database-issue-25) bootstraps.

**The dump is never copied into this repository, never committed, and never printed to the console.** `tools/lib/mysql-dump-reader.ts` streams it — `Bun.file(...).stream()` through a `DecompressionStream("gzip")` — a row at a time; the 228 MB decompressed archive is never held whole in memory, and this script's own console output prints only counts. The files it writes under `tools/out/seputarborneo/` (git-ignored) DO carry row content — that is their entire purpose, being `blog:legacy:import`'s own input format — but they stay on the machine that ran the export.

### Why an exporter, not a direct API client

An earlier version of this tool called `POST /api/v1/blog/posts` directly. `blog:legacy:import` gets two things right that no public route can: it accepts a caller-supplied `publishedAt` for an ALREADY-PAST date (checked directly — no `blog/posts/*` route does), and it writes `legacy_source_id`/`legacy_source_system` (`sql/138`) so a re-run is idempotent by provenance rather than by guessing from a slug. It also converts `bodyHtml` to Portable Text itself; this exporter does not duplicate that converter — every `bodyHtml` value it writes is the legacy HTML verbatim, so what the pipeline refuses is exactly what the archive contained.

### The runbook

```bash
# .env: set SEPUTARBORNEO_DUMP to the gzip-compressed dump's absolute path.
bun run import:seputarborneo                     # writes tools/out/seputarborneo/*, no network call
bun run import:seputarborneo -- --limit=200       # cap berita_red rows, for a first pass
```

Then, from `apps/cms` (against an ALREADY-SEEDED, ALREADY-RUNNING tenant — `bun run db:seed:cms` and the seputarborneo taxonomy seed, [issue #57](https://github.com/ahliweb/awcms-one/issues/57), first):

```bash
cd apps/cms

# 1. Preview (the default — nothing written without --commit):
bun run blog:legacy:import --file=../tools/out/seputarborneo/posts.ndjson \
  --tenant=<uuid> --author=<uuid> --system=seputarborneo

# 2. The upload set — every foto_berita lead photograph AND any inline <img>
#    the converter refused (this is the CANONICAL list, from the converter's
#    own refusals; this exporter does not re-scan the HTML itself, to avoid a
#    second scanner drifting from the one whose refusals actually matter):
bun run blog:legacy:import --file=../tools/out/seputarborneo/posts.ndjson \
  --tenant=<uuid> --author=<uuid> --system=seputarborneo \
  --images=upload-set.json
# Upload every file through /admin/media, then build media-map.json:
# { "<src>": "<media object uuid>" }

# 3. Terms — build term-map.json from tools/out/seputarborneo/term-map-hints.json
#    (this exporter's OWN guidance: which of B1's 8 top-level terms, or which
#    UMUM child, each of the 45 legacy category names belongs to) plus a live
#    GET /api/v1/blog/terms — { "<legacy category name>": "<term uuid>" }.

# 4. Commit:
bun run blog:legacy:import --file=../tools/out/seputarborneo/posts.ndjson \
  --tenant=<uuid> --author=<uuid> --system=seputarborneo \
  --media-map=media-map.json --term-map=term-map.json --commit

# 5. Repeat 1-4 for videos.ndjson (no featuredImageSrc, so step 2 only
#    matters if a video's description body itself has an <img>; no
#    categories are exported for videos — see "What is NOT carried
#    through" below).

# 6. Redirects — this exporter's OWN tools/out/seputarborneo/redirects.json,
#    NOT blog:legacy:redirects:import (see "Why this exporter builds its own
#    redirects" below). ~51,000 entries against a route that takes 200 per
#    all-or-nothing call is a ~256-call loop, so the exporter runs it
#    (`tools/lib/redirect-push.ts`); it reuses AWCMS_BASE_URL/SEED_OWNER_*:
cd ..   # back to the repo root
bun run import:seputarborneo -- --push-redirects            # DRY RUN of the whole file: every chunk
                                                            # is posted with dryRun: true, nothing written;
                                                            # per-entry refusals are printed, exit 1 on any
bun run import:seputarborneo -- --push-redirects --commit   # the real import, chunk by chunk, each under an
                                                            # Idempotency-Key derived from the chunk's content
#    A crash or a failed chunk mid-run is safe to rerun with the same command:
#    the CMS replays every already-committed chunk from its idempotency record
#    (same key + same body -> the stored 200) and imports only the rest. The
#    commit run does NOT dry-run first for exactly that reason — a fresh dry run
#    of a committed chunk would report every row as a CONFLICT with itself.
#    Do NOT re-export between the dry run and the commit: a changed file means
#    changed chunk keys, and the first chunk that overlaps an earlier import
#    fails loudly on CONFLICT instead of replaying.

# 7. Institutions — blog:legacy:import has no mechanism to set institutionIds
#    (see below). This exporter's OWN follow-up pass closes that gap, over
#    the public API, from the repo root:
bun run import:seputarborneo -- --assign-institutions

# 8. Verify (from apps/cms, against a sitemap or URL list):
cd apps/cms && bun run blog:legacy:cutover:verify --tenant=<uuid> --urls=<path>
```

### What `blog:legacy:import` still cannot do — and the follow-ups this repo keeps

0. **The redirect rows themselves.** No upstream script writes `awcms_seo_redirects`; the only way in is `POST /api/v1/seo/redirects/import`, capped at `MAX_REDIRECT_IMPORT_ITEMS` (200) per all-or-nothing call and requiring an `Idempotency-Key` on every call. `--push-redirects` (step 6) is that loop — verified against the route's own file (`apps/cms/src/pages/api/v1/seo/redirects/import.ts`): body `{ redirects, dryRun }`, header `idempotency-key`, per-item `results[].{index, ok, code, normalizedSourcePath, errors}` on both the 200 and the 400 `IMPORT_VALIDATION_FAILED` envelope. Before any call it also runs the route's own query-stripping source normalization over the WHOLE file and refuses on the first duplicate, because the route detects duplicates only within one chunk — a file-wide duplicate would otherwise surface as a `CONFLICT` on a later chunk, after an earlier one had already been written.
1. **`institutionIds`.** `blog:legacy:import`'s own `main()` calls `syncPostTermAssignments` after each insert — never `syncPostInstitutionAssignments`, checked directly against `apps/cms/scripts/blog-legacy-import.ts` and `legacy-import-directory.ts`. A `DAERAH`/`MITRA BORNEO` article therefore imports with NO institution, and a post only reaches `/daerah/{slug}`/`/mitra/{slug}` through one (`apps/storefront/src/pages/daerah/[slug].astro`'s own header) — both are issue #58's own acceptance criterion. `bun run import:seputarborneo -- --assign-institutions` (step 7 above) closes this: it re-reads the dump, resolves each `DAERAH`/`MITRA BORNEO` article's institution by name, and `PATCH`es `institutionIds` on the already-imported post (found by its own exported `slug` — there is no slug-lookup route on the public API, so it pages the full post list once).
2. **A legacy byline.** `--author=<uuid>` is ONE value for the whole run; `legacy-import-record.ts` has no per-row author/sidecar field at all. The legacy `user`/`admin` column is dropped entirely by this pipeline — a real, unavoidable gap of using the operator tool as intended, not something this exporter can invent a field for.

### Why this exporter builds its own `redirects.json`, not `blog:legacy:redirects:import`

That sibling script derives its source path by templating `{legacyId}`/`{slug}` — where `{slug}` is the STORED post slug (`listLegacyRedirectMappings`, checked directly). For the ~84 collision groups / ~171 rows `blog-legacy-import.ts`'s own comment names (two legacy articles sharing a title), the stored slug carries a `-{legacyId}` suffix this exporter's own `newPostSlug` adds — but the REAL legacy current-style URL was built from the plain, un-suffixed title, so the sibling script's templated redirect would be wrong for exactly those rows. `redirects.json` here is built straight from the raw `title` for both legacy URL forms (today's `/news/{id}-{slug}.html` and the pre-2.0 `/news/{id}_{title_with_underscores}.html`, the latter of which `blog:legacy:redirects:import` cannot produce AT ALL — its template has no `{title}` placeholder), targeting `/blog/{tenantCode}/{slug}` with the SAME final stored slug `blog:legacy:import` writes. `blog:legacy:redirects:import`, `blog:legacy:rubrik-redirects` (which replays the ALREADY-COMMITTED `apps/cms/data/seputarborneo-legacy/rubrik-redirects.json` category-level map — a separate, pre-existing upstream asset this exporter does not touch, and NOT a step of this runbook: `docs/routing.md`'s "Which mechanism is authoritative for category-level legacy URLs" explains why the storefront's rule-based module covers those URLs with no rows at all), and `blog:legacy:article-paths` (built for `ahliweb/awcms-astro`'s edge-served cutover, and explicitly inert for `awcms_seo_redirects` — this repo's own mechanism, per `docs/routing.md`) remain available upstream tools; this exporter simply does not need them.

Two shape decisions in `redirects.json` exist only because of how the CMS and the storefront consume the rows (found in review of PR #67):

- **`origin` is `legacy_blog`, not `import`.** `apps/storefront/src/lib/awcms/blog.ts`'s `getLegacyRedirectRows()` keeps ONLY `origin === "legacy_blog"` rows when it builds `/index/pengalihan-legacy.json` (`docs/routing.md`, "Legacy redirects"); an `import`-origin row is a valid CMS rule this storefront would silently never serve. The import route's `defaultOrigin: "import"` only applies to a body that omits `origin`.
- **A video row's source is the synthetic, query-free `/video/{id}-{slug}.html`, not the real `/video/?video={id}-{slug}.html`.** The CMS strips the query string from every redirect source at write time (`validateRedirectInput` → `normalizeRedirectPath` without `keepQuery`), so the real URL of all 35 video rows would be stored as one bare `/video` — the chunk fails on `DUPLICATE_IN_BATCH`, or one surviving row redirects the storefront's `/video` list page to a single post. The storefront answers the real inbound `?video={id}` URL by id from that synthetic key (`docs/routing.md`, same section). One key per video is enough: the request-time rule matches by id only, so an underscore-separated second key would be dead weight.

### What is NOT carried through, at all

- **A legacy byline** (see above).
- **An embedded video player.** `berita_vid` has no content-block field in `legacy-import-record.ts` — only `bodyHtml`. `videos.ndjson` appends a plain `<a href="https://youtu.be/{id}">` link after the video's description text instead of an embedded `videoNews` block; the converter accepts a link (unlike an `<iframe>`, which it refuses outright), so the video imports as an article with a link to watch it, not a player.
- **Ad placements** (`ikl_online`) and **institution logos** (`logo`, for [issue #59](https://github.com/ahliweb/awcms-one/issues/59)'s `logo_media_id`) — this exporter reads their row counts for the summary only; creating a placement needs a verified `mediaObjectId` (`POST /api/v1/news-portal/ad-placements`), and `awcms_blog_institutions.logo_media_id` does not exist in this repository's `apps/cms` yet.
- **The full production run** (all ~25,490 `berita_red` rows, every video) is deliberately deferred past this issue's own PR — the manager runs it after issue #57 merges.

### `newsletter_subscribers`, and everything else this exporter never reads

`newsletter_subscribers` is counted and reported, never imported — no consent record survives the legacy signup form. `users`, `counter`, `renungan_rmd`, `tanya_jawab`, and `foto_berita` (the gallery table) are never read at all — see `docs/kamus-data.md`'s mapping table for why each one is excluded.

## Production topology (issue #150, ADR-0019)

`apps/cms` is PostgreSQL-only, and until this section was written, borneojek's own production infrastructure ran MySQL with no PostgreSQL provisioned anywhere on it — the delivery gap [issue #150](https://github.com/ahliweb/awcms-one/issues/150) named directly. What follows is the real, tested production path this repository now ships; [ADR-0019](adr/0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md) records the decisions behind it. `compose.yaml`'s own `postgres:18.4` container remains a LOCAL/CI convenience — `compose.production.yaml` (below) is the production shape, and the two are never meant to share a database.

### The two-role database model

Three distinct identities, never conflated (ADR-0019 D2):

- **`awcms_setup`** (or the Postgres superuser) — the migration-owner connection. Used only to run migrations, never left running.
- **`awcms_app`** — `apps/cms`'s own least-privilege runtime role (`sql/019`). The `cms` service's `DATABASE_URL` must resolve to this role.
- **`awcms_worker`** — the background-job role (`sql/022`). The `jobs` service's `DATABASE_URL` must resolve to this role.

`docker/postgres-init/01-create-least-privilege-roles.sh` (already used by the local/CI `compose.yaml`) activates `LOGIN` and a real password for all three the first time the `postgres` volume is empty.

### Images

- **`apps/cms`** — `apps/cms/Dockerfile.production` (already existed, upstream, unmodified) builds a `runtime` target (only `dist/`, the least-privilege role, no scripts) and a `jobs` target (the full source, so its 30+ registered job targets can actually run).
- **`apps/storefront`** — `apps/storefront/Dockerfile` (new). Multi-stage: a build stage that runs `bun run build` from the REPO ROOT context (this app's build needs `packages/kontrak`'s type-only contract, which itself imports from `apps/cms`'s own source) with `SITE_PROFILE`/`SITE_URL`/`AWCMS_API_URL`/`PUBLIC_AWCMS_ORIGIN`/`PUBLIC_GA_ID` as build ARGs, and `AWCMS_API_TOKEN` ONLY via a BuildKit `--mount=type=secret,id=awcms_api_token` — never an ARG/ENV, so it never enters an image layer (ADR-0019 D4); a runtime stage that carries only `dist/` and runs `bun dist/server/penyaji.mjs` as the image's own non-root `bun` user. **Each `SITE_PROFILE` is its own image** — build `toko`, `berita`, and `landing` separately if more than one deployment shares this repository.

```bash
DOCKER_BUILDKIT=1 docker build \
  -f apps/storefront/Dockerfile \
  --build-arg SITE_PROFILE=toko \
  --build-arg SITE_URL=https://shop.example.test \
  --build-arg AWCMS_API_URL=https://cms.example.test \
  --build-arg PUBLIC_AWCMS_ORIGIN=https://cms.example.test \
  --secret id=awcms_api_token,env=AWCMS_API_TOKEN \
  -t awcms-one-storefront:toko .
```

`apps/cms`'s own `runtime`/`jobs` images above are, since issue #187, additionally built and published to GHCR by CI — see "Published images" immediately below. `apps/storefront`'s image is deliberately not: it stays a manual `docker build` on the deploy host, for the reason given there.

### Published images (issue #187, ADR-0020)

`.github/workflows/images.yml` builds `apps/cms/Dockerfile.production`'s `runtime` and `jobs` targets — the same, unmodified file the "Images" heading above describes — and, on a `v*` tag push or an explicit `workflow_dispatch` run with its `push` input checked, publishes them to:

- `ghcr.io/<owner>/<repo>-cms` — the `runtime` target, i.e. the `cms` service.
- `ghcr.io/<owner>/<repo>-cms-jobs` — the `jobs` target, i.e. the `jobs`/`migrate` services.

(`<owner>/<repo>` is this repository's own GitHub path, lower-cased, so a template-derived repository publishes to its own namespace with nothing to edit — for `ahliweb/awcms-one` that is `ghcr.io/ahliweb/awcms-one-cms` and `ghcr.io/ahliweb/awcms-one-cms-jobs`.) Each push carries three tags — the released semver (`vX.Y.Z` → `X.Y.Z`), the `X.Y` line, and the building commit's `sha` — plus an SBOM and a provenance attestation attached by `docker/build-push-action` itself (`sbom: true`, `provenance: mode=max`), and a second, independent attestation pushed to the registry by `actions/attest-build-provenance`. The workflow also runs, build-only, on a `pull_request` touching `apps/cms/**`/`apps/storefront/**`/`compose.production.yaml`/itself — it never pushes on a PR, and it is not a required status check (AGENTS.md's "The gates").

**Pulling a published image instead of building locally** — set the two env vars `compose.production.yaml`'s `cms`/`jobs`/`migrate` services now read (ADR-0020 D4; both default to today's local-build names, so leaving them unset changes nothing about this file's existing behaviour):

```bash
export AWCMS_ONE_CMS_IMAGE=ghcr.io/ahliweb/awcms-one-cms:0.11.0
export AWCMS_ONE_CMS_JOBS_IMAGE=ghcr.io/ahliweb/awcms-one-cms-jobs:0.11.0
docker compose -f compose.production.yaml pull cms
docker compose -f compose.production.yaml --profile jobs pull jobs
docker compose -f compose.production.yaml --profile migrate pull migrate
docker compose -f compose.production.yaml up -d cms
```

**Verifying the attestation** before trusting a pulled image — `gh` reads the attestation `actions/attest-build-provenance` pushed to the registry:

```bash
gh attestation verify oci://ghcr.io/ahliweb/awcms-one-cms:0.11.0 --owner ahliweb
gh attestation verify oci://ghcr.io/ahliweb/awcms-one-cms-jobs:0.11.0 --owner ahliweb
```

A `PASS` names the exact workflow run and commit the image was built from — the same guarantee this document's own "Rollback/cutover" note already assumes ("every image is tagged by the commit/release it was built from"), now independently checkable rather than only asserted. The **SBOM** itself is inspectable the same way any buildx-attested SBOM is: `docker buildx imagetools inspect ghcr.io/ahliweb/awcms-one-cms:0.11.0 --format '{{ json .SBOM }}'`.

**GHCR package visibility** — the first push to a new package (`ahliweb/awcms-one-cms`, `ahliweb/awcms-one-cms-jobs`) may create it as **private**, GHCR's own default for a package with no prior visibility setting. A private package needs its own pull credential (`docker login ghcr.io` with a token carrying `read:packages`) even for a deploy host this repository's own files name no secret for; the repository owner makes a package public from that package's own GitHub settings (its "Package settings" → "Change visibility") once, after which an anonymous `docker pull` works. Nothing in `.github/workflows/images.yml` sets visibility itself — GHCR ties it to manual owner action, not to anything a workflow run can request on its own behalf.

**Why `apps/storefront` is not published** — see [ADR-0020](adr/0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md) D2: its build bakes a tenant's live catalog/news content using the CMS owner token as a BuildKit secret, so publishing it from CI would mean that production credential living in a GitHub secret, this repository's runners reaching production, and a published tag silently going stale the moment content changes with no corresponding new image. It stays built on the deploy host, exactly as the "Images" section above describes. `.github/workflows/images.yml` only proves `apps/storefront/Dockerfile` still builds — a build-only `storefront-smoke` job, matrixed over all three `SITE_PROFILE` values, against this repository's own stub CMS (`apps/storefront/scripts/stub-awcms.mjs`) — and never publishes the result.

### `compose.production.yaml`

A reproducible topology for a self-hosted deployment: `postgres` (no host port published by default — see the file's own comment for using a managed/external instance instead), `migrate` (one-shot, `--profile migrate`, the ONLY service using the owner/setup DSN), `cms` (the runtime image, `awcms_app` DSN), `jobs` (the jobs image, `awcms_worker` DSN, gated behind `--profile jobs`, invoked on a schedule rather than left running — see "Scheduled jobs" below), and `storefront` (built with the BuildKit secret above). No service publishes a host port for `cms`/`storefront` by default — put a reverse proxy in front and let it terminate TLS. Every credential is read from `apps/cms/.env.example`-derived and root `.env.example`-derived files that are never committed; `tests/compose-produksi.test.mjs` mechanically checks the file for a hardcoded-looking secret, the `awcms_app`/`awcms_worker` role split, and the absent host ports.

### Scheduled jobs

`bun run jobs:crontab:generate` (inside `apps/cms`) already generates `apps/cms/ops/awcms-jobs.crontab` from the module job registry — the single source of truth for which jobs exist and when they run; `jobs:crontab:check` (part of `bun run check`) fails if it drifts. That file's `AWCMS_RUN_JOB` variable is designed for a bare `docker run` against a published image (`apps/cms/ops/run-job.sh`); a docker-compose deployment points it at `ops/run-job-compose.sh` instead (this repository's own new script, ADR-0019 D3) — same `<target> [args...]` signature, calling `docker compose -f compose.production.yaml --profile jobs run --rm jobs bun run <target>`. Install the SAME generated crontab either way; only which container runs each job changes.

### Fail-closed production preflight

Two layered commands, neither replacing `apps/cms`'s own `bun run config:validate`/`bun run security:readiness` (unmodified):

```bash
# Inside apps/cms — commerce-module-specific production checks:
cd apps/cms && bun run commerce:deploy:preflight --live --production

# From the repo root — storefront build-env shape, then delegates to the above:
bun run deploy:preflight --live --production
```

Every check prints one `PASS|FAIL|SKIP` line and a reason, never a secret value. This is enforced structurally, not just by convention (issue #205): a single `redact()` helper masks a `postgres://user:pass@host` DSN's password, a bearer/API-token-shaped value, and the whole value of any env variable whose NAME matches `/(PASSWORD|SECRET|TOKEN|KEY|DSN|DATABASE_URL)/i`, and every printed line — the startup banner, each `PASS|FAIL|SKIP` line, and the tail of a delegated script's captured stderr/stdout (e.g. `jobs:crontab:check`, `apps/cms/scripts/validate-env.ts`) — passes through it before reaching the terminal. A benign value (a provider name, a role name, a plain URL) is printed byte-for-byte unchanged; `apps/cms/tests/commerce-deploy-preflight.test.ts` pins both the redaction and that non-regression down. `--live` additionally connects to `DATABASE_URL` and verifies the runtime role is not a superuser/owner, does not own any `awcms_commerce_*` table, every such table has `relrowsecurity AND relforcerowsecurity`, and the migration ledger has nothing pending. Without `--production`, the production-only rules (OTP delivery, payment/shipping providers not `log`, https canonical URLs) are skipped rather than failed — pass `--production` (or set `APP_ENV=production`) to apply them against a file being reviewed before it is copied into place (`--file <path>`).

### Three distinct concerns: CI checks, artifact publication, production deployment (issue #224, ADR-0022)

It matters, precisely, which of three things is happening at any point in this platform's delivery path — conflating them under a single "Registry/CI-push" description is exactly the ambiguity ADR-0022 exists to close:

1. **CI checks** — `.github/workflows/ci.yml`/`e2e.yml`/`codeql.yml` lint, type-check, test, and run security analysis. They never touch a production credential and never mutate anything running.
2. **Artifact publication** — `.github/workflows/images.yml` (ADR-0020, "Published images" above) builds and, on a tag push, publishes attested `apps/cms` images to GHCR. This is release engineering: producing an immutable, independently verifiable artifact. It still never deploys anything — nothing consumes a published image until a human or agent explicitly tells a production host to.
3. **Production deployment** — `tools/deploy/deploy-production.sh`, described immediately below. This is the ONLY step in this list that mutates a running production system, and it never runs inside GitHub Actions: **no GitHub-hosted or self-hosted Actions runner is part of the production control plane, and no production host is ever registered as a GitHub self-hosted runner** — this repository is public, and GitHub's own guidance is explicit that a public repository's self-hosted runners are exposed to fork-PR code execution with the runner's own credentials and network reach.

### Production deployment (server-side, explicit) — `tools/deploy/deploy-production.sh` (issue #224, ADR-0022)

The canonical, sole deployment entrypoint, run ONLY on the production host (or a host with this repository and `compose.production.yaml` checked out) — never by GitHub Actions, never triggered automatically by a push or merge:

```bash
tools/deploy/deploy-production.sh <exact-tag|40-char-sha|image@sha256:digest>
# or, from a laptop, over SSH to the production host, with no logic duplicated locally:
tools/deploy/deploy-remote.sh <ssh-host> <exact-tag|40-char-sha|image@sha256:digest>
```

Accepted targets are exactly three shapes, and nothing else: an exact release tag (`vX.Y.Z`), a 40-character commit SHA, or a GHCR image reference pinned by digest (`ghcr.io/<owner>/<repo>-cms@sha256:<64 hex>`) — a branch name, a short SHA, or a floating tag is rejected before anything runs. **The published GHCR image (ADR-0020) is the preferred target once one exists for a release** — it is independently attested, needs no rebuild on the production host, and a rollback to a previous digest is instant; a tag/SHA source build remains fully supported and is the only option before a release's images are published, or for a deployment that never publishes images at all.

The script runs the full transaction under `set -Eeuo pipefail` and a non-blocking `flock` (a concurrent invocation is refused immediately, not queued):

```text
acquire lock -> resolve target -> record current release
  -> fetch/verify (git status --porcelain must be empty; fails closed on a dirty checkout)
  -> preflight (bun run deploy:preflight --live --production)
  -> pre-migration backup (docker compose --profile backup run --rm backup)
  -> build (source target) or pull+optional cosign verify (image target)
  -> migrate (docker compose --profile migrate run --rm migrate — the privileged setup identity)
  -> verify the runtime role is rolsuper=false AND rolbypassrls=false
  -> activate (docker compose up -d cms storefront)
  -> health (tools/deploy/healthcheck-production.sh)
  -> smoke (GET /api/v1/health, GET /healthz)
  -> append-only audit record (timestamp, target, previous release, operator, per-step result)
  -> success
```

A target already deployed and healthy is a no-op success. On a failure after activation, the script rolls the runtime back to the previous recorded release automatically ONLY when no migration was applied during that same attempt — decided by reading `apps/cms`'s migration ledger (`awcms_schema_migrations`) before and after the migrate step, where an unreadable count counts as "applied" (`tools/deploy/rollback-production.sh [<previous-release>]`, also runnable by hand); when a migration did run, it stops and prints the path to "A known gap" and the backup-assurance runbook below instead of guessing that a code rollback is safe against a schema that may have changed. Every line this tooling prints — and the append-only audit log at `${DEPLOY_STATE_DIR:-/var/lib/awcms-one-deploy}/audit.jsonl` — is redacted through `packages/gerbang/lib/redact.mjs` (via `tools/deploy/redact-log.mjs`) before it reaches a terminal or disk, the same discipline issue #205 established for `apps/cms`'s own preflight. `tests/deploy-production.test.mjs` is a hermetic scenario suite over every failure path named above — docker/git/curl/ssh/cosign are all stubs on `PATH` (also bindable via `DOCKER=`/`GIT=`/`CURL=`/`SSH=`/`COSIGN=`, which every script reads instead of a hardcoded command); no test ever touches a real container, git remote, or network endpoint.

Every environment variable these scripts read (`DEPLOY_STATE_DIR`, `DEPLOY_SKIP_BACKUP`, `DEPLOY_COSIGN_VERIFY_COMMAND`, the command overrides, the smoke-check URLs, `DEPLOY_REMOTE_SCRIPT_PATH`) is documented in root `.env.example`'s "Server-side production deployment" section.

**First-time host setup** (once, before the first deploy):

1. Create a dedicated `deploy` system user rather than deploying as root or a shared developer account; give it membership in the `docker` group (or equivalent least-privilege Docker/Coolify access) and nothing wider.
2. Generate a key-based SSH credential for that user. Optionally restrict `~deploy/.ssh/authorized_keys` with a forced command, so a key that leaks can only ever run this repository's own deploy entrypoint:
   ```
   command="/home/deploy/awcms-one/tools/deploy/deploy-production.sh $SSH_ORIGINAL_COMMAND",no-port-forwarding,no-X11-forwarding,no-agent-forwarding ssh-ed25519 AAAA... operator@laptop
   ```
3. `mkdir -p /var/lib/awcms-one-deploy && chmod 700 /var/lib/awcms-one-deploy` (or point `DEPLOY_STATE_DIR` elsewhere) — the lock, audit log, and current-release state live here.
4. Create `.secrets/` (already `.gitignore`d) with the BuildKit/backup secret files "Secrets" and "Backup assurance" above describe, with restrictive permissions (`chmod 600`).
5. Provision PostgreSQL — either the `postgres` service in `compose.production.yaml`, or a managed instance with the same three roles created by hand (see that file's own comment).
6. Run the FIRST deploy against a genuinely fresh database with `DEPLOY_SKIP_BACKUP=true` (nothing yet to back up), e.g. `DEPLOY_SKIP_BACKUP=true tools/deploy/deploy-production.sh v1.0.0` — every subsequent deploy runs with the default (backup enforced).
7. Install `apps/cms/ops/awcms-jobs.crontab` on the host, with `AWCMS_RUN_JOB` pointed at `ops/run-job-compose.sh` (see "Scheduled jobs" above) — the deploy script does not install this for you.
8. **Register the storefront's real origin** in `awcms_tenant_domains` — the anonymous storefront API resolves its tenant from the calling browser's `Origin` header (see "The seeded tenant's storefront origins must be registered" above); a deployment that skips this step gets a working build and a checkout that never resolves a tenant.

**An ordinary deploy**, once the host is set up: `tools/deploy/deploy-production.sh v1.4.0` (or the equivalent GHCR digest). **A rollback**: `tools/deploy/rollback-production.sh` with no argument rolls back to whatever `deploy-production.sh` last recorded as the previous release; pass an explicit release to roll back to something else.

**DB recovery when a rollback is not schema-compatible** — this is the one path `deploy-production.sh`/`rollback-production.sh` deliberately refuse to automate, because guessing wrong here can corrupt data. When a deploy attempt ran a migration and then failed (health/activation failure), the script's own audit line names the target and the pre-migration backup that step already took: restore that backup with the manual, confirmed `restore-postgres.sh --target=<db> --yes` command "Restore drills default to isolated/disposable" below documents, into a scratch/staging database first to confirm it, then follow your organization's own change-management process to decide whether to restore into the real production database or to forward-fix with a new migration instead (`apps/cms/scripts/db-migrate.ts`'s own rule: never hand-edit an applied migration).

**Coolify** — if Coolify is the chosen orchestrator instead of (or alongside) bare `docker compose`, disable its GitHub-push-to-production auto-deploy webhook for this path; Coolify's own API token/credentials live only on the deployment host, never in a GitHub Actions secret. A script that calls the Coolify API does so with an explicit, already-resolved release identity, and still runs this repository's own `healthcheck-production.sh`/smoke checks itself afterward rather than trusting Coolify's own "deployment succeeded" signal as the final word.

### Health/readiness and rollback mechanics

`cms` exposes `GET /api/v1/health` (liveness — answers 200 even with the database unreachable, by design; see `apps/cms/Dockerfile.production`'s own comment on why a probe that restarts containers must not depend on the database) and `GET /api/v1/database/pool/health` (the real dependency-health question, read by `apps/cms/ops/synthetic-check.sh` rather than a container orchestrator). `storefront` exposes `GET /healthz`, reporting the build id `apps/storefront/scripts/write-build-id.mjs` wrote at build time. Every image is tagged by the commit/release it was built from; a rollback is redeploying the previous tag/digest, never editing a running container. Migrations are forward-only with immutable checksums (`apps/cms/scripts/db-migrate.ts`'s `validateAppliedChecksums` refuses to re-apply an already-applied migration whose file content changed) — a bad migration is corrected by a NEW migration, never a hand-edit of an applied one.

**Backup/restore:** see "Backup assurance" immediately below — the encrypted, authenticated, off-site-copied, drill-tested path this repository's own production topology now uses, reusing upstream `apps/cms/deploy/backup/*.sh` through `compose.production.yaml`'s own `backup`/`restore-drill`/`offsite-copy` services — the SAME `backup` step `deploy-production.sh` runs automatically before every migration. (`apps/cms/ops/backup-awcms.sh`/`restore-drill-awcms.sh` are a different, older, host-specific pair of scripts upstream still carries for a different deployment's own cron — not what this repository's own production topology installs; do not confuse the two.)

## Backup assurance (issue #213)

`apps/cms/deploy/backup/*.sh` (synced in by issue #210, upstream's own tooling — see [ADR-0123](https://github.com/ahliweb/awcms/blob/main/docs/adr/0123-backup-encryption-manifest-authentication.md) and that directory's own `README.md` for what each script does and why) are used here through THIS repository's own production topology, not reimplemented. `compose.production.yaml` adds three profile-gated services — `backup`, `restore-drill`, `offsite-copy` — each a thin wrapper: a container built from `docker/backup/Dockerfile` (the SAME `postgres:18.4` the `postgres` service runs, plus `age`/`rsync`/`openssh-client` — exactly what `apps/cms/deploy/backup/README.md`'s own "Base images ship neither `age` nor a database client by default" note asks for) with `apps/cms/deploy/backup/` bind-mounted read-only at `/scripts` and the actual script invoked unmodified.

### Database identity (scope item 1)

`backup` and `restore-drill` both connect with `SETUP_DATABASE_URL` — the SAME migration-owner DSN `migrate` already uses in this file, never `awcms_app` (`cms`) or `awcms_worker` (`jobs`). Two structural reasons: `pg_dump` has to read every table, which the least-privilege runtime roles are deliberately denied (sql/019/021); and `restore-postgres.sh`'s drill mode creates and drops its own scratch database, which needs `CREATEDB`. `offsite-copy` needs no database connection at all — it only moves already-written files.

### Secrets (scope item 2)

Four new file-backed compose secrets, the SAME mechanism `storefront`'s own `awcms_api_token` already uses (mounted read-only at `/run/secrets/<name>`, never an `environment:` value, never an image layer, never `docker inspect`'s own output):

| Secret | Env var pointing at its host file | Holds |
| --- | --- | --- |
| `backup_age_recipients` | `BACKUP_AGE_RECIPIENTS_FILE` | `age` public recipient(s) — safe on the backup host |
| `backup_hmac_key` | `BACKUP_HMAC_KEY_FILE` | the HMAC-SHA256 key — needed on BOTH backup and restore hosts |
| `restore_age_identity` | `RESTORE_AGE_IDENTITY_FILE` | the `age` PRIVATE identity — restore/drill hosts ONLY, never the backup host |
| `offsite_ssh_key` | `OFFSITE_SSH_KEY_FILE` | the off-site SSH private key |

Generate them exactly as `apps/cms/deploy/backup/README.md`'s own step 1 documents (`age-keygen`, `openssl rand`), on a workstation, not the backup host itself; then, e.g.:

```bash
mkdir -p .secrets
age-keygen -o .secrets/restore-age-identity.key
grep '^# public key:' .secrets/restore-age-identity.key | sed 's/# public key: //' > .secrets/backup-age-recipients.txt
openssl rand -out .secrets/backup-hmac.key 32
cp <your off-site ssh private key> .secrets/offsite-ssh-key
```

`.secrets/` is already `.gitignore`d (the same rule `AWCMS_API_TOKEN_FILE` relies on). None of these four files, nor any value derived from them, is ever printed by any script in `apps/cms/deploy/backup/` — see that directory's own README "Secrets — what goes where, and what never appears in a log" table.

### Where artifacts live, and off-site copy (scope items 3-4)

Encrypted artifacts, sidecars, manifests, and the restore-drill evidence log live in the named volume `awcms-one-production-backups`, mounted at `/backup` in all three services. `offsite-copy` needs `OFFSITE_SSH_TARGET` (`user@host:/absolute/path`) and reads the SAME artifact-selection algorithm `restore-drill.sh` already uses (via `docker/backup/select-and-offsite-copy.sh`, this repository's own small glue script — not a fork of `offsite-copy.sh` itself, which it calls unmodified) to pick the newest eligible backup plus its sidecars. A transfer that fails after `offsite-copy.sh`'s own retries exits non-zero and never deletes the local copy — a local-only backup is never reported as a successful off-site copy (`offsite-copy.sh`'s own header; verified in this issue's own validation run by stopping the off-site target mid-schedule).

### Retention/rotation (scope item 5)

Local retention is `BACKUP_RETENTION_DAYS` (default 14, `0` disables), read by `backup-postgres.sh` itself. Off-site retention is whatever policy the destination in `OFFSITE_SSH_TARGET` applies — `offsite-copy.sh` only copies, never prunes the destination (its own header). Both are operator-owned host/destination policy, not something this repository's tooling manages.

### Scheduled invocation (scope item 6)

`ops/run-backup-compose.sh <backup|restore-drill|offsite-copy>` is the `ops/run-job-compose.sh` shape (issue #150) applied to these three profiles — `docker compose -f compose.production.yaml --profile <task> run --rm <task>`. `ops/awcms-one-backup.crontab` is the install-by-hand manifest (same convention as `apps/cms/deploy/cron/awcms.crontab`): backup nightly, off-site copy right after, restore drill weekly.

### Observability (scope item 7)

Every script prints exactly what it did to stdout/stderr — nothing is swallowed — so a host crontab redirecting to a log file (as `ops/awcms-one-backup.crontab` does) makes success/failure visible in the log, and a non-zero exit from `ops/run-backup-compose.sh` is what a cron mailer or external log-shipping/alerting setup keys off. `restore-drill.sh` additionally appends one JSON line per run to `${BACKUP_DIR}/restore-drill-evidence.jsonl` — timestamp, artifact name, pass/fail, measured RTO/RPO, no secrets or database contents — safe to ship to log aggregation or attach to a change-management ticket.

### Restore drills default to isolated/disposable, structurally (scope item 8, safety requirement)

`restore-drill` has a hard-coded `command: ["bash", "/scripts/restore-drill.sh"]` in `compose.production.yaml` — never `restore-postgres.sh` directly, and never with `--target`. `restore-drill.sh` itself has no `--target` code path anywhere in it (its own header states this), and `restore-postgres.sh`'s own drill mode (no `--target` given) creates its OWN scratch database (`RESTORE_SCRATCH_DB`, default `awcms_restore_drill`), refuses if that name equals the connected database, restores into it, verifies it, and drops it — the connected/production database is never mutated. There is no environment variable, compose profile, or cron argument that turns this service destructive; a real disaster-recovery restore is deliberately NOT a compose service — it is the manual, confirmed `docker run ... restore-postgres.sh <dump> --target=<db> --yes` step below, one step further from an accidental `docker compose up` or copy-pasted cron line than a service definition would be:

```bash
docker run --rm --network container:<the postgres container> \
  -v awcms-one-production-backups:/backup \
  -v ./apps/cms/deploy/backup:/scripts:ro \
  -e DATABASE_URL="<owner/setup DSN>" \
  -e RESTORE_AGE_IDENTITY_FILE=/secrets/restore-age-identity.key \
  -e BACKUP_HMAC_KEY_FILE=/secrets/backup-hmac.key \
  postgres:18.4 \
  bash /scripts/restore-postgres.sh /backup/<artifact>.dump.age --target=<db> --yes
```

### RTO/RPO evidence (scope item 9)

`restore-drill.sh` measures both directly, with no production data ever leaving the drill: `restoreRtoSeconds` is the real wall-clock verify→decrypt→restore→check duration; `restoreRpoSeconds` is the age of the backup it drilled, at drill time. Validating this issue against a disposable PostgreSQL with synthetic data (one fictional tenant row, no real customer/business data), a full drill measured **RTO 2-3 seconds, RPO 1-615 seconds** depending on how long since the last synthetic backup — evidence of the mechanism, not a production SLA; a real deployment's own numbers depend on database size and its own `backup`/`restore-drill` cron cadence.

### How this relates to the current production topology (scope item 10)

`backup`/`restore-drill`/`offsite-copy` are additive services in the SAME `compose.production.yaml` this document's "Production runbook" already describes — no change to `postgres`/`migrate`/`cms`/`jobs`/`storefront`, and no new host-accessible database port (the safety rule above: production stays reachable only from the compose project's own network; `backup`/`restore-drill` join that same network the way `migrate` already does).

### Failure paths verified

Exercised directly against a disposable PostgreSQL (`bun run db:up`) with synthetic data, using both the raw scripts and the actual `compose.production.yaml` services/image:

- **Wrong/missing encryption key material** — `restore-postgres.sh` refuses before touching any database when `RESTORE_AGE_IDENTITY_FILE` is unset, or when `BACKUP_HMAC_KEY_FILE` points at the wrong key (HMAC mismatch).
- **Tampered manifest** — a single field edited in the manifest JSON is caught by the HMAC check before decryption is attempted.
- **Corrupted backup** — a single flipped byte in the ciphertext is caught by the manifest's `artifact_sha256` check before decryption is attempted.
- **Unavailable off-site destination** — `offsite-copy.sh` retries, then exits non-zero, and the local copy is untouched; nothing reports a local-only backup as off-site.
- **Unsafe/non-isolated restore target** — `restore-postgres.sh --target=<db>` refuses when `<db>` equals the database named in the connection DSN, before any mutation; `restore-drill`'s own compose service cannot reach this code path at all (see above).

### Not exercised

A wrong/malformed `age` recipients file at BACKUP time (as opposed to wrong identity at RESTORE time) was observed once, incidentally, during this issue's own validation (a synthetic non-bech32 recipients file made `backup-postgres.sh` fail closed with the plaintext dump left in place and no `.age` artifact written) but was not driven as a deliberate, repeatable test case the way the five paths above were. A genuinely unreachable off-site SSH host (DNS failure, not just connection-refused) and a `restore-postgres.sh --target` confirmation prompt under a real TTY were not separately exercised — the underlying code paths are the same ones `apps/cms`'s own upstream test suite for these scripts already covers.

### What remains not built (ADR-0019 D7, narrowed by ADR-0020)

`apps/cms`'s own `runtime`/`jobs` images are, as of issue #187, published by `.github/workflows/images.yml` — see "Published images" above; that part of ADR-0019 D7's own list is now closed. What remains, deliberately: a CI pipeline that publishes `apps/storefront`'s per-profile images to a registry — [ADR-0020](adr/0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md) D2 rejects this outright, not merely postpones it (the build-time content-fetch and the BuildKit-secret owner token — see "Published images" above — make a published storefront image a production-credential and staleness risk, not only an unbuilt convenience). A reverse-proxy/TLS-termination configuration beyond the example above — an operator's own ingress terminates TLS. A Xendit payment adapter and courier tracking (both named as explicit ADR-0017 follow-ups). A production PostgreSQL this repository itself operates — `compose.production.yaml`'s `postgres` service is provided for a self-hosted deployment; a managed instance is documented as an alternative, not shipped.
