---
bump: patch
type: fix
impact: public
---

# Compose production path: scheduled jobs run under the database role their code needs

`compose.production.yaml`'s `jobs` service gives every job the `awcms_worker` DSN as `DATABASE_URL`, so the upstream job `hr-commission:intents:post` (ADR-0147, every minute) would have connected as the worker and failed each run: it calls `awcms_hr_commission_intake_non_idle_tenants()`, which only `awcms_app` may execute. The host-cron path through upstream's `ops/run-job.sh` was never affected.

- New `jobs-app` service (profile `jobs-app`, same image and `env_file` as `jobs`, `DATABASE_URL` = the app DSN `cms` already uses; no new variable). `ops/run-job-compose.sh` now routes each target from the block `targets that need DATABASE_URL` that upstream generates into `apps/cms/ops/run-job.sh`: a listed target runs in `jobs-app`, every other in `jobs`, so a worker-client job never receives the app DSN and the reverse. It fails closed (missing or garbled block, upstream's operator-only targets, a non-script-name target) and has an `AWCMS_RUN_JOB_PRINT_SERVICE=1` dry run.
- `tests/compose-produksi.test.mjs` asserts each service's role wiring, routes every generated-crontab target through the real wrapper, and pins the set of scheduled app-role targets (today only `hr-commission:intents:post`) so a future upstream sync that schedules another app-client job fails until the wiring is reviewed.
- Operator: no configuration change; the crontab still points `AWCMS_RUN_JOB` at `ops/run-job-compose.sh`. Keep the checkout and the pulled jobs image on the same release. `docs/deployment.md` (and the Indonesian mirror) list which jobs run under which role. Refs #391 (hr-commission intake still needs enabling per tenant with an intake actor before the commerce adapter is switched on).
