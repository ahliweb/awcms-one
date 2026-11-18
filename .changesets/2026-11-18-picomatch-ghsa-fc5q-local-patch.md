---
bump: patch
type: dependency
impact: internal
---

# Mitigate picomatch GHSA-fc5q-39xc-vjpf with a local patch; take the astro advisory fixes

`bun audit --audit-level=low` reddened `local-ci/check-toko` and `local-ci/security` for every PR. Three advisories were behind it.

- **picomatch `GHSA-fc5q-39xc-vjpf`** (high, ReDoS through repeated extglobs, `<=4.0.7`) has **no patched release** (upstream fixes are unmerged PRs). `patches/picomatch@4.0.7.patch` and `patches/picomatch@2.3.2.patch` (root `patchedDependencies`) force `opts.noextglob = true`, so extglob syntax (`+(a)`, `*(a)`, `@(a)`, `?(a)`, `!(a)`) is matched literally and the vulnerable parser path is unreachable; the advisory's proof-of-concept patterns drop from ~480 ms to under 1 ms. No pattern used here relies on extglobs. `bun audit` matches by version and still lists both versions, so `tools/ci/dependency-audit-exceptions.json` carries one time-boxed entry naming the patch, owned by the owner (decision 2026-11-18), review date 2026-12-18. `tests/picomatch-local-patch.test.mjs` fails if the patch stops applying. Remove the entry and both patches once picomatch publishes a fixed release.
- **astro `GHSA-mh32-jxcr-mh9f`** (low, XSS via attribute injection in dynamic tag names, `<=7.4.4`) and **`GHSA-r3h5-4585-7x3w`** (moderate, `@astrojs/node` image endpoint reads a case-variant sibling of the output directory, `<=11.1.11`) are closed by bumping within the major: `apps/storefront` now declares `astro` `^7.4.12` and `@astrojs/node` `^11.1.13`, and the root `bun.lock` resolves `astro@7.4.12` and `@astrojs/node@11.1.13` for the whole workspace.
- `apps/cms` is untouched: its own picomatch audit exception arrives with a later subtree sync of the same upstream fix.
