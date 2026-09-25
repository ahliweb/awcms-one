---
bump: minor
type: content
impact: public
---

# Server-side, explicit production deployment (`tools/deploy/*.sh`, ADR-0022)

GitHub Actions could, until now, plausibly grow into the production control
plane by accident — nothing in this repository forbade a future workflow
from SSHing into production or calling a Coolify deploy API with
production credentials in its secrets, and a validated derived repository
already has exactly that shape today. This closes that gap: the ONE
canonical way to mutate production is now `tools/deploy/deploy-production.sh`
(plus its thin `deploy-remote.sh` SSH wrapper, `healthcheck-production.sh`,
and `rollback-production.sh`), invoked explicitly by an operator or agent,
never by CI.

- New root scripts: `bun run deploy:production|remote|health|rollback`.
  Fail-closed transaction (lock, exact-release resolution, clean-checkout
  check, preflight, pre-migration backup, build-or-pull, migrate, runtime
  least-privilege verification, activate, health, smoke, append-only audit
  record); a migration having run in the failed attempt blocks any automatic
  code rollback and points at the documented DB recovery runbook instead.
- New `packages/gerbang/lib/redact.mjs` + `tools/deploy/redact-log.mjs`:
  every line these scripts print, and the audit JSONL itself, is redacted
  before it reaches a terminal or disk.
- `tests/deploy-production.test.mjs` — a hermetic scenario suite; no real
  docker/git/curl/ssh/cosign is ever invoked.
- `docs/adr/0022-production-deployment-is-server-side-and-explicit.md` +
  `.id.md`; `docs/deployment.md`/`.id.md` rewritten to separate CI checks,
  artifact publication, and production deployment, with a first-time
  host-setup runbook.
- New root env vars documented in `.env.example` under "Server-side
  production deployment".
