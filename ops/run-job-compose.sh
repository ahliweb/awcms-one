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
# Which database role a job runs as (issue #391 unblock):
#   The `jobs` compose service holds the WORKER DSN as DATABASE_URL; the
#   `jobs-app` service holds the APP DSN. Upstream's own runner decides this
#   per target (a worker-client job has DATABASE_URL withheld; a job whose
#   import closure reaches the app client keeps it) and publishes that
#   decision as a GENERATED block in `apps/cms/ops/run-job.sh`
#   ("targets that need DATABASE_URL", from appConnectionTargets()). This
#   wrapper reads THAT block at run time — no hand-copied list — and routes
#   the target to `jobs-app` only when it is listed; everything else stays on
#   `jobs`. It fails closed: a missing/garbled block, or a target upstream
#   marks operator-only, refuses to run rather than guessing a role.
#   `tests/compose-produksi.test.mjs` holds the file's shape and every
#   generated-crontab target's routing to this contract.
#
# Env:
#   COMPOSE_FILE            — defaults to compose.production.yaml, relative
#                             to this script's own directory's parent.
#   COMPOSE_PROJECT_NAME    — passed through if set; otherwise compose's own
#                             default (the directory name) applies.
#   AWCMS_UPSTREAM_RUN_JOB  — path of upstream's run-job.sh to read the
#                             classification from (default
#                             apps/cms/ops/run-job.sh; tests only).
#   AWCMS_RUN_JOB_PRINT_SERVICE=1 — print the chosen compose service name
#                             and exit without calling docker (tests/ops).
set -euo pipefail

JOB="${1:?usage: run-job-compose.sh <bun-run-target> [args...]   e.g. run-job-compose.sh commerce:whatsapp:dispatch --dry-run}"
shift

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/compose.production.yaml}"
UPSTREAM="${AWCMS_UPSTREAM_RUN_JOB:-$REPO_ROOT/apps/cms/ops/run-job.sh}"

log() { echo "$(date -Is) run-job-compose.sh: $*" >&2; }

# Same rule as upstream: a package script NAME, never a path or an option.
case "$JOB" in
  -* | *[!A-Za-z0-9:_-]*)
    log "job target must be a package script name (letters, digits, ':', '-', '_'); refusing"
    exit 1
    ;;
esac

# The patterns of the first `case` arm between upstream's generated markers.
# Prints one target per line; exit 1 when the markers or the arm are absent.
generated_targets() {
  local begin="$1" end="$2"
  awk -v b="BEGIN GENERATED: $begin" -v e="END GENERATED: $end" '
    index($0, b) { inside = 1; next }
    index($0, e) { inside = 0; next }
    inside && /^[[:space:]]+[A-Za-z0-9:_| -]+\)[[:space:]]*$/ && !done {
      line = $0
      sub(/^[[:space:]]+/, "", line); sub(/\)[[:space:]]*$/, "", line)
      n = split(line, parts, /[[:space:]]*\|[[:space:]]*/)
      for (i = 1; i <= n; i++) if (parts[i] != "") print parts[i]
      done = 1
    }
    END { exit (done ? 0 : 1) }
  ' "$UPSTREAM"
}

if [ ! -r "$UPSTREAM" ]; then
  log "upstream classification $UPSTREAM is not readable — refusing to run $JOB"
  exit 1
fi

if ! OPERATOR_ONLY=$(generated_targets "operator-only targets" "operator-only targets"); then
  log "no operator-only block in $UPSTREAM — refusing to run $JOB (regenerate: bun run jobs:env-allowlist:generate in apps/cms)"
  exit 1
fi
if ! APP_TARGETS=$(generated_targets "targets that need DATABASE_URL" "targets that need DATABASE_URL"); then
  log "no 'targets that need DATABASE_URL' block in $UPSTREAM — refusing to run $JOB rather than guess a database role"
  exit 1
fi

if printf '%s\n' "$OPERATOR_ONLY" | grep -Fxq -- "$JOB"; then
  log "$JOB is an operator-only command and does not run in a job container; refusing"
  exit 1
fi

if printf '%s\n' "$APP_TARGETS" | grep -Fxq -- "$JOB"; then
  SERVICE="jobs-app"   # awcms_app: this target opens the app connection
else
  SERVICE="jobs"       # awcms_worker: upstream never gives it the app credential
fi

if [ "${AWCMS_RUN_JOB_PRINT_SERVICE:-}" = "1" ]; then
  echo "$SERVICE"
  exit 0
fi

log "$JOB -> compose service $SERVICE"
exec docker compose -f "$COMPOSE_FILE" --profile "$SERVICE" run --rm "$SERVICE" bun run "$JOB" "$@"
