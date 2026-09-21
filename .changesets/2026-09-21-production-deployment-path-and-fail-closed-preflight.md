---
bump: minor
type: structure
impact: public
---

# A real production deployment path, and a fail-closed preflight

Issue #150 closed the gap between "a broad, tested feature set" and "a
reproducible way to run it in production": `docs/deployment.md` used to state
plainly that no production PostgreSQL deployment exists and that
`compose.yaml` is a local/CI convenience only. That is no longer the whole
story.

- **`compose.production.yaml`** — `postgres` (no host port published by
  default), a one-shot `migrate` service (the only one using the privileged
  owner/setup DSN), `cms` (the `awcms_app` runtime role), `jobs` (the
  `awcms_worker` role, gated behind a profile, invoked on a schedule rather
  than left running), and `storefront` (built with a BuildKit secret — see
  below). `tests/compose-produksi.test.mjs` mechanically checks the file for
  a hardcoded-looking secret, the role split, and the absent host ports.
- **`apps/storefront/Dockerfile`** — a new multi-stage build. `AWCMS_API_TOKEN`
  reaches the build ONLY through a BuildKit `--mount=type=secret`, never an
  ARG/ENV, so it can never enter an image layer.
- **`apps/cms/scripts/commerce-deploy-preflight.ts`** (`bun run
  commerce:deploy:preflight`, additive commerce-module tooling) and
  **`tools/deploy-preflight.mjs`** (`bun run deploy:preflight`, root) —
  fail-closed checks: the runtime DB role is never the owner/superuser
  (`--live` verifies this for real against a database), customer OTP
  delivery is production-capable, payment/shipping/WhatsApp adapters cannot
  silently stay on `log` in production, canonical URLs are valid https, the
  storefront build's `AWCMS_API_TOKEN` is never `PUBLIC_`-prefixed and no
  `PUBLIC_*` variable looks like a credential.
- **`ops/run-job-compose.sh`** — a drop-in replacement for
  `apps/cms/ops/run-job.sh` that runs a scheduled job through
  `compose.production.yaml` instead of a bare `docker run`, reusing the SAME
  crontab `bun run jobs:crontab:generate` already generates from the module
  registry — no hand-copied cron list.
- **[ADR-0019](../docs/adr/0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md)**
  records the topology decisions; `docs/deployment.md`'s "Production
  topology" section is the operator-facing runbook.

Not built by this change: a CI pipeline that publishes `apps/storefront`'s
per-profile images to a registry, a reverse-proxy/TLS config beyond an
example, backup encryption (tracked upstream), and a Xendit/courier-tracking
adapter (both already-named ADR-0017 follow-ups).
