---
bump: patch
type: structure
impact: internal
---

# The Bun-only gate now covers scripts, the storefront profiles and the queue workers (#469 residuals)

The first #469 gate (`tests/bun-only-deployment-manifests.test.mjs`) covered the root compose files, Dockerfiles and `ops/` scripts and said "Refs", not "Closes", because four things were left out. They are covered now, and a runtime probe exists for the part a static test cannot reach.

- `tests/bun-only-runtime-entrypoints.test.mjs` gates the `package.json` scripts of the root, `apps/storefront` and every `packages/*`: each command is `bun`, `cd`, `bash <file>` or `docker`; a bare package bin only runs as `bun --bun <bin>` (otherwise its node shebang starts Node); `bun run <name>` names a script that exists; no workspace selects Node through `engines.node`, `volta` or a Node `bin`.
- The same file gates the storefront build and serve path for all three `SITE_PROFILE` values: the `serve` script, the `--target=bun` server bundle, every `apps/storefront/Dockerfile` stage on the pinned `oven/bun` image (its `ARG BUN_VERSION` default must equal the root `packageManager` pin), the `SITE_PROFILE` build under `bun run build`, and a CMD equal to the `serve` script.
- The WhatsApp, Mailketing e-mail and Web Push queue workers (plus the commerce, Telegram and domain-event dispatchers) are checked as this repo deploys them: the `apps/cms` script and entry file, the generated crontab line, the `ops/run-job-compose.sh` routing, and the compose `jobs`/`jobs-app`/`migrate` services that build the `jobs` stage of `apps/cms/Dockerfile.production` down to the pinned `oven/bun` image. `apps/cms` is only read, never edited.
- The pure scanners moved to `tests/support/bun-only-scan.mjs` so both gates share one set; `tests/bun-only-deployment-manifests.test.mjs` is otherwise unchanged.
- `bun run deploy:smoke-bun` (`tools/deploy/smoke-bun-runtime.sh`) is an opt-in operator probe: it starts one throwaway container per image and asserts `process.versions.bun` equals the pin and the CMD of the server images starts with `bun`. It needs a Docker daemon and built or pulled images, so it is in no `local-ci/*` leg; `tests/deploy-smoke-bun-runtime.test.mjs` drives its logic against a stub `docker`.
