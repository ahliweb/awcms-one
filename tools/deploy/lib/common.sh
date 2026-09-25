#!/usr/bin/env bash
# tools/deploy/lib/common.sh — issue #224.
#
# Shared shell helpers for every script in tools/deploy/ — declared ONCE here
# and sourced by deploy-production.sh, deploy-remote.sh,
# healthcheck-production.sh, and rollback-production.sh, rather than
# re-implemented per script (the same "a helper is declared once" rule
# tests/standar-skrip.test.mjs already enforces for packages/gerbang/lib/,
# applied here to this issue's own new bash surface).
#
# Not executable on its own — `source` it after `set -Eeuo pipefail` in the
# calling script.

# --- Overridable external commands -----------------------------------------
# Every external command this whole tool touches is a variable a test can
# override by exporting it before sourcing this file — no docker/git/curl/
# ssh/cosign call anywhere under tools/deploy/ is hardcoded.
DOCKER="${DOCKER:-docker}"
GIT="${GIT:-git}"
BUN="${BUN:-bun}"
CURL="${CURL:-curl}"
SSH="${SSH:-ssh}"
COSIGN="${COSIGN:-cosign}"
FLOCK="${FLOCK:-flock}"

# --- Paths -------------------------------------------------------------------
DEPLOY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$DEPLOY_LIB_DIR/.." && pwd)"
# REPO_ROOT is the git checkout deploy-production.sh operates on. It is
# normally two directories up from this file's own real location — but
# DEPLOY_REPO_ROOT overrides it, so the hermetic test suite
# (tests/deploy-production.test.mjs) can point every git/compose/state
# operation at a disposable temp directory instead of this real checkout,
# without needing a stub for path arithmetic itself.
REPO_ROOT="${DEPLOY_REPO_ROOT:-$(cd "$DEPLOY_DIR/../.." && pwd)}"

COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/compose.production.yaml}"

# Append-only audit trail + lock + "what is currently deployed" state.
# Configurable so tests point it at a disposable temp dir instead of a real
# host path.
DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-/var/lib/awcms-one-deploy}"
DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-$DEPLOY_STATE_DIR/deploy.lock}"
DEPLOY_AUDIT_LOG="${DEPLOY_AUDIT_LOG:-$DEPLOY_STATE_DIR/audit.jsonl}"
DEPLOY_CURRENT_RELEASE_FILE="${DEPLOY_CURRENT_RELEASE_FILE:-$DEPLOY_STATE_DIR/current-release}"
DEPLOY_MIGRATION_FLAG_FILE="${DEPLOY_MIGRATION_FLAG_FILE:-$DEPLOY_STATE_DIR/migration-ran-this-attempt}"

# Anchored to THIS file's own real location, never to REPO_ROOT — the test
# suite overrides REPO_ROOT to a disposable fixture directory that does not
# contain a copy of tools/deploy/redact-log.mjs, but the redactor itself must
# still be the one real copy this repository ships.
REDACT_LOG="$BUN $DEPLOY_DIR/redact-log.mjs"

# --- Logging -----------------------------------------------------------------
# Every line this tool prints goes through the SAME redaction the audit log
# uses (issue #205's own rule, applied here) — never a second, ad hoc
# "just don't print secrets" convention per script.
deploy_log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | $REDACT_LOG
}

deploy_fail() {
  deploy_log "FAIL: $*" >&2
  exit 1
}

# --- State dir bootstrap ------------------------------------------------------
deploy_ensure_state_dir() {
  mkdir -p "$DEPLOY_STATE_DIR"
  chmod 700 "$DEPLOY_STATE_DIR" 2>/dev/null || true
}

# --- Locking -----------------------------------------------------------------
# Non-blocking flock over a fixed fd. A concurrent deploy attempt exits
# non-zero immediately with a clear message rather than queueing — a queued
# second deploy of a DIFFERENT target is exactly the ambiguity this issue's
# "exact release" requirement exists to prevent.
DEPLOY_LOCK_FD=200

deploy_acquire_lock() {
  deploy_ensure_state_dir
  eval "exec $DEPLOY_LOCK_FD>\"$DEPLOY_LOCK_FILE\""
  if ! "$FLOCK" -n "$DEPLOY_LOCK_FD"; then
    deploy_fail "another deployment is already running (lock held at $DEPLOY_LOCK_FILE) — refusing to start a concurrent deploy."
  fi
}

# --- Target validation --------------------------------------------------------
# Accepted: an exact semver tag (v1.2.3), a 40-character commit SHA, or an
# image ref pinned by digest (name@sha256:<64 hex>). Everything else —
# branch names, short SHAs, a tag not shaped like a release, an image ref
# with no digest — is a MOVING target and rejected outright.
DEPLOY_TARGET_KIND="" # set by deploy_classify_target: "tag" | "sha" | "image"

deploy_classify_target() {
  local target="$1"
  if [[ "$target" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    DEPLOY_TARGET_KIND="tag"
    return 0
  fi
  if [[ "$target" =~ ^[0-9a-f]{40}$ ]]; then
    DEPLOY_TARGET_KIND="sha"
    return 0
  fi
  if [[ "$target" =~ ^[a-zA-Z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
    DEPLOY_TARGET_KIND="image"
    return 0
  fi
  return 1
}

# --- Audit record --------------------------------------------------------------
# One JSON line per terminal event, appended, never rewritten. Every field is
# redacted before being written — defence in depth on top of never PUTTING a
# secret into a field in the first place.
deploy_audit_append() {
  deploy_ensure_state_dir
  # $1 is a single-line JSON object built by the caller with printf — kept
  # as one argument so this function never re-serialises or re-escapes it.
  printf '%s\n' "$1" | $REDACT_LOG >>"$DEPLOY_AUDIT_LOG"
}

deploy_operator() {
  echo "${SUDO_USER:-${USER:-${LOGNAME:-unknown}}}"
}

# --- Current/previous release bookkeeping --------------------------------------
deploy_read_current_release() {
  if [[ -f "$DEPLOY_CURRENT_RELEASE_FILE" ]]; then
    cat "$DEPLOY_CURRENT_RELEASE_FILE"
  else
    echo ""
  fi
}

deploy_write_current_release() {
  deploy_ensure_state_dir
  printf '%s' "$1" >"$DEPLOY_CURRENT_RELEASE_FILE"
}

# --- Compose helper ------------------------------------------------------------
deploy_compose() {
  "$DOCKER" compose -f "$COMPOSE_FILE" "$@"
}

# Prints the number of rows in apps/cms's migration ledger
# (`awcms_schema_migrations`), or `unknown` when it cannot be read — a fresh
# database with no ledger yet, postgres not running, or any error. Callers
# treat `unknown` as "a migration may have run".
deploy_applied_migration_count() {
  local out
  if [[ -z "${POSTGRES_USER:-}" || -z "${POSTGRES_DB:-}" ]]; then
    printf 'unknown'
    return 0
  fi
  out="$(deploy_compose exec -T postgres psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
    "select count(*) from awcms_schema_migrations" 2>/dev/null || true)"
  out="$(printf '%s' "$out" | tr -d '[:space:]')"
  if [[ "$out" =~ ^[0-9]+$ ]]; then
    printf '%s' "$out"
  else
    printf 'unknown'
  fi
}
