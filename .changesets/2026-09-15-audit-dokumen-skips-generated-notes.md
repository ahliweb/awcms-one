---
bump: patch
type: fix
impact: internal
---

# audit:dokumen no longer reads knowledge/generated/

`bun run audit:dokumen` now skips `knowledge/generated/` the way it already skips `apps/cms/` (issue #15). Graphify's Obsidian export extracts notes from source code; it does not author them. The first false positive was concrete: the moment `docs/adr/` existed, the ADR-citation check fired on three generated notes quoting the gate's own illustrative example citation (a placeholder ADR number in a comment in `packages/gerbang/audit-dokumen.mjs`). Every other check in the gate would misfire on generated notes the same way — their links are wikilinks the gate does not parse, and a stale path in one is graph staleness, which `bun run audit:graf` deliberately leaves alone. `knowledge/curated/` and `knowledge/README.md` are authored and stay in scope; two fixture tests pin both sides of that line.
