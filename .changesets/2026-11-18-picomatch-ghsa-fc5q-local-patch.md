---
bump: patch
type: dependency
impact: internal
---

# Mitigate picomatch GHSA-fc5q-39xc-vjpf with a local patch

picomatch `<=4.0.7` has a high-severity ReDoS through repeated extglobs (`GHSA-fc5q-39xc-vjpf`) and **no patched release exists** (upstream fixes are unmerged PRs). It reddened `local-ci/check-toko` and `local-ci/security` for every PR.

- `patches/picomatch@4.0.7.patch` and `patches/picomatch@2.3.2.patch` (root `patchedDependencies`) force `opts.noextglob = true`, so extglob syntax (`+(a)`, `*(a)`, `@(a)`, `?(a)`, `!(a)`) is matched literally and the vulnerable parser path is unreachable; the advisory's proof-of-concept patterns drop from ~480 ms to under 1 ms. No pattern used here relies on extglobs.
- `bun audit` matches by version and still lists both versions, so `tools/ci/dependency-audit-exceptions.json` carries one time-boxed entry naming the patch, owned by the owner (decision 2026-11-18), review date 2026-12-18. `tests/picomatch-local-patch.test.mjs` fails if the patch stops applying.
- `apps/cms` is untouched: its own `bun.lock` and `deps:audit:check` exception arrive with the subtree sync of the same upstream fix. Remove the entry and both patches once picomatch publishes a fixed release.
