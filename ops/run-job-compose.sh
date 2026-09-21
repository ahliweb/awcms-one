#!/usr/bin/env bash
# ops/run-job-compose.sh — issue #150 / ADR-0019 D3.
#
# The `compose.production.yaml` equivalent of `apps/cms/ops/run-job.sh`
# (upstream, never edited here). That script's whole design is host cron +
# `docker run` against a published `awcms-jobs` image; this wrapper keeps
# EXACTLY the same shape but runs the job through this repo's own
# `compose.production.yaml`'s `jobs` service instead of a bare `docker run`,
# so an operator who chose docker-compose as their orchestrator does not need
# a second, hand-copied image/registry pipeline just to run a job.
#
# `apps/cms/scripts/jobs-crontab.ts` generates `ops/awcms-jobs.crontab`
# (apps/cms's own artefact) from the module registry — the single source of
# truth for WHICH jobs exist and WHEN they run. That generated file's
# `AWCMS_RUN_JOB` variable is meant to point at a script with the exact
# signature `run-job.sh <bun-run-target> [args...]`; point it at this script
# instead of `apps/cms/ops/run-job.sh` when compose is the chosen runtime —
# nothing about the generated schedule itself changes, so there is still
# exactly one generated source of truth and no hand-copied cron list.
#
# Usage (from a host crontab, after `crontab ops/awcms-jobs.crontab` with
# AWCMS_RUN_JOB pointed here):
#   run-job-compose.sh <bun-run-target> [extra args...]
#   run-job-compose.sh commerce:whatsapp:dispatch --dry-run
#
# Env:
#   COMPOSE_FILE            — defaults to compose.production.yaml, relative
#                             to this script's own directory's parent.
#   COMPOSE_PROJECT_NAME    — passed through if set; otherwise compose's own
#                             default (the directory name) applies.
set -euo pipefail

JOB="${1:?usage: run-job-compose.sh <bun-run-target> [args...]   e.g. run-job-compose.sh commerce:whatsapp:dispatch --dry-run}"
shift

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/compose.production.yaml}"

exec docker compose -f "$COMPOSE_FILE" --profile jobs run --rm jobs bun run "$JOB" "$@"
