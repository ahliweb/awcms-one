🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](deployment.id.md)

# Deployment

How `apps/storefront` is built and served, its environment variables, and — plainly, because it changes what "deploying this repository" even means today — that `apps/cms` cannot yet be deployed against a real database on borneojek's own infrastructure.

## Build, then serve — two separate steps, two separate trust levels

```bash
bun run build          # bun run check && astro build && build:build-id && build:penyaji
bun run serve          # bun dist/server/penyaji.mjs
```

`bun run build` (`apps/storefront/package.json`) runs `bun run check` (the type-check), then `astro build` (fetches the catalog, marketing surfaces, and news content from `apps/cms` using `AWCMS_API_TOKEN`, bakes every page to `dist/client/`, and writes the derived CSP artifact — see [`docs/arsitektur.md`](arsitektur.md)), then writes a build id, then `build:penyaji` (bundles `apps/storefront/server/penyaji.mjs` itself to `dist/server/penyaji.mjs` via `bun build --target=bun`). **Only the build step ever reads an `AWCMS_*` variable, and only the build step ever reads `AWCMS_API_TOKEN` at all.** `bun run serve` runs the already-built `dist/server/penyaji.mjs`, which reads `PORT`/`HOST` and, at startup only, its own built `csp.json` artifact — never a live `apps/cms` credential. This is the mechanical proof of [ADR-0002](adr/0002-static-output-with-build-time-fetch-for-the-storefront.md)'s claim that the *container* never talks to `apps/cms`: the served process's own source contains no code path that reads a credential or a URL that could reach it. **What increment 2 adds is a second, browser-side relationship** — cart, checkout, and order tracking pages ship client-side JavaScript that calls `apps/cms`'s anonymous `/api/v1/commerce/storefront/*` endpoints directly, cross-origin, from the reader's own browser, never from the container — see [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md).

## Environment variables

Two separate `.env.example` files, one per workspace, deliberately not merged — `apps/storefront`'s own file documents only what it reads; it does not duplicate `apps/cms`'s.

### `apps/storefront/.env.example`

| Variable | Read | Purpose |
| --- | --- | --- |
| `SITE_URL` | Build time (also `astro.config.mjs` directly, before `apps/storefront/src/config/site.ts` runs) | The canonical absolute origin — canonical links, Open Graph URLs, and `Product` JSON-LD are all built from it |
| `SITE_NAME`, `SITE_DESCRIPTION` | Build time | Optional; sensible defaults so `bun run dev` works with no `.env` at all |
| `AWCMS_API_URL` | Build time only | Origin of the `apps/cms` instance to fetch the catalog, marketing, and news content from |
| `AWCMS_API_TOKEN` | Build time only | A **read-only** Bearer credential, scoped to every commerce `read` permission (issue #25's seed now issues one credential covering catalog, marketing, and — where applicable — order export reads) — never emitted into the build output; not prefixed `PUBLIC_`, deliberately, since Vite only inlines `PUBLIC_`-prefixed variables into client-reachable code |
| `AWCMS_API_TIMEOUT_MS` | Build time only, optional | How long one request to `apps/cms` may take before the build gives up (default 30000 ms) — a value that is not a positive number is refused outright, including `0`, which would otherwise mean "no limit" and restore the exact hang this deadline exists to prevent |
| `PUBLIC_AWCMS_ORIGIN` | Build time, and baked into the served CSP | **New in issue #30.** The `apps/cms` origin the *browser* calls at runtime for cart/checkout/order-tracking — deliberately `PUBLIC_`-prefixed, since it is an origin, not a secret (the same value every media URL already reveals). Validated by `apps/storefront/src/lib/awcms/toko-origin.ts`; an unset or malformed value fails the build outright, naming the variable, because `apps/storefront/src/pages/csp.json.ts` — a page every build unconditionally prerenders — calls the validator unconditionally. See [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md) and [`docs/arsitektur.md`](arsitektur.md) |
| `PUBLIC_WILAYAH_PROVINSI` | Build time, optional | Which Indonesian provinces' address-region data (`idn_admin_regions`) to bake into `/index/wilayah-*.json` for the checkout address form — default every Kalimantan province, deliberately not the full ~90,000-village national dataset |
| `PUBLIC_GA_ID` | Build time, and baked into the served CSP | **New in issue #56.** GA4's own Measurement ID (`G-…`). Unset, empty, or not shaped like one (`apps/storefront/src/lib/ga.ts`) and the build ships with no Google origin anywhere at all — see "The two switches" below |
| `PORT`, `HOST` | Runtime, by `apps/storefront/server/penyaji.mjs` only | Defaults `8080`/`0.0.0.0` — `0.0.0.0` because this process normally runs inside a container behind a reverse proxy, where a `localhost`-only listener is unreachable from outside the container and shows up as a health check failing for no stated reason |

### `apps/cms/.env.example`

A much larger file, owned entirely by `apps/cms` as embedded `ahliweb/awcms` code — this repository's root does not duplicate it (`AGENTS.md`'s "Configuration and toolchain": "every env variable a root-level script reads belongs in `.env.example`... `apps/cms` maintains its own `.env.example` for its own runtime configuration; this repo's root file does not duplicate it"). The variables that matter for understanding what a running `apps/cms` needs: `DATABASE_URL` (application role `awcms_app` — never the database owner role, which is a Postgres superuser that bypasses `FORCE ROW LEVEL SECURITY` outright, defeating the exact isolation [`docs/skema-basis-data.md`](skema-basis-data.md) documents), `APP_ENV`/`APP_URL`, and the HTTP listener variables (`PORT`, `HOST`, and optional in-process TLS certificate paths) its own standalone entrypoint reads.

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
- The 8-category catalog and one product per commerce `type` (physical/service/subscription/digital, the last a clearly-marked synthetic placeholder), with full BjekMart parity fields (images, variants, size charts, service forms) from `tools/seed-data/*.json`.
- The marketing surface: one flash sale with a product, two vouchers, three testimonials, a popup, and store settings.
- A handful of blog terms/pages/posts and the site profile, including six social links and a WhatsApp number.
- One customer with two orders in different states (`pending_payment`, `paid`), created through the anonymous order-creation path itself — not a backdoor — so the seed doubles as a proof that path works.
- A read-only machine credential scoped to every commerce `read` permission (catalog, marketing, and order/customer/review reads) — the same credential shape `apps/storefront`'s build token needs.
- **Issue #57** — the news IA's own reference taxonomy, modelled on seputarborneo's real structure (`include/nav_menu.php`'s `seputarborneo_taksonomi()`, verified 2026-09-18): an 8-rubrik `category` tree (politik, hukum, nasional, olahraga, wisata, daerah, mitra-borneo, umum) with umum's 5 topical children plus a `wisata-travel` child (seputarborneo's own `Wisata`/`WISATA` slug collision resolved this way — `awcms_blog_terms_slug_dedup`, `apps/cms/sql/035_awcms_blog_content_schema.sql`, is unique on `(tenant_id, taxonomy_type, slug)` with no `parent_id` component, so one tree cannot hold two `wisata` slugs); the 27-institution legislative/executive directory (`POST /api/v1/blog/institutions`) — seputarborneo's own 24-channel Mitra Borneo list (`seputarborneo_nav_mitra()`) plus a bare `Pemkab` for each of the 3 regencies that list leaves out (Kotawaringin Barat, Sukamara, Barito Selatan), added so all 14 Kalteng regencies/cities — not just the 11 the reference site's own list happens to name — have at least one institution to carry their `regionCode`, since region membership is institution-only (see the finding below); each `regionCode` resolved by NAME against `GET /api/v1/idn-regions/regions` at seed time (never hard-coded — this is why the `idn-regions:import`/`idn-regions:activate` step above is now part of this sequence); 19 sample news posts across every rubrik (three carrying a Portable Text `videoNews` node with a clearly-marked placeholder YouTube id, since no real seputarborneo channel id was available to verify); three additional legal pages (`redaksi` — generic placeholders, deliberately NOT seputarborneo's own company/personnel data; `pedoman-media-siber` — Dewan Pers's public text, ported; `disclaimer` — genericized to this tenant); and 5 sample `legacy_blog`-origin redirects (`/news/{id}-{slug}.html` → this CMS's own `/blog/borneojek-mart/{slug}`) exercising `docs/routing.md`'s row-based legacy-redirect path. **Ad placements are the one part of this step that does not create anything in this local/CI deployment** — see "What this script still does not seed, and why" below.

**A finding that turned out to affect every page/post this script has ever seeded, not only issue #57's own** — `createBlogPage`/`createBlogPost` always write `status: 'draft'`, and until issue #57 nothing in this script ever transitioned either one past it, so `kebijakan-privasi`/`tos` and BjekMart's own 3 posts were, and would have stayed, invisible to `apps/storefront`'s build (`blog/pages/public.ts`'s predicate and `blog.ts`'s `getAllPosts()` both require `published`). Found while verifying issue #57's own "renders `/halaman/redaksi`"/"renders `/berita`" acceptance criteria against a REAL seeded local CMS instead of the stub (whose fixtures are canned, already-published data and never exercised this path). Fixed for every page/post this script creates, going forward and on re-run against an already-seeded tenant.

It prints the owner password and the machine credential token exactly once, on the run that creates them — neither is stored anywhere by the script.

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

**Ad placements (issue #57) are the one resource this script cannot create locally, at all**, and this is a harder gap than the placeholder-SVG one above: unlike a product image, `POST /api/v1/news-portal/ad-placements`'s `mediaObjectId` is REQUIRED and existence/status-checked against `awcms_news_media_objects` (`ad-placement-reference-validation.ts`) — only a `verified`/`attached` media object satisfies it, and reaching `verified` needs `finalizeNewsMediaUploadSession` to perform a real R2 `GET` + checksum, which needs `NEWS_MEDIA_R2_*` configured. This repo's local/CI compose stack provisions PostgreSQL only, no R2/S3-compatible object storage. `tools/seed-data/ad-placements.json` and the four correctly-sized placeholder PNGs under `tools/seed-assets/` (`ad-728x90.png`/`ad-970x250.png`/`ad-300x250.png`/`ad-300x600.png`) exist so the seed script's `ensureAdPlacements` step genuinely creates all 12 the moment a deployment DOES have `NEWS_MEDIA_R2_*` configured — locally it prints one explanatory skip line instead of 12 failures, and creates nothing.

## Production PostgreSQL provisioning is not done

`apps/cms` is PostgreSQL-only. **borneojek's production server runs MySQL** — the very database this platform's catalog schema is being re-expressed from (see [`docs/kamus-data.md`](kamus-data.md)) — so a PostgreSQL instance has to be provisioned on that infrastructure, or elsewhere, before `apps/cms` can be deployed against a real, production database. `compose.yaml`'s `postgres:18.4` container is deliberately a LOCAL/CI convenience (a named volume on a developer's disk, development-grade default passwords documented in `.env.example`) and is never meant to be pointed at from a production deployment. This is why [`docs/pengujian.md`](pengujian.md) describes `apps/cms`'s DB-gated test suite as something to run against a locally provisioned, disposable PostgreSQL, never against anything borneojek currently operates.

## Not built

Any Dockerfile, container image, or deployment pipeline for either `apps/cms` or `apps/storefront` in this repository — nothing under `.github/workflows/` builds or publishes a container image today (see [`docs/alur-kerja-pengembangan.md`](alur-kerja-pengembangan.md) for exactly what CI does run). A reverse-proxy/TLS-termination configuration for `apps/storefront` in production — `apps/storefront/server/penyaji.mjs` assumes one exists in front of it but does not configure or document one itself.
