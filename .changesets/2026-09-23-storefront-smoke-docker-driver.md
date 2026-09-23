---
bump: patch
type: structure
impact: internal
---

# Fix the storefront Dockerfile smoke job's unreachable stub CMS

`.github/workflows/images.yml`'s `storefront-smoke` job has never passed:
`astro build` inside `apps/storefront/Dockerfile` failed prerendering with
`awcms could not be reached at http://localhost:4310`. The job's
`docker/setup-buildx-action` step defaulted to the `docker-container`
driver, which runs BuildKit inside its own container with its own network
namespace — so `--network host` in the build step meant that container's
host namespace, not the runner's, and the stub CMS started on the runner
(`apps/storefront/scripts/stub-awcms.mjs`) was unreachable from inside the
build.

- `storefront-smoke` now passes `driver: docker` to `setup-buildx-action`,
  so the build runs in the runner's own dockerd, where `--network host` is
  the runner's real network namespace.
- `cms-images` is deliberately left on the default `docker-container`
  driver — it pushes to a registry and uses `cache-to: type=gha`, both of
  which need BuildKit features the classic `docker` driver does not
  support.
