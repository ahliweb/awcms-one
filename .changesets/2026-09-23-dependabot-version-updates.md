---
bump: patch
type: structure
impact: internal
---

# Dependabot version updates for GitHub Actions and this repo's own workspaces

`AGENTS.md`'s "Configuration and toolchain" already claimed GitHub Actions are pinned to a SHA "with a `# vX.Y.Z` comment Dependabot reads to keep both in step" — but no `.github/dependabot.yml` existed, so only Dependabot *security* updates ever ran and pinned actions/dependencies never received a routine version bump.

- Adds `.github/dependabot.yml`: `github-actions` (root workflows) and `bun` (this repo's own workspaces), both monthly and grouped (minor/patch together, majors separate).
- `bun` update excludes `apps/cms/**` (`exclude-paths`) — that tree is `ahliweb/awcms` embedded via `git subtree`, and upstream owns its own dependency set and its own (inert-here) `apps/cms/.github/dependabot.yml`.
- `bun` update ignores the `bun` dependency itself — its version is pinned in three places that must move together (`packageManager`/`engines.bun`, `bun-version` in every CI job), a deliberate hand-made change, not something a single-dependency PR should touch.
- `AGENTS.md` and `docs/alur-kerja-pengembangan.md` (plus their `.id.md` mirrors) now name the real config and describe what to check on a Dependabot PR against the lockfile gate.
