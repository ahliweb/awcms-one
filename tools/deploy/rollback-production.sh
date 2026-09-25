#!/usr/bin/env bash
# tools/deploy/rollback-production.sh — issue #224.
#
# Rolls the RUNTIME (never the schema — see the warning below) back to a
# previous release. Defaults to the release recorded as "previous" by the
# last deploy-production.sh run.
#
# Usage: rollback-production.sh [<previous-release>]
#
# Rollback here means: re-activate the given release's already-built/pulled
# images and restart cms/storefront. It is deliberately NOT a migration
# rollback — this script never reverses a schema change. A deploy attempt
# that already ran a migration before failing is refused by
# deploy-production.sh's own logic before this script is ever invoked
# automatically; a manual, schema-incompatible rollback must follow
# docs/deployment.md's "Production runbook" DB recovery runbook instead of
# this script.
set -Eeuo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

TARGET="${1:-$(deploy_read_current_release)}"

if [[ -z "$TARGET" ]]; then
  deploy_fail "no target given and no previous release is recorded in $DEPLOY_CURRENT_RELEASE_FILE — nothing to roll back to."
fi

if ! deploy_classify_target "$TARGET"; then
  deploy_fail "'$TARGET' is not an exact release — see deploy-production.sh's own usage for accepted forms."
fi

if [[ -f "$DEPLOY_MIGRATION_FLAG_FILE" ]] && [[ "$(cat "$DEPLOY_MIGRATION_FLAG_FILE" 2>/dev/null)" == "true" ]]; then
  deploy_fail "a migration ran during the deployment attempt this rollback would undo — refusing an automatic code rollback against a schema that may no longer match. See docs/deployment.md's 'Production runbook' DB recovery runbook."
fi

deploy_log "rolling back runtime to '$TARGET'"

case "$DEPLOY_TARGET_KIND" in
  tag | sha)
    DIRTY="$("$GIT" -C "$REPO_ROOT" status --porcelain)"
    if [[ -n "$DIRTY" ]]; then
      deploy_fail "server checkout is not clean — refusing to roll back on top of unknown local changes."
    fi
    RESOLVED_SHA="$("$GIT" -C "$REPO_ROOT" rev-parse --verify "${TARGET}^{commit}")"
    "$GIT" -C "$REPO_ROOT" checkout --detach "$RESOLVED_SHA"
    if ! deploy_compose build cms storefront 2>&1 | $REDACT_LOG; then
      deploy_fail "rollback build failed."
    fi
    ;;
  image)
    export AWCMS_ONE_CMS_IMAGE="$TARGET"
    if ! deploy_compose pull cms 2>&1 | $REDACT_LOG; then
      deploy_fail "rollback pull failed."
    fi
    ;;
esac

if ! deploy_compose up -d cms storefront 2>&1 | $REDACT_LOG; then
  deploy_fail "rollback activation failed."
fi

if ! "$(dirname "${BASH_SOURCE[0]}")/healthcheck-production.sh"; then
  deploy_fail "rollback activated '$TARGET' but the healthcheck still fails — manual intervention required."
fi

deploy_write_current_release "$TARGET"
deploy_audit_append "$(printf '{"timestamp":"%s","target":"%s","kind":"%s","operator":"%s","status":"rollback-success"}' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET" "$DEPLOY_TARGET_KIND" "$(deploy_operator)")"
deploy_log "rollback to '$TARGET' succeeded."
