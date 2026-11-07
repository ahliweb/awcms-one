---
bump: patch
type: dependency
impact: internal
---

# Upgrade third-party versions (PostgreSQL 18.6, @astrojs/check 0.9.12)

Moves the PostgreSQL pin from `postgres:18.4` to `postgres:18.6` (same major) in `compose.yaml`, `compose.production.yaml`, `docker/backup/Dockerfile`, the `local-ci/check-cms` runner and the docs that name it. Raises `@astrojs/check` to `^0.9.12` in `apps/storefront`. Bun is already `1.4.4`.

- `astro`, `@astrojs/node` and `@playwright/test` are **held**: their versions in `bun.lock` are shared with `apps/cms`, which is upstream-owned, so raising them here would change what `apps/cms` resolves. They move with the next subtree sync.
- `typescript` 7 is a major jump and is deliberately not taken (candidate only).
- `apps/cms` is untouched; its resolved dependency closure is identical before and after.
