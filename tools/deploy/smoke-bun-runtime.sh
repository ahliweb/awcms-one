#!/usr/bin/env bash
# tools/deploy/smoke-bun-runtime.sh — issue #469 (ADR-0002, Bun-only).
#
# The runtime half of the Bun-only gate. `tests/bun-only-deployment-manifests.test.mjs`
# and `tests/bun-only-runtime-entrypoints.test.mjs` prove, statically, what
# PRODUCES each container's process (image tag, final stage, CMD, compose
# command). This script proves it on the image you actually built or pulled:
# it starts one throwaway container per image and asks the runtime inside it
# which runtime it is.
#
# For each `--image <role>=<reference>` it checks that
#
#   1. `bun` inside the image runs and reports `process.versions.bun` equal to
#      the `packageManager` pin of this repo's root package.json (read at run
#      time, never written here), and `process.execPath` is a `bun` binary;
#   2. for the `storefront` and `cms` roles (images that run a long-lived
#      server) the image's configured CMD starts with `bun`. The `jobs` role
#      has no server CMD (a scheduler runs `bun run <target>` in it), so only
#      check 1 applies to it.
#
# It starts nothing but `bun -e '<print version>'` and reads no secret: the only
# output it parses is a version string and a path. No network is needed once the
# images are local.
#
# Opt-in and operator-run: it needs a Docker daemon and built or pulled images,
# so it is NOT part of `bun test` or of any `local-ci/*` leg. Run it after the
# build/pull step of a deployment, or against a freshly built image:
#
#   bun run deploy:smoke-bun -- \
#     --image storefront=awcms-one/storefront:toko \
#     --image cms=awcms-one/cms:latest \
#     --image jobs=awcms-one/cms-jobs:latest
#
# Exit 0 = every named image runs Bun at the pinned version; non-zero otherwise
# (one line per failed check on stderr).
set -Eeuo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

usage() {
  echo "usage: smoke-bun-runtime.sh --image <storefront|cms|jobs>=<image-reference> [--image ...]" >&2
  exit 2
}

ROLES=()
IMAGES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)
      [[ $# -ge 2 ]] || usage
      case "$2" in
        storefront=?* | cms=?* | jobs=?*)
          ROLES+=("${2%%=*}")
          IMAGES+=("${2#*=}")
          ;;
        *) usage ;;
      esac
      shift 2
      ;;
    *) usage ;;
  esac
done
[[ ${#IMAGES[@]} -gt 0 ]] || usage

PIN="$(sed -n 's/^[[:space:]]*"packageManager":[[:space:]]*"bun@\([0-9][0-9.]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -n 1)"
if [[ -z "$PIN" ]]; then
  deploy_log "bun-smoke: no bun@x.y.z packageManager in $REPO_ROOT/package.json; refusing to guess the pin"
  exit 2
fi

FAILED="false"
fail() {
  deploy_log "bun-smoke: FAIL $*"
  FAILED="true"
}

for i in "${!IMAGES[@]}"; do
  role="${ROLES[$i]}"
  image="${IMAGES[$i]}"
  deploy_log "bun-smoke: $role ($image) expecting Bun $PIN"

  # `--entrypoint bun` bypasses the image's own entrypoint script so the probe
  # asks the runtime directly; the container is removed on exit.
  if ! probe="$("$DOCKER" run --rm --entrypoint bun "$image" -e 'console.log(process.versions.bun + " " + process.execPath)' 2>&1)"; then
    fail "$role: bun did not run inside $image"
    continue
  fi
  probe="$(printf '%s' "$probe" | tail -n 1)"
  version="${probe%% *}"
  exec_path="${probe#* }"
  if [[ "$version" != "$PIN" ]]; then
    fail "$role: image runs Bun ${version:-none}, expected $PIN"
  fi
  if [[ "$(basename "$exec_path")" != "bun" ]]; then
    fail "$role: process.execPath is '$exec_path', not a bun binary"
  fi

  case "$role" in
    storefront | cms)
      cmd="$("$DOCKER" inspect --format '{{json .Config.Cmd}}' "$image" 2>&1 || true)"
      if ! printf '%s' "$cmd" | grep -Eq '^\["(/usr/local/bin/)?bun"'; then
        fail "$role: image CMD does not start with bun ($cmd)"
      fi
      ;;
  esac
done

if [[ "$FAILED" == "true" ]]; then
  deploy_log "bun-smoke: FAIL"
  exit 1
fi

deploy_log "bun-smoke: PASS"
exit 0
