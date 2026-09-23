---
bump: patch
type: structure
impact: internal
---

# Remove the Dependabot `bun` ecosystem block

Dependabot's `bun` updater cannot parse this repo's `bun.lock`
(`lockfileVersion` 2 — Bun 1.4's own format): its first scheduled run
failed outright (issue #199, run 35858077848), and a monthly job that
always fails is noise that hides a real failure. `.github/dependabot.yml`
now carries only the working `github-actions` block; this repo's own
workspace dependencies (root `package.json`, `apps/storefront`,
`packages/*`) are bumped by hand until Dependabot supports lockfile v2:
`bun update`, then `bun run check:lockfile`.

- `tests/dependabot-config.test.mjs` now asserts the block is absent
  while `bun.lock`'s `lockfileVersion` is greater than 1, and reads that
  number from the lockfile itself rather than hard-coding the invariant —
  so the test flips back to requiring the block the day it would pass.
- `AGENTS.md`'s "Configuration and toolchain" and
  `docs/alur-kerja-pengembangan.md`'s "Dependency updates" (plus both
  `.id.md` mirrors) describe the manual bump workflow and how to
  re-enable the block later.
