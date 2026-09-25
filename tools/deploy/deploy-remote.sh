#!/usr/bin/env bash
# tools/deploy/deploy-remote.sh — issue #224.
#
# A THIN local wrapper: validates its arguments, then SSHes to the given
# host and runs the canonical server-side deploy-production.sh by a fixed
# path. No deployment logic is duplicated here — everything the transaction
# actually does lives in deploy-production.sh, on the server, per this
# issue's own requirement ("the local wrapper must only invoke the canonical
# server-side implementation over SSH; deployment logic must not be
# duplicated between laptop and server").
#
# Usage:
#   deploy-remote.sh <ssh-host> <exact-tag|40-char-sha|image@sha256:digest>
#
# <ssh-host> is anything `ssh` accepts as a destination — an entry in
# ~/.ssh/config is the recommended shape (e.g. a dedicated `deploy` user, a
# forced command; see docs/deployment.md's "Production deployment" section
# for the exact authorized_keys line). This script never carries a
# production credential itself — it only opens the SSH session an operator's
# own key/agent authenticates.
#
# Env:
#   DEPLOY_REMOTE_SCRIPT_PATH — the fixed path to deploy-production.sh on the
#                               remote host (default: this repo's own path,
#                               tools/deploy/deploy-production.sh, relative to
#                               the remote checkout's root — set this when the
#                               remote checkout root differs from this one).
set -Eeuo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

HOST="${1:-}"
TARGET="${2:-}"

if [[ -z "$HOST" || -z "$TARGET" ]]; then
  echo "usage: deploy-remote.sh <ssh-host> <exact-tag|40-char-sha|image@sha256:digest>" >&2
  exit 1
fi

if ! deploy_classify_target "$TARGET"; then
  deploy_fail "'$TARGET' is not an exact release — see deploy-production.sh's own usage for accepted forms."
fi

REMOTE_SCRIPT="${DEPLOY_REMOTE_SCRIPT_PATH:-tools/deploy/deploy-production.sh}"

deploy_log "deploy-remote: ssh $HOST -- $REMOTE_SCRIPT $TARGET"
exec "$SSH" "$HOST" -- "$REMOTE_SCRIPT" "$TARGET"
