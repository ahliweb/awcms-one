---
bump: minor
type: content
impact: public
---

# Encrypted backup assurance and restore drills, integrated into the production topology

`compose.production.yaml` gains three profile-gated services — `backup`, `restore-drill`, `offsite-copy` — that reuse upstream `apps/cms/deploy/backup/*.sh` (issue #210, ADR-0123) through this repository's own distinct `awcms_setup`/`awcms_app`/`awcms_worker` identities, rather than forking or reimplementing that tooling. `docker/backup/Dockerfile` supplies only the binaries (`age`, `rsync`, `openssh-client`) those scripts' own README already says a runner image needs, on top of the same `postgres:18.4` the `postgres` service runs. `ops/run-backup-compose.sh` and `ops/awcms-one-backup.crontab` give the host-cron scheduling path.

- Backups are `age`-encrypted with an HMAC-SHA256-authenticated manifest; a local-only backup is never reported as a successful off-site copy.
- `restore-drill` has a hard-coded command with no `--target` code path anywhere in it — structurally incapable of targeting a production database, not merely documented as a drill. A real disaster-recovery restore stays a manual, confirmed runbook step, never a compose service.
- Validated end to end against a disposable PostgreSQL with synthetic data: create → backup → encrypt → manifest → off-site copy (a disposable SSH test target) → restore-drill into an isolated scratch database → schema/RLS integrity verification → measured RTO/RPO, plus five fail-closed paths (wrong/missing key material, tampered manifest, corrupted backup, unavailable off-site destination, unsafe restore target).
- `docs/deployment.md`'s new "Backup assurance" section (and its Indonesian mirror) is the operator runbook; `docs/status.md` removes its "at-rest backup encryption" gap now that the capability is documented and validated.
