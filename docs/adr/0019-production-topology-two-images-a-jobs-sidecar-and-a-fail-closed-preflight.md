🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.id.md)

# ADR-0019 — Production topology: two images, a jobs sidecar, and a fail-closed preflight

- **Status:** Accepted
- **Date:** 21 September 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0002](0002-static-output-with-build-time-fetch-for-the-storefront.md) (static output — why the storefront image is not a server), [ADR-0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md) (why a shopper's browser calls `apps/cms` directly, never through a storefront backend), [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) (customer OTP — the delivery channel this preflight requires to be production-capable), [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) (provider ports — Midtrans/RajaOngkir/WhatsApp — this preflight validates), [ADR-0018](0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) (`SITE_PROFILE` — the build-time switch each storefront image is built once for); issue [#150](https://github.com/ahliweb/awcms-one/issues/150)

## Context

`docs/deployment.md` stated, until this change, that a live production deployment of this platform does not exist and that `compose.yaml` is a local/CI convenience only. That was an accurate description through increment 6: five increments built commerce/news/customer-account/integration/template breadth, and a real PostgreSQL for local dev and CI (issue #25), but nothing yet said how `apps/cms`, `apps/storefront`, PostgreSQL, and the commerce/AWCMS background jobs actually run together, as which database identities, behind which secrets, checked by which gate — the delivery gap issue #150 names directly.

Three questions had to be settled together, because each one constrains the others: (1) what runs where — does the storefront stay a static build, or does deployment pressure make it a dynamic server; (2) which database identity each moving part connects as, and how migrations are kept separate from runtime; (3) how a bad production configuration is caught before it reaches shoppers, not after.

## Decision

### D1 — `apps/cms` is the system of record; `apps/storefront` stays a static build with its own tiny server, never a dynamic backend

Production does not change the architecture ADR-0002/ADR-0007 already settled: `apps/storefront` is built once per `SITE_PROFILE` (ADR-0018) into a static artefact, and `apps/storefront/server/penyaji.mjs` (already existing, bundled by the app's own `build` script) serves that artefact and nothing else — it never gains a runtime credential, never proxies to `apps/cms`, and never re-fetches content after the build completes. All state, all writes, and every anonymous storefront call (cart, checkout, OTP, order tracking) go straight from the shopper's browser to `apps/cms`'s own anonymous `/api/v1/commerce/storefront/*` surface, exactly as ADR-0007 already decided. Production deployment pressure is a reason this ADR exists; it is deliberately not a reason to reopen ADR-0002/ADR-0007 — doing so would trade a proven, cheap-to-scale static topology for a dynamic one to solve a documentation gap, not an architectural one.

### D2 — Two build-time images, one runtime database role each, and a separate migration-owner identity

Three database identities, never conflated:

- **`awcms_setup`** (or the Postgres superuser) — the migration-owner connection. Used only by a one-shot `migrate` step/service, never by anything left running.
- **`awcms_app`** — `apps/cms`'s own runtime role (already created by upstream's `sql/019_awcms_db_role_separation.sql`). The `cms` service's `DATABASE_URL` must resolve to this role.
- **`awcms_worker`** — the background-job role (`sql/022`). The `jobs` sidecar's `DATABASE_URL` must resolve to this role.

`compose.production.yaml` encodes this as three services reading three different source variables (`SETUP_DATABASE_URL`, `DATABASE_URL`, `WORKER_DATABASE_URL`) rather than one shared `DATABASE_URL` reused with different intent — a shared variable is exactly the shape that lets an operator paste the owner DSN everywhere "to make it work" and never notice. `apps/cms/Dockerfile.production` already builds a `runtime` target (only `dist/`, no scripts, no superuser-capable tooling) and a `jobs` target (the full source, so the 30+ job scripts it ships can actually run) — this ADR reuses both, unmodified, rather than inventing a third image; `apps/cms` is an upstream subtree and this repository's own rule is additive-only inside it (AGENTS.md).

The superuser/owner role is never a runtime identity for `cms` or `jobs` — enforced mechanically by D5's preflight, not only documented.

### D3 — Scheduled jobs run from the generated crontab, never a hand-copied list, including under docker-compose

`apps/cms/scripts/jobs-crontab.ts` (upstream, `bun run jobs:crontab:generate`/`:check`) already generates `apps/cms/ops/awcms-jobs.crontab` from the module job registry — the single source of truth for which jobs exist and when they run. That file's own design is host cron calling `apps/cms/ops/run-job.sh <target>`, which in turn runs the published `awcms-jobs` image via a bare `docker run`. A docker-compose-based deployment does not need a second, hand-maintained cron list to get the same guarantee: `ops/run-job-compose.sh` (this repository's own, new, root-owned script) is a drop-in replacement for `run-job.sh` with the identical `<target> [args...]` signature, calling `docker compose -f compose.production.yaml --profile jobs run --rm jobs bun run <target>` instead of a bare `docker run`. An operator points the SAME generated crontab's `AWCMS_RUN_JOB` variable at this script instead of `apps/cms/ops/run-job.sh` — the schedule itself is still generated from the module registry, and `jobs:crontab:check` still catches drift, because nothing about WHICH jobs exist or WHEN they run changed; only WHICH container runs them did.

Rejected: a cron daemon baked into the `jobs` image (would require editing `apps/cms/Dockerfile.production`, upstream, forbidden by this repo's subtree rule) and a third-party label-driven scheduler sidecar (e.g. Ofelia) with schedules duplicated into compose labels (reintroduces exactly the hand-copied-cron-list drift risk D3 exists to close, in a new location).

### D4 — `AWCMS_API_TOKEN` reaches the storefront build only through a BuildKit build secret, never an ARG/ENV

`apps/storefront`'s build needs `apps/cms`'s owner API token to fetch catalog/news content at build time (ADR-0002), but that credential must never enter a built layer, `docker history`, or the served artefact. `apps/storefront/Dockerfile`'s single `RUN` that runs `bun run build` reads the token from a `--mount=type=secret,id=awcms_api_token` file, exporting it into that RUN's own shell environment only — it is never assigned to a Dockerfile `ARG` or `ENV`, so it cannot appear in any layer's metadata even by accident. `compose.production.yaml` sources the secret from a local, gitignored file (`.secrets/awcms_api_token` by default); `tools/deploy-preflight.mjs --dist` additionally greps a built `dist/` for the literal token value as a second, independent check.

### D5 — Preflight is fail-closed and layered: `apps/cms`'s own commerce-specific checks, then the root storefront-shape check

Two new commands, neither replacing `apps/cms`'s existing `bun run config:validate`/`bun run security:readiness` (upstream, unmodified) but sitting alongside them:

- `apps/cms/scripts/commerce-deploy-preflight.ts` (`bun run commerce:deploy:preflight`, additive commerce-module tooling) checks the production invariants specific to this platform's own topology: the runtime DB role is not the owner/superuser (DSN shape always; `--live` additionally connects and verifies `rolsuper`/`rolbypassrls`/table ownership/RLS `ENABLE+FORCE`/migration-ledger currency), customer OTP delivery is production-capable (e-mail always required — this module has no "customer accounts disabled" switch; WhatsApp only when `COMMERCE_WHATSAPP_ENABLED=true`), the payment gateway and shipping-rate provider are not `log` adapters in production and their real adapter's credentials are present, and the canonical public URLs are valid `https://`. It delegates to upstream's own `apps/cms/scripts/validate-env.ts` and to `jobs:crontab:check`/`jobs:env-allowlist:check` by spawning them (argv array, never a shell string) rather than re-implementing any of the three.
- `tools/deploy-preflight.mjs` (`bun run deploy:preflight`, root-owned, workspace-agnostic) checks the storefront build's own env shape — a valid `SITE_PROFILE`, https canonical origins, `AWCMS_API_TOKEN` present and never `PUBLIC_`-prefixed, no `PUBLIC_*` variable whose value looks like a credential — then spawns `apps/cms`'s preflight and folds its exit code in, so one command answers the whole platform's readiness.

Every check prints exactly one `PASS|FAIL|SKIP` line with a reason and never a secret value; a `SKIP` (no `--live`, no reachable database) never counts as a pass. Either script exits non-zero the moment any check is `FAIL`.

### D6 — Every external provider stays server-side; a `log`/dev adapter can never become a silent production default

Consistent with [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md)'s port/adapter shape: no payment, shipping, or WhatsApp credential is ever read by `apps/storefront` or shipped to a browser — every one of them is an `apps/cms`-only environment variable, validated by D5's preflight, never a storefront build ARG. A `log` adapter (safe for local/dev, makes no network call) is a valid **non-production** choice for payment/shipping, and preflight refuses it the moment `APP_ENV=production` (or `--production`) is asserted, so a deployment cannot drift from "log" to "believed to be live" without the preflight catching it first.

### D7 — What remains out of scope

This ADR does not build: at-rest backup encryption (tracked upstream, per `apps/cms/ops/backup-awcms.sh`'s own header — "Do NOT set `BACKUP_ENCRYPTION_KEY_FILE`"), a Xendit payment adapter or courier tracking (both named as explicit ADR-0017 follow-ups, still unbuilt), a CI pipeline that builds and publishes `apps/storefront`'s per-profile images to a registry (this ADR documents `docker build`, not a release pipeline), and a reverse-proxy/TLS-termination configuration beyond an example in `docs/deployment.md` — an operator's own ingress (nginx, Traefik, a managed load balancer) terminates TLS and forwards to the `cms`/`storefront` containers' unpublished ports.

## Consequences

- A production deployment has one documented, tested path (`docs/deployment.md`'s "Production runbook") instead of none; `compose.production.yaml` and its own test (`tests/compose-produksi.test.mjs`) make the two-role database model and the no-committed-secret rule mechanically checked, not only written down.
- `apps/cms/Dockerfile.production` and `apps/cms/ops/run-job.sh`/`awcms-jobs.crontab` needed no changes — this ADR's own D2/D3 were satisfied entirely by additive tooling (`commerce-deploy-preflight.ts`, `ops/run-job-compose.sh`), which is also proof the additive-only subtree rule did not have to be bent to reach a real production topology.
- A future provider (Xendit, a second WhatsApp adapter) or a future job extends the same preflight and the same generated crontab without a new mechanism — D5/D3 are already provider/job-count-agnostic.
- The one operational cost this ADR accepts deliberately: `ops/run-job-compose.sh` is a second entrypoint alongside upstream's own `apps/cms/ops/run-job.sh`, and an operator who mixes the two (some jobs via bare `docker run`, others via compose) could in principle run two different images for the same job. `docs/deployment.md`'s runbook states plainly that a compose-based deployment uses `run-job-compose.sh` for every job, never a mix.
