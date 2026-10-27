---
bump: patch
type: structure
impact: internal
---

# Root deployment manifests are gated to Bun-only (#469)

The root compose files, Dockerfiles, `ops/` and `tools/deploy/` scripts were
checked by nothing but convention. A `node`, `npm` or `npx` launch, or a Bun
image that drifted from the `packageManager` pin, would have passed every gate
and reached production. `tests/bun-only-deployment-manifests.test.mjs` now
discovers each of those manifests and fails on a Node-ecosystem launcher, on an
`oven/bun` pin that differs from `packageManager` (read at run time, never
hard-coded), and on a Dockerfile whose final stage is not that pinned image.

- Explicit exemptions (the bash-only backup runner, the PostgreSQL service) each
  carry their reason and fail the gate if they go stale.
- `apps/cms` stays with its upstream gate, `apps/cms/tests/bun-only-launch-manifests.test.ts`.
