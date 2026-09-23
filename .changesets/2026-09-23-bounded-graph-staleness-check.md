---
bump: minor
type: structure
impact: internal
---

# `audit:graf` fails once the root knowledge graph drifts too far from the tree

`graphify-out/` was last regenerated 2026-09-20, before v0.10.0's storefront
redesign — `audit:graf` verified the corpus was self-consistent but never
that it still described the current code, and CI has no `graphify` on `PATH`
to regenerate it itself.

- `audit:graf` now diffs `graphify-out/manifest.json`'s recorded per-file MD5
  (`graphify`'s own `ast_hash` — verified reproducible with plain
  `node:crypto`, no `graphify` install needed) against the current working
  tree, and fails once more than `MAX_STALE_FILES` (40) files show up
  changed/added/removed since the graph was last built — content-based, not
  git history, so it works under CI's possibly-shallow checkouts.
- `packages/gerbang/lib/graf-checks.mjs` gains the pure counting logic
  (`diffManifestStaleness`, `checkStaleness`, `md5Hex`,
  `manifestExtensions`, `inScopeCandidates`), unit-tested directly in
  `tests/graf-checks-staleness.test.mjs` (under/at/over the bound,
  added/removed in isolation) with the runner's wiring proven end-to-end in
  `tests/audit-graf.test.mjs`.
- The root graph is regenerated (`bun run knowledge:graph:update`,
  `--code-only`, `apps/cms/` still excluded) and every one of its 94
  communities carries a human-chosen name — the graph is at parity with the
  tree as of this change.
