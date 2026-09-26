---
bump: patch
type: fix
impact: public
---

# `template:init` now rewrites `bun.lock`'s root workspace name too

`template:init` rewrote root `package.json`'s `name` to a derived
deployment's own slug, but left `bun.lock`'s `workspaces[""].name` as
`"awcms-one"` — `bun install` does not touch an existing root workspace
entry to match a renamed manifest, it just reports "no changes". `bun run
check:lockfile` (`tools/cek-lockfile.mjs`) then failed in every derived
repository with "lockfile entry name = \"awcms-one\", package.json name =
\"<slug>\"" (issue #227, first hit in `ahliweb/omes-web`).

`tools/template-init/rewriters.mjs`'s new `rewriteBunLock()` targets ONLY
that one field, anchored on the fixed JSON shape of the root workspace
entry (never on the literal value currently there, so the rewrite stays
idempotent across repeated runs with different `--slug` values, and never
on any other workspace's own `name`). This is a single-field string
replacement, never a lockfile regeneration — `rm -rf node_modules bun.lock
&& bun install` would re-resolve every dependency and could drift resolved
versions in a derived repo's very first commit.

- A repository derived from this template now passes `bun run
  check:lockfile` right after `template:init` runs, with no manual `sed`
  workaround.
- `tests/template-init.test.mjs` asserts the rewrite happened, that every
  other workspace's own name survives untouched, that `bun run
  tools/cek-lockfile.mjs` actually passes against the rewritten pair, and
  that a second run with identical flags (and a third run with an
  unrelated flag change) leaves it correctly idempotent.
