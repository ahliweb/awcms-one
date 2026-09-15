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

## PostgreSQL provisioning for increment 2 is not done

`apps/cms` is PostgreSQL-only. **borneojek's production server runs MySQL** — the very database this platform's catalog schema is being re-expressed from (see [`docs/kamus-data.md`](kamus-data.md)) — so a PostgreSQL instance has to be provisioned on that infrastructure, or elsewhere, before `apps/cms` can be deployed against a real database at all. Nothing in this repository provisions, migrates, or seeds that instance today; `bun run db:migrate:cms` is a script that exists and is documented, not a step that has been run against production data. This is why [`docs/pengujian.md`](pengujian.md) describes `apps/cms`'s DB-gated test suite as something to run against a locally provisioned, disposable PostgreSQL, never against anything borneojek currently operates.

## Not built

Any Dockerfile, container image, or deployment pipeline for either `apps/cms` or `apps/storefront` in this repository — nothing under `.github/workflows/` builds or publishes a container image today (see [`docs/alur-kerja-pengembangan.md`](alur-kerja-pengembangan.md) for exactly what CI does run). A reverse-proxy/TLS-termination configuration for `apps/storefront` in production — `apps/storefront/server/penyaji.mjs` assumes one exists in front of it but does not configure or document one itself.
