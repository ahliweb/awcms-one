#!/usr/bin/env bash
# ops/run-backup-compose.sh — issue #213.
#
# The `ops/run-job-compose.sh` shape (issue #150) applied to the three
# backup-assurance profiles `compose.production.yaml` defines —
# `backup`/`restore-drill`/`offsite-copy` — none of which are AWCMS module
# jobs (they wrap apps/cms/deploy/backup/*.sh, upstream tooling, never
# forked here — see that file's own header comments and
# docs/deployment.md's "Backup assurance" section). A thin wrapper around
# `docker compose ... run --rm <task>`, so a host crontab has one stable
# command to call regardless of which of the three tasks it is scheduling.
#
# Usage (from a host crontab — see ops/awcms-one-backup.crontab):
#   run-backup-compose.sh <backup|restore-drill|offsite-copy>
#
# Exit code is exactly the wrapped service's own exit code — 0 only if that
# task genuinely succeeded. `restore-drill` in particular is safe to run
# unattended: `compose.production.yaml`'s own `restore-drill` service has a
# HARD-CODED command (`restore-drill.sh`, never `restore-postgres.sh
# --target=...`) — there is no argument this wrapper or a crontab could pass
# that would make it destructive.
#
# Env:
#   COMPOSE_FILE            — defaults to compose.production.yaml, relative
#                             to this script's own directory's parent.
#   COMPOSE_PROJECT_NAME    — passed through if set; otherwise compose's own
#                             default (the directory name) applies.
set -euo pipefail

TASK="${1:?usage: run-backup-compose.sh <backup|restore-drill|offsite-copy>}"

case "$TASK" in
  backup | restore-drill | offsite-copy) ;;
  *)
    echo "run-backup-compose: unknown task '$TASK' — must be backup, restore-drill, or offsite-copy" >&2
    exit 1
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/compose.production.yaml}"

exec docker compose -f "$COMPOSE_FILE" --profile "$TASK" run --rm "$TASK"
