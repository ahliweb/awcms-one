#!/usr/bin/env bash
# tools/deploy/healthcheck-production.sh — issue #224.
#
# Checks that the currently-running production containers report healthy —
# both `docker compose`'s own container healthcheck status (compose.production.yaml's
# `cms`/`storefront` services each define one) and the two liveness endpoints
# directly, so this script gives a useful answer even against a compose
# project started without `--wait`.
#
# Usage: healthcheck-production.sh
# Exit 0 = healthy, non-zero = not healthy (see stderr for which check failed).
set -Eeuo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

FAILED="false"

deploy_log "healthcheck: docker compose ps --format json (cms, storefront)"
PS_OUTPUT="$(deploy_compose ps --format json cms storefront 2>&1 || true)"
deploy_log "healthcheck: compose ps output: $(printf '%s' "$PS_OUTPUT" | tr '\n' ' ')"
if printf '%s' "$PS_OUTPUT" | grep -qi 'unhealthy'; then
  deploy_log "healthcheck: at least one service reports 'unhealthy' via docker compose ps."
  FAILED="true"
fi

deploy_log "healthcheck: GET ${DEPLOY_SMOKE_CMS_URL:-http://localhost:4321/api/v1/health}"
if ! "$CURL" -fsS "${DEPLOY_SMOKE_CMS_URL:-http://localhost:4321/api/v1/health}" >/dev/null 2>&1; then
  deploy_log "healthcheck: cms liveness endpoint did not respond 2xx."
  FAILED="true"
fi

deploy_log "healthcheck: GET ${DEPLOY_SMOKE_STOREFRONT_URL:-http://localhost:8080/healthz}"
if ! "$CURL" -fsS "${DEPLOY_SMOKE_STOREFRONT_URL:-http://localhost:8080/healthz}" >/dev/null 2>&1; then
  deploy_log "healthcheck: storefront liveness endpoint did not respond 2xx."
  FAILED="true"
fi

if [[ "$FAILED" == "true" ]]; then
  deploy_log "healthcheck: FAIL"
  exit 1
fi

deploy_log "healthcheck: PASS"
exit 0
