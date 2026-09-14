---
bump: minor
type: structure
impact: internal
---

# Federated knowledge-graph workflow: root Graphify graph, `audit:graf`, safe Obsidian export

Adds a monorepo-level Graphify + Obsidian workflow (issue #11) without duplicating or corrupting the Graphify state already embedded inside `apps/cms` via the `ahliweb/awcms` subtree. Two graphs, federated on demand rather than one graph built twice — the same discipline the rest of this repo already applies to `apps/cms`'s own tree.

- Root `.graphifyignore` + a real, committed root graph (`graphify-out/graph.json`, 396 nodes) built `--code-only` — structural AST extraction, no LLM, no API key, no network, ever, by default. Excludes `apps/cms/**`, which already owns its own graph and its own gate.
- `bun run audit:graf` (alias `knowledge:check`) — the fourth `audit:*` gate, modelled on `apps/cms/scripts/graph-artifacts-check.ts`: tracked-artefact hygiene, report/graph agreement, chosen community names, `.graphifyignore` still excluding `apps/cms`, no duplicate-extracted node, the federated graph never tracked, and `apps/cms/graphify-out/` untouched by this repo's own tooling. Runs in CI (`.github/workflows/ci.yml`) — it reads only committed artefacts, no `graphify` installation needed.
- `bun run knowledge:graph:combine` — merges the root graph with `apps/cms/graphify-out/graph.json` into a gitignored, on-demand `graphify-out/combined/graph.json`, failing closed on a missing, malformed, empty, or `directed`-mismatched component graph (checks `graphify merge-graphs` itself does not make).
- `bun run knowledge:obsidian:export` — stages the root graph's Obsidian export, validates every file (rejecting a symlink, an unexpected extension, path traversal, or a curated-filename collision), and syncs only the allowlisted result to `knowledge/generated/graphify/`. `knowledge/curated/` is read only for collision-checking, never written.
- `packages/gerbang/lib/subtree-guard.mjs` guards every write both new tools perform; `tests/knowledge-no-subtree-write.test.mjs` runs both tools for real against a fixture tree and proves `apps/cms/` comes out byte-for-byte unchanged.
- `knowledge/README.md` + five thin `knowledge/curated/*.md` files record what code alone cannot state: ownership boundaries, cross-repo source-of-truth rules, the tracked/untracked table, and a nine-item threat model — no ISO/IEC certification claimed.
- `README.md`/`AGENTS.md` (and their Indonesian mirrors) revisit the earlier, now-outdated statement that `audit:graf` was not ported — it is, and both documents say why and what changed.
