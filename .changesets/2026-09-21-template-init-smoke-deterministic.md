---
bump: patch
type: fix
impact: internal
---

# `template-init-smoke` no longer runs the full root suite three times at once

Issue #147: two consecutive `main` runs each failed a *different* matrix
leg's final `Root bun test` step on a *different* storefront build-smoke
test's stub-start deadline — three copies of the full suite (each of which
starts its own stub CMS and runs its own `astro build`) competing for the
same two-core runner's CPU/IO, not a real profile-specific defect.

- The `toko`/`berita`/`landing` matrix legs still run the real
  `template:init` for their profile, start the stub CMS with an explicit
  PID and a deterministic `if: always()` teardown that surfaces
  `/tmp/stub-awcms.log` on failure, and build under `SITE_PROFILE`. They
  now assert the build's output with `apps/storefront/scripts/
  assert-profil-dist.ts` — a deterministic, non-rebuilding check derived
  from `apps/storefront/src/config/profil.ts` — instead of re-running a full `bun test`.
- A new `root-suite` job, with no matrix, runs `template:init --profil
  toko` and the full `bun test` exactly once, on its own runner.
- `apps/storefront/tests/profil-uji-bersama.ts` now exports `GROUP_FILES`/
  `GROUP_SITEMAP_PATHS` so `apps/storefront/tests/profil-build-smoke.test.ts` and the new
  assertion script share one definition of "this group's files" rather
  than two that could drift apart.
- No timeout was raised to mask the contention; the workflow is still not
  a required status check — promotion still waits for a run of consecutive
  green `main` runs (docs/alur-kerja-pengembangan.md).
