---
bump: minor
type: structure
impact: internal
---

# Local PostgreSQL via docker compose, seed the BjekMart tenant, CI job for check:cms

Increment 2 needed a real PostgreSQL somewhere before `apps/cms` could migrate, run, or be seeded at all — issue #1's epic explicitly deferred it past increment 1's no-database foundation. This closes that gap for local development and CI, without touching production provisioning (still not done — see `docs/deployment.md`).

- `compose.yaml` + `docker/postgres-init/` — a disposable `postgres:18.4`, project `awcms-one`, host port 5433. Creates ONLY the `LOGIN` half of the three roles `apps/cms`'s own migrations (`sql/019`, `sql/022`) already create `NOLOGIN` and passwordless on purpose; every `GRANT` stays the migrations' job.
- `bun run db:up` / `db:down` / `db:reset` — new root scripts.
- `tools/seed-borneojek-mart.ts` (`bun run db:seed:cms`) — an idempotent HTTP client of `apps/cms`'s own `/api/v1/*` surface (never a direct import of its internals, since that module is mid-flight on another branch). Bootstraps the `borneojek-mart` tenant + owner, the 8-category catalog, one representative product per commerce `type`, a handful of blog terms/pages/posts, the site profile, and a read-only machine credential scoped to `commerce.products.read`/`commerce.categories.read` — the same shape `apps/storefront`'s build token needs. `tools/seed-data/*.json` separates each resource's `current` (what the API accepts today) from `future` (images, variants, `service_form`, `subscription_period`, tiers — issue #23's fields), so landing those is a data change, not a script restructure. `tools/seed-assets/` carries small, self-generated SVG placeholders for the extension point — no downloads from the live site.
- `.github/workflows/ci.yml` — new `check-cms` job (`needs: check`, `timeout-minutes: 20`): `apps/cms`'s own full `bun run check` against `DATABASE_URL=""`, then migrate + `bun test tests/integration/` against a real `postgres:18.4` service, with a job-summary line recording the DB-gated skip count before and after. Not yet a required status on `main` — `docs/alur-kerja-pengembangan.md` records the exact `gh api` command and the "green twice in a row" condition for a maintainer to run it.
- `docs/deployment.md` — the full local sequence, in order, with real values; what the seed script deliberately does not seed (legacy shipping/payment/customer-level settings with no API surface today) and why.
- `docs/alur-kerja-pengembangan.md` — the CI section now describes both jobs.
- Root `.env.example` — every new variable (`POSTGRES_*`, `AWCMS_*_PASSWORD`, `AWCMS_BASE_URL`, `SEED_*`), each with the consequence of leaving it unset.
