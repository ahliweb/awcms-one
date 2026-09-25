#!/usr/bin/env bash
# tools/deploy/deploy-production.sh — issue #224, the canonical server-side
# deployment entrypoint. See docs/adr/0022-production-deployment-is-server-side-and-explicit.md
# and docs/deployment.md's "Production deployment (server-side, explicit)"
# section for the full architecture and runbook this script implements.
#
# Usage:
#   deploy-production.sh <exact-tag|40-char-sha|image@sha256:digest>
#
# GitHub Actions never runs this script and never holds the credentials it
# needs — see the ADR above for the trust boundary. This script runs ONLY on
# the deployment/production host (or a host with the same compose project
# checked out), invoked explicitly by an operator or `deploy-remote.sh`.
#
# Env (all documented in root .env.example):
#   DEPLOY_STATE_DIR              — default /var/lib/awcms-one-deploy
#   DEPLOY_SKIP_BACKUP            — "true" to skip the pre-migration backup
#                                    step (never set this in production; it
#                                    exists for a fresh database with nothing
#                                    to back up yet)
#   DEPLOY_COSIGN_VERIFY_COMMAND  — when set, an executable this script calls
#                                    with the resolved image ref as $1 to
#                                    verify its signature (e.g.
#                                    `cosign verify --key ...`); unset skips
#                                    signature verification entirely (image
#                                    digest pinning and the attestation
#                                    verification docs/deployment.md already
#                                    documents — ADR-0020 — still apply)
#   AWCMS_ONE_CMS_IMAGE / AWCMS_ONE_CMS_JOBS_IMAGE
#                                  — same variables compose.production.yaml
#                                    already reads (ADR-0020 D4); this script
#                                    sets them itself for an `image@sha256:...`
#                                    target, deriving the jobs image name by
#                                    the compose file's own convention
#                                    (`-jobs` suffix on the repository name)
#                                    unless AWCMS_ONE_CMS_JOBS_IMAGE is given
#                                    explicitly.
set -Eeuo pipefail

# shellcheck source=./lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "usage: deploy-production.sh <exact-tag|40-char-sha|image@sha256:digest>" >&2
  exit 1
fi

if ! deploy_classify_target "$TARGET"; then
  deploy_fail "'$TARGET' is not an exact release — accepted forms are an exact tag (vX.Y.Z), a 40-character commit SHA, or an image ref pinned by digest (name@sha256:...). A branch name, short SHA, or floating tag is refused."
fi

deploy_acquire_lock

MIGRATION_RAN="false"
RESOLVED=""
PREVIOUS_RELEASE="$(deploy_read_current_release)"

deploy_log "starting deployment of '$TARGET' (kind: $DEPLOY_TARGET_KIND); previous release recorded as '${PREVIOUS_RELEASE:-<none>}'"

# --- Idempotent no-op: target already deployed and healthy -------------------
if [[ -n "$PREVIOUS_RELEASE" && "$PREVIOUS_RELEASE" == "$TARGET" ]]; then
  if "$(dirname "${BASH_SOURCE[0]}")/healthcheck-production.sh" >/tmp/awcms-one-deploy-healthcheck.$$ 2>&1; then
    deploy_log "target '$TARGET' is already the deployed release and healthcheck passes — no-op success."
    deploy_audit_append "$(printf '{"timestamp":"%s","target":"%s","kind":"%s","resolved":"%s","previous_release":"%s","operator":"%s","status":"noop-success"}' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET" "$DEPLOY_TARGET_KIND" "$RESOLVED" "$PREVIOUS_RELEASE" "$(deploy_operator)")"
    rm -f /tmp/awcms-one-deploy-healthcheck.$$
    exit 0
  fi
  rm -f /tmp/awcms-one-deploy-healthcheck.$$
  deploy_log "target '$TARGET' is already recorded as deployed but healthcheck failed — proceeding with a real deployment attempt rather than a no-op."
fi

# --- Step: fetch/verify --------------------------------------------------------
case "$DEPLOY_TARGET_KIND" in
  tag | sha)
    deploy_log "step: fetch/verify (git-based target)"
    DIRTY="$("$GIT" -C "$REPO_ROOT" status --porcelain)"
    if [[ -n "$DIRTY" ]]; then
      deploy_fail "server checkout is not clean (git status --porcelain is non-empty) — refusing to deploy on top of unknown local changes."
    fi
    "$GIT" -C "$REPO_ROOT" fetch --tags --force origin
    if ! RESOLVED_SHA="$("$GIT" -C "$REPO_ROOT" rev-parse --verify "${TARGET}^{commit}" 2>/dev/null)"; then
      deploy_fail "target '$TARGET' does not resolve to a commit — the tag/SHA must exist in this checkout after 'git fetch --tags'."
    fi
    "$GIT" -C "$REPO_ROOT" checkout --detach "$RESOLVED_SHA"
    RESOLVED="$RESOLVED_SHA"
    deploy_log "checked out $RESOLVED_SHA for target '$TARGET'"
    ;;
  image)
    deploy_log "step: fetch/verify (image target, digest-pinned) — no git mutation; the running host's own checkout is used only for compose.production.yaml and this tooling."
    DIRTY="$("$GIT" -C "$REPO_ROOT" status --porcelain)"
    if [[ -n "$DIRTY" ]]; then
      deploy_fail "server checkout is not clean (git status --porcelain is non-empty) — refusing to deploy on top of unknown local changes."
    fi
    export AWCMS_ONE_CMS_IMAGE="$TARGET"
    RESOLVED="${TARGET#*@}"
    if [[ -z "${AWCMS_ONE_CMS_JOBS_IMAGE:-}" ]]; then
      # Derive the jobs image name by the same "-jobs" suffix convention
      # docs/deployment.md's "Published images" section documents
      # (ghcr.io/<owner>/<repo>-cms -> ghcr.io/<owner>/<repo>-cms-jobs) — only
      # when the given ref's own name ends in "-cms"; otherwise an operator
      # must set AWCMS_ONE_CMS_JOBS_IMAGE explicitly.
      IMAGE_NAME="${TARGET%@sha256:*}"
      DIGEST="${TARGET#*@}"
      if [[ "$IMAGE_NAME" == *-cms ]]; then
        export AWCMS_ONE_CMS_JOBS_IMAGE="${IMAGE_NAME%-cms}-cms-jobs@${DIGEST}"
      else
        deploy_fail "AWCMS_ONE_CMS_JOBS_IMAGE must be set explicitly when the cms image ref does not end in '-cms' (given: $TARGET)."
      fi
    fi
    ;;
esac

# --- Step: preflight ------------------------------------------------------------
deploy_log "step: preflight (bun run deploy:preflight --live --production)"
if ! ( cd "$REPO_ROOT" && "$BUN" run deploy:preflight --live --production ) 2>&1 | $REDACT_LOG; then
  deploy_fail "preflight failed — see the preflight output above. No runtime mutation has occurred."
fi

# --- Step: backup readiness + pre-migration backup ------------------------------
if [[ "${DEPLOY_SKIP_BACKUP:-false}" == "true" ]]; then
  deploy_log "step: backup — DEPLOY_SKIP_BACKUP=true, skipping (never set this against a database with real data)."
else
  deploy_log "step: pre-migration backup (docker compose --profile backup run --rm backup)"
  if ! deploy_compose --profile backup run --rm backup 2>&1 | $REDACT_LOG; then
    deploy_fail "backup failed — refusing to migrate without a verified pre-migration backup. No migration has run; no runtime mutation has occurred."
  fi
fi

# --- Step: build or pull+verify --------------------------------------------------
case "$DEPLOY_TARGET_KIND" in
  tag | sha)
    deploy_log "step: build (docker compose build migrate cms jobs)"
    if ! deploy_compose --profile migrate --profile jobs build migrate cms jobs 2>&1 | $REDACT_LOG; then
      deploy_fail "image build failed. No migration has run; no runtime mutation has occurred."
    fi
    ;;
  image)
    deploy_log "step: pull (docker compose --profile migrate --profile jobs pull migrate cms jobs)"
    if ! deploy_compose --profile migrate --profile jobs pull migrate cms jobs 2>&1 | $REDACT_LOG; then
      deploy_fail "image pull failed. No migration has run; no runtime mutation has occurred."
    fi
    if [[ -n "${DEPLOY_COSIGN_VERIFY_COMMAND:-}" ]]; then
      deploy_log "step: cosign verify ($DEPLOY_COSIGN_VERIFY_COMMAND $AWCMS_ONE_CMS_IMAGE)"
      if ! "$DEPLOY_COSIGN_VERIFY_COMMAND" "$AWCMS_ONE_CMS_IMAGE" 2>&1 | $REDACT_LOG; then
        deploy_fail "cosign signature verification failed for $AWCMS_ONE_CMS_IMAGE. No migration has run; no runtime mutation has occurred."
      fi
    else
      deploy_log "DEPLOY_COSIGN_VERIFY_COMMAND is not set — skipping signature verification (digest pinning + ADR-0020 attestation verification, run separately, still apply)."
    fi
    ;;
esac

# --- Step: migrate ---------------------------------------------------------------
# The migrate step runs on EVERY deployment, so "it exited 0" says nothing
# about whether the schema changed. What decides whether an automatic code
# rollback is safe is whether a migration was actually APPLIED — read from
# apps/cms's own ledger (`awcms_schema_migrations`, apps/cms/scripts/db-migrate.ts)
# before and after. Any count that cannot be read (fresh database, postgres
# not up yet, an error) counts as "a migration ran": the conservative answer
# is the one that forbids an automatic rollback.
MIGRATIONS_BEFORE="$(deploy_applied_migration_count)"
deploy_log "step: migrate (docker compose --profile migrate run --rm migrate) — using the privileged migration/setup identity; applied migrations before: $MIGRATIONS_BEFORE"
if ! deploy_compose --profile migrate run --rm migrate 2>&1 | $REDACT_LOG; then
  deploy_fail "migration failed. No runtime mutation has occurred — 'cms'/'jobs'/'storefront' were never activated for this target."
fi
MIGRATIONS_AFTER="$(deploy_applied_migration_count)"
if [[ "$MIGRATIONS_BEFORE" != "unknown" && "$MIGRATIONS_BEFORE" == "$MIGRATIONS_AFTER" ]]; then
  MIGRATION_RAN="false"
  deploy_log "migration step succeeded; no new migration was applied ($MIGRATIONS_AFTER applied) — this release is schema-compatible with the previous one."
else
  MIGRATION_RAN="true"
  deploy_ensure_state_dir
  printf 'true' >"$DEPLOY_MIGRATION_FLAG_FILE"
  deploy_log "migration step succeeded; applied migrations $MIGRATIONS_BEFORE -> $MIGRATIONS_AFTER — automatic code rollback is disabled for this attempt."
fi

# --- Step: verify runtime DB role is least-privilege ------------------------------
deploy_log "step: verify runtime DB role (rolsuper=false AND rolbypassrls=false)"
ROLE_CHECK_OUTPUT="$(deploy_compose exec -T postgres psql -X -U "${POSTGRES_USER:?POSTGRES_USER is required, the same owner/superuser role compose.production.yaml already requires}" -d "${POSTGRES_DB:?POSTGRES_DB is required}" -tAc \
  "select rolsuper, rolbypassrls from pg_roles where rolname = 'awcms_app'" 2>&1 || true)"
deploy_log "role check raw output: $(printf '%s' "$ROLE_CHECK_OUTPUT" | tr '\n' ' ')"
NORMALIZED_ROLE_CHECK="$(printf '%s' "$ROLE_CHECK_OUTPUT" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
# The ONLY output this step accepts as a genuine answer is exactly two
# pipe-separated booleans (t|t, t|f, f|t, or f|f) — anything else (a psql
# connection error, an empty result because the role does not exist, a
# permissions error) is treated as "could not confirm least privilege" and
# fails closed. An early version of this check only looked for the FAIL
# shape (t|t) or emptiness, which let a psql ERROR MESSAGE — neither empty
# nor matching t|t — through to activation; caught by a real rehearsal
# against actual docker/postgres, not by the hermetic stub suite alone.
case "$NORMALIZED_ROLE_CHECK" in
  "f|f")
    : # least-privilege confirmed — proceed.
    ;;
  "t|t" | "t|f" | "f|t")
    deploy_fail "runtime role 'awcms_app' has rolsuper=true or rolbypassrls=true — this is a least-privilege violation and this script refuses to activate. A migration already ran; see docs/deployment.md's Production runbook DB recovery section before proceeding manually."
    ;;
  *)
    deploy_fail "could not confirm runtime role 'awcms_app' privileges from Postgres (raw output above did not resolve to an exact t-or-f pair) — refusing to activate without confirming least privilege. A migration already ran; see docs/deployment.md's DB recovery section."
    ;;
esac

# --- Step: activate ---------------------------------------------------------------
deploy_log "step: activate (docker compose up -d cms storefront)"
if ! deploy_compose up -d cms storefront 2>&1 | $REDACT_LOG; then
  deploy_log "activation failed after a migration already ran — this script does NOT auto-roll back code when a migration ran; consult docs/deployment.md's 'Production runbook' DB recovery section."
  deploy_audit_append "$(printf '{"timestamp":"%s","target":"%s","kind":"%s","resolved":"%s","previous_release":"%s","operator":"%s","migration_ran":%s,"status":"activation-failed"}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET" "$DEPLOY_TARGET_KIND" "$RESOLVED" "$PREVIOUS_RELEASE" "$(deploy_operator)" "$MIGRATION_RAN")"
  exit 1
fi

# --- Step: health -------------------------------------------------------------------
deploy_log "step: health ($(dirname "${BASH_SOURCE[0]}")/healthcheck-production.sh)"
if ! "$(dirname "${BASH_SOURCE[0]}")/healthcheck-production.sh"; then
  deploy_log "healthcheck failed after activation."
  if [[ "$MIGRATION_RAN" == "true" ]]; then
    deploy_log "a migration ran during this deployment attempt — this script does NOT auto-roll back code; a schema-incompatible rollback could corrupt data. See docs/deployment.md's 'Production runbook' DB recovery runbook."
    deploy_audit_append "$(printf '{"timestamp":"%s","target":"%s","kind":"%s","resolved":"%s","previous_release":"%s","operator":"%s","migration_ran":%s,"status":"health-failed-no-auto-rollback"}' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET" "$DEPLOY_TARGET_KIND" "$RESOLVED" "$PREVIOUS_RELEASE" "$(deploy_operator)" "$MIGRATION_RAN")"
    exit 1
  fi
  if [[ -n "$PREVIOUS_RELEASE" ]]; then
    deploy_log "no migration ran this attempt — rolling back to previous release '$PREVIOUS_RELEASE'."
    if "$(dirname "${BASH_SOURCE[0]}")/rollback-production.sh" "$PREVIOUS_RELEASE"; then
      deploy_audit_append "$(printf '{"timestamp":"%s","target":"%s","kind":"%s","resolved":"%s","previous_release":"%s","operator":"%s","migration_ran":%s,"status":"health-failed-rolled-back"}' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET" "$DEPLOY_TARGET_KIND" "$RESOLVED" "$PREVIOUS_RELEASE" "$(deploy_operator)" "$MIGRATION_RAN")"
      exit 1
    fi
  fi
  deploy_audit_append "$(printf '{"timestamp":"%s","target":"%s","kind":"%s","resolved":"%s","previous_release":"%s","operator":"%s","migration_ran":%s,"status":"health-failed"}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET" "$DEPLOY_TARGET_KIND" "$RESOLVED" "$PREVIOUS_RELEASE" "$(deploy_operator)" "$MIGRATION_RAN")"
  exit 1
fi

# --- Step: smoke ---------------------------------------------------------------------
deploy_log "step: smoke (GET /api/v1/health, GET /healthz)"
SMOKE_OK="true"
if ! "$CURL" -fsS "${DEPLOY_SMOKE_CMS_URL:-http://localhost:4321/api/v1/health}" >/dev/null 2>&1; then
  SMOKE_OK="false"
fi
if ! "$CURL" -fsS "${DEPLOY_SMOKE_STOREFRONT_URL:-http://localhost:8080/healthz}" >/dev/null 2>&1; then
  SMOKE_OK="false"
fi
if [[ "$SMOKE_OK" != "true" ]]; then
  deploy_log "smoke test failed after activation and healthcheck passed — recording failure without further mutation (healthcheck already passed, so the containers ARE up; a smoke-only failure needs operator judgement, not an automatic rollback)."
  deploy_audit_append "$(printf '{"timestamp":"%s","target":"%s","kind":"%s","resolved":"%s","previous_release":"%s","operator":"%s","migration_ran":%s,"status":"smoke-failed"}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET" "$DEPLOY_TARGET_KIND" "$RESOLVED" "$PREVIOUS_RELEASE" "$(deploy_operator)" "$MIGRATION_RAN")"
  exit 1
fi

# --- Step: record + success -----------------------------------------------------------
deploy_write_current_release "$TARGET"
rm -f "$DEPLOY_MIGRATION_FLAG_FILE"
deploy_audit_append "$(printf '{"timestamp":"%s","target":"%s","kind":"%s","resolved":"%s","previous_release":"%s","operator":"%s","migration_ran":%s,"status":"success"}' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET" "$DEPLOY_TARGET_KIND" "$RESOLVED" "$PREVIOUS_RELEASE" "$(deploy_operator)" "$MIGRATION_RAN")"
deploy_log "deployment of '$TARGET' succeeded."
