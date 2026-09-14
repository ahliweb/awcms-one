---
bump: minor
type: structure
impact: internal
---

# Monorepo foundation: audit gates, release tooling, governance docs, and CI

Stands up the machinery `apps/storefront` (issue #5) and `packages/kontrak` (issue #6) will land into, modelled on `ahliweb/media-lenterakalteng`: `packages/gerbang`'s three audit gates (`audit:dokumen`, `audit:rilis`, `audit:translation`), `tools/rilis.mjs` + `cek-lockfile.mjs` + `docs-i18n-stamp.mjs`, the `.changesets/` convention itself, every governance document with its Indonesian mirror, and a CI workflow that runs the check job unconditionally.

- `bun install` resolves the workspace; `bun test` from the root is green and does not execute anything under `apps/cms/` (already excluded via `bunfig.toml`, proven here rather than merely trusted).
- Content, asset, and crawl gates (`audit:konten`, `audit:aset`, `audit:graf`, `audit:serapan`) are deliberately **not** ported: this repository has no built content, asset, or crawl surface yet for them to guard. Porting them now would ship gates that always pass trivially, which is worse than not having them — a green gate that checks nothing reads exactly like one that checked something and found it clean.
- `AGENTS.md` records the `git subtree` sync discipline for `apps/cms`: a subtree-sync PR must be merged with a merge commit, never squashed or rebased, or the next `git subtree pull` loses the merge base it needs.
