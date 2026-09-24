---
bump: patch
type: dependency
impact: internal
---

# Align the root-owned Bun pin to 1.4.2

The #210 subtree sync left a root-owned toolchain drift: root `package.json`
still pinned `packageManager: "bun@1.4.0"`/`engines.bun: ">=1.3.0"` while the
embedded `apps/cms/package.json` (a leftover from before the subtree embed,
not part of this pin) already read `bun@1.4.2`, and every root workflow that
installs Bun (`ci.yml`, `template-init-smoke.yml`, `e2e.yml`, `images.yml`,
`release.yml`) still requested `1.4.0`. Two Bun patch versions coexisting in
one monorepo makes local/CI reproduction less deterministic.

- Raised the authoritative root pin to `bun@1.4.2`: `package.json`'s
  `packageManager`, and `bun-version: "1.4.2"` in every job of every root
  workflow above.
- `engines.bun` moved from `>=1.3.0` to `>=1.4.2` — its meaning stays a floor,
  not an exact pin (it also gates `apps/storefront`'s own `bun install` and
  any contributor's local Bun, where "at least this new enough" is the
  actual requirement), only its value moved up alongside the rest.
- Corrected AGENTS.md's (and its Indonesian mirror's) "Configuration and
  toolchain" bullet, which had stated the pin as living in "three places"
  naming only `ci.yml` — already an undercount before this change, since
  `release.yml`'s own `bun-version` job existed and was not named. The rule
  now names the actual, current set of root workflows that install Bun
  instead of a fixed count, and a workflow that starts installing Bun in the
  future is expected to join that list in the same change that adds its
  `bun-version` line.
- No lockfile content changed: this repository's local Bun runtime is
  already 1.4.2, so `bun install` and `bun run check:lockfile` were exercised
  under that same version and `bun.lock` came back byte-identical.

Astro/Playwright/Changesets updates that arrived through #210 remain that
subtree sync's own scope and are untouched here; this change is root-owned
toolchain alignment only (issue #211).
