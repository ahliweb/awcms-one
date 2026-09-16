🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](deployment.id.md)

# Deployment

How `apps/storefront` is built and served, its environment variables, and — plainly, because it changes what "deploying this repository" even means today — that `apps/cms` cannot yet be deployed against a real database on borneojek's own infrastructure.

## Build, then serve — two separate steps, two separate trust levels

```bash
bun run build          # bun run check && astro build && build:penyaji
bun run serve          # bun dist/server/penyaji.mjs
```

`bun run build` (`apps/storefront/package.json`) runs `bun run check` (the type-check), then `astro build` (fetches the catalog from `apps/cms` using `AWCMS_API_TOKEN`, bakes every page to `dist/client/`), then `build:penyaji` (bundles `apps/storefront/server/penyaji.mjs` itself to `dist/server/penyaji.mjs` via `bun build --target=bun`). **Only the build step ever reads an `AWCMS_*` variable.** `bun run serve` runs the already-built `dist/server/penyaji.mjs`, which reads exactly two environment variables — `PORT` and `HOST` — and none of `apps/cms`'s. This is the mechanical proof of [ADR-0002](adr/0002-static-output-with-build-time-fetch-for-the-storefront.md)'s claim that the running container never talks to `apps/cms`: it is not merely that it does not today, it is that the served process's own source contains no code path that reads a credential or a URL that could reach it.

## Environment variables

Two separate `.env.example` files, one per workspace, deliberately not merged — `apps/storefront`'s own file documents only what it reads; it does not duplicate `apps/cms`'s.

### `apps/storefront/.env.example`

| Variable | Read | Purpose |
| --- | --- | --- |
| `SITE_URL` | Build time (also `astro.config.mjs` directly, before `apps/storefront/src/config/site.ts` runs) | The canonical absolute origin — canonical links, Open Graph URLs, and `Product` JSON-LD are all built from it |
| `SITE_NAME`, `SITE_DESCRIPTION` | Build time | Optional; sensible defaults so `bun run dev` works with no `.env` at all |
| `AWCMS_API_URL` | Build time only | Origin of the `apps/cms` instance to fetch the catalog from |
| `AWCMS_API_TOKEN` | Build time only | A **read-only** Bearer credential, scoped to the commerce module (products, categories) — never emitted into the build output; not prefixed `PUBLIC_`, deliberately, since Vite only inlines `PUBLIC_`-prefixed variables into client-reachable code |
| `AWCMS_API_TIMEOUT_MS` | Build time only, optional | How long one request to `apps/cms` may take before the build gives up (default 30000 ms) — a value that is not a positive number is refused outright, including `0`, which would otherwise mean "no limit" and restore the exact hang this deadline exists to prevent |
| `PORT`, `HOST` | Runtime, by `apps/storefront/server/penyaji.mjs` only | Defaults `8080`/`0.0.0.0` — `0.0.0.0` because this process normally runs inside a container behind a reverse proxy, where a `localhost`-only listener is unreachable from outside the container and shows up as a health check failing for no stated reason |

### `apps/cms/.env.example`

A much larger file, owned entirely by `apps/cms` as embedded `ahliweb/awcms` code — this repository's root does not duplicate it (`AGENTS.md`'s "Configuration and toolchain": "every env variable a root-level script reads belongs in `.env.example`... `apps/cms` maintains its own `.env.example` for its own runtime configuration; this repo's root file does not duplicate it"). The variables that matter for understanding what a running `apps/cms` needs: `DATABASE_URL` (application role `awcms_app` — never the database owner role, which is a Postgres superuser that bypasses `FORCE ROW LEVEL SECURITY` outright, defeating the exact isolation [`docs/skema-basis-data.md`](skema-basis-data.md) documents), `APP_ENV`/`APP_URL`, and the HTTP listener variables (`PORT`, `HOST`, and optional in-process TLS certificate paths) its own standalone entrypoint reads.

## What the storefront container may and may not reach

| | May reach |
| --- | --- |
| Build process (`astro build`) | `apps/cms`'s public API, over HTTPS, with the read-only build token |
| Running container (`bun dist/server/penyaji.mjs`) | Nothing outside itself — no `apps/cms`, no database, no external network call of any kind |

`apps/storefront/server/penyaji.mjs`'s own CSP (`connect-src 'self'`, among every other directive set to `'self'` or `'none'`) additionally blocks the *browser* from being made to call anything beyond this same origin — there is no configured external origin to widen it for, because this app has no product-image host or third-party script to allow.

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

`tools/seed-borneojek-mart.ts` (`bun run db:seed:cms`) drives the running `apps/cms` from step above as an HTTP client of its own public `/api/v1/*` surface — the same interface `apps/storefront`'s build uses, and the only one issue #23/#26/#29 commit to keeping stable. It bootstraps the `borneojek-mart` tenant and owner (`POST /api/v1/setup/initialize`), seeds the 8-category catalog and one representative product per commerce `type` from `tools/seed-data/*.json`, a handful of blog terms/pages/posts, the site profile, and issues a read-only machine credential scoped to `commerce.products.read`/`commerce.categories.read` — the same credential shape `apps/storefront`'s build token needs. Every step is idempotent (checks for the row before creating it); re-running it against the same tenant creates nothing new and exits 0. It prints the owner password and the machine credential token exactly once, on the run that creates them — neither is stored anywhere by the script.

Proving the seeded catalog is servable:

```bash
curl -H "Authorization: Bearer <AWCMS_API_TOKEN printed above>" \
     -H "x-awcms-tenant-id: <tenantId printed above>" \
     http://localhost:4321/api/v1/commerce/products

cd apps/storefront && AWCMS_API_URL=http://localhost:4321 \
  AWCMS_API_TOKEN=<token> SITE_URL=http://localhost:4321 bun run build
```

`bun run build` prerenders one page per seeded product plus the catalog index — the same acceptance criterion issue #25 states.

```bash
bun run db:down                         # stop the container, keep the volume
bun run db:reset                        # drop the volume too — a clean slate
```

### Product types issue #23 fills in

`/api/v1/commerce/products` accepts the 12-field shape `apps/cms/src/modules/commerce/domain/product-validation.ts`'s `CreateProductInput` defines today — no images, no variants, no `service_form`, no `subscription_period`. `tools/seed-data/products.json` already carries the BjekMikro/RutinRide `service_form`/variant/`subscription_period` values observed on the live site, under each product's `future` key, alongside `tools/seed-assets/`'s placeholder product images — so landing issue #23's fields is a change to what `tools/seed-borneojek-mart.ts`'s `ensureProducts()` sends, reading data already present in this file, never a restructure of the seed data or a second script.

### What this script does NOT seed, and why

The legacy `commerce_bj_mart` store settings (customer levels, the `BORNEOJEK` alternative shipping method, self-pickup, manual QRIS) have no field on `/api/v1/site-profile`, `/api/v1/commerce/*`, or any other endpoint `apps/cms` exposes today — verified by reading every registered module, not assumed. `tools/seed-data/site-profile.json` records these values under its own `future` key so the values are not lost, but this script does not invent an endpoint to receive them; that is a decision for issue #26/#29, or a new admission, to make.

## Production PostgreSQL provisioning is not done

`apps/cms` is PostgreSQL-only. **borneojek's production server runs MySQL** — the very database this platform's catalog schema is being re-expressed from (see [`docs/kamus-data.md`](kamus-data.md)) — so a PostgreSQL instance has to be provisioned on that infrastructure, or elsewhere, before `apps/cms` can be deployed against a real, production database. `compose.yaml`'s `postgres:18.4` container is deliberately a LOCAL/CI convenience (a named volume on a developer's disk, development-grade default passwords documented in `.env.example`) and is never meant to be pointed at from a production deployment. This is why [`docs/pengujian.md`](pengujian.md) describes `apps/cms`'s DB-gated test suite as something to run against a locally provisioned, disposable PostgreSQL, never against anything borneojek currently operates.

## Not built

Any Dockerfile, container image, or deployment pipeline for either `apps/cms` or `apps/storefront` in this repository — nothing under `.github/workflows/` builds or publishes a container image today (see [`docs/alur-kerja-pengembangan.md`](alur-kerja-pengembangan.md) for exactly what CI does run). A reverse-proxy/TLS-termination configuration for `apps/storefront` in production — `apps/storefront/server/penyaji.mjs` assumes one exists in front of it but does not configure or document one itself.
