---
bump: minor
type: structure
impact: internal
---

# audit:graf fits derived products: code-only graphs, tracking lists and a subtree allow-list

`bun run audit:graf` assumed a document-and-code graph and a subtree that no derived product ever touches (issue #534). With the template's own tracked graph and no `STATUS.md`, behaviour is unchanged.

- **Code-only graphs.** When `graphify-out/STATUS.md` exists, a hub-name fallback community label is reported as a note instead of a failure. A placeholder label, a missing name or a report/graph mismatch still fails, and a graph without `STATUS.md` fails for a fallback label exactly as before.
- **Tracked artefacts follow the skill's table.** Three explicit lists in `packages/gerbang/lib/graf-checks.mjs`: `graph.json` and `GRAPH_REPORT.md` required; `STATUS.md`, the label sidecar, `manifest.json` and `cost.json` optional (so a product that leaves the last two untracked, as the skill's table says, passes); anything else refused.
- **`SUBTREE_ALLOWLIST`** (default empty): `{ prefix, reason }` paths under `apps/cms/` a derived product owns and may extract into its root graph. One list drives the `.graphifyignore` check (default-deny `apps/cms/*` plus re-includes), the no-subtree-node check and the staleness candidates. The subtree's own graph directory can never be listed.
