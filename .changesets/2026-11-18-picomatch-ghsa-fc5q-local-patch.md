---
bump: patch
type: dependency
impact: internal
---

# Take the astro advisory fixes

`bun audit --audit-level=low` reddened `local-ci/check-toko` and `local-ci/security` for every PR. Two astro advisories were behind it (a third, picomatch `GHSA-fc5q-39xc-vjpf`, was first mitigated here by a local patch and was then withdrawn upstream; see the 32863de8 sync changeset).

- **astro `GHSA-mh32-jxcr-mh9f`** (low, XSS via attribute injection in dynamic tag names, `<=7.4.4`) and **`GHSA-r3h5-4585-7x3w`** (moderate, `@astrojs/node` image endpoint reads a case-variant sibling of the output directory, `<=11.1.11`) are closed by bumping within the major: `apps/storefront` now declares `astro` `^7.4.12` and `@astrojs/node` `^11.1.13`, and the root `bun.lock` resolves `astro@7.4.12` and `@astrojs/node@11.1.13` for the whole workspace.
