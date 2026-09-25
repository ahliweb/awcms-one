# Root knowledge-graph workflow

This directory, and the root `graphify-out/`, `.graphifyignore`, and `bun run knowledge:*` / `bun run audit:graf` scripts it documents, are this workspace's own federated Graphify + Obsidian workflow — added by [issue #11](https://github.com/ahliweb/awcms-one/issues/11). It is a navigation aid over this repo, never a source of truth: every finding it surfaces must be verified against the actual code, tests, and contracts before anyone acts on it.

`apps/cms` (`ahliweb/awcms`, embedded via `git subtree` — see the root [`AGENTS.md`](../AGENTS.md#the-subtree-embed)) already has its own Graphify graph, its own `.graphifyignore`, and its own gate (`apps/cms/scripts/graph-artifacts-check.ts`, run via `bun run check:cms`). **Nothing in this directory, or in the tooling it documents, touches that tree.** A change that belongs there goes to [`ahliweb/awcms#805`](https://github.com/ahliweb/awcms/issues/805) and arrives here through the normal subtree sync (`git subtree pull`), never a local edit.

## The federated model

```
apps/cms/graphify-out/graph.json      subtree-owned, authoritative for apps/cms — never re-extracted here

graphify-out/graph.json               THIS workspace's own graph — excludes apps/cms/** (.graphifyignore)
graphify-out/combined/graph.json      root + apps/cms, merged on demand — gitignored, never committed

knowledge/curated/                    five thin, hand-written files — facts not inferable from code
knowledge/generated/graphify/         safe, allowlisted export of the ROOT graph as Obsidian notes
```

Two graphs, not one: this repo builds its OWN root-owned graph rather than re-extracting `apps/cms`, and combines the two only on demand, outside the subtree, never committing the result. Building a second full copy of `apps/cms`'s ~12700-node graph at the root would create two competing authorities for the same code and roughly double the size of every rebuild this workspace commits to history — see the issue's own "Recommended architecture" for the full reasoning.

## Toolchain

Tested against **`graphify` 0.9.35** (a `uv tool install graphifyy` / `pip install graphifyy` install, resolved via `PATH`). `graphify` is a local Python tool; it is not installed on the CI runner, so only artefact-reading checks (`bun run audit:graf`) run there — the commands below need it on `PATH` locally.

| Command | Does | Needs `graphify` |
| --- | --- | --- |
| `bun run knowledge:graph:update` | (Re)builds `graphify-out/graph.json` via `graphify extract . --code-only`, then names communities via `graphify cluster-only .`, then records the run in `graphify-out/cost.json` | yes |
| `bun run knowledge:graph:combine` | Merges the root graph with `apps/cms/graphify-out/graph.json` into `graphify-out/combined/graph.json` (gitignored) via `graphify merge-graphs`, failing closed on a missing/malformed/empty/incompatible input | yes |
| `bun run knowledge:obsidian:export` | Exports the root graph to a staging vault, validates it, syncs the allowlisted result to `knowledge/generated/graphify/` | yes |
| `bun run audit:graf` | Reads the already-committed artefacts and checks the invariants below | no |
| `bun run knowledge:check` | Alias for `audit:graf` — the CI-safe half of this family | no |

## Extraction mode: code-only, local, no API, by default

`bun run knowledge:graph:update` runs `graphify extract . --code-only` — verified directly: `--code-only` "index[es] code (local AST, no API key) and skip[s] doc/paper/image files". Structural extraction only; no LLM call of any kind, for any file, ever, in this workflow's default path. Confirmed on this machine: neither `GEMINI_API_KEY` nor `GOOGLE_API_KEY` is set, and `graphify` reads no other provider key at all (not `ANTHROPIC_API_KEY`, not `OPENAI_API_KEY`) for extraction — those two are the *only* keys code-only mode could even read, and code-only mode never reads either. `graphify-out/cost.json` records `0` input and `0` output tokens for every run this workflow performs, and `bun run audit:graf` prints that total on every run so a nonzero figure is visible, not silent.

Community NAMING is separate from extraction and is also non-LLM here: `graphify cluster-only .` finds no `GEMINI_API_KEY`/`GOOGLE_API_KEY`/other backend configured and falls back to deterministic, free hub-based naming (`label_communities_by_hub` — the same mechanism `apps/cms/docs/awcms/knowledge-graph.md` documents for its own graph). Every community in the tracked graph is then given a human-chosen, plain-language name by hand, the same discipline `apps/cms`'s own graph documents (`apps/cms/docs/awcms/knowledge-graph.md`) and its gate enforces — a bare hub filename is not an acceptable community name; `bun run audit:graf` rejects one (see "What `audit:graf` checks" below). Hand-naming happens by editing `graphify-out/.graphify_labels.json` (a gitignored, machine-local sidecar `graphify cluster-only` itself reads and writes — never `graph.json` directly, which stays generated output) and re-running `PYTHONHASHSEED=0 graphify cluster-only .` to apply it. The fixed hash seed matters: graphify's clustering is seeded, but its node order follows Python's per-process string-hash randomization, so without it each run re-partitions a few communities, their saved labels no longer match `.graphify_labels.json.sig`, and they fall back to hub filenames. `bun run knowledge:graph:update` sets it itself. The sidecar is per-checkout, so a fresh worktree starts without the chosen names; copy `graphify-out/.graphify_labels.json*` in from an existing checkout before refreshing.

**Semantic/LLM extraction is opt-in and manual, never run by this repo's own scripts.** If a future contributor wants the richer doc/paper/image extraction described by the interactive `graphify` skill (installed per-user, typically at `~/.claude/skills/graphify/SKILL.md` — not part of this repository), that is a deliberate, interactive decision made by a human (or an agent acting on a human's explicit instruction) running the skill directly — never something `knowledge:graph:update` does on its own, and never something that silently starts because a key happens to be present in the environment for an unrelated reason.

## Tracked / untracked

| Path | Contents | Tracked? |
| --- | --- | --- |
| `graphify-out/graph.json` | root-owned graph, code-only AST | ✅ |
| `graphify-out/GRAPH_REPORT.md` | audit report for the root graph | ✅ |
| `graphify-out/manifest.json` | incremental-update state | ✅ |
| `graphify-out/cost.json` | cumulative token cost across runs (`0`/`0` today) | ✅ |
| `graphify-out/cache/` | extraction cache, machine-specific | ❌ (root `.gitignore`) |
| `graphify-out/.*` (markers, `.graphify_python`, …) | build intermediates | ❌ (root `.gitignore`) |
| `graphify-out/graph.html` | visualisation | ❌ (root `.gitignore`) |
| `graphify-out/[YYYY-MM-DD]/` | dated backup copies `graphify cluster-only` writes | ❌ (root `.gitignore`) |
| `graphify-out/combined/` | the on-demand federated graph | ❌ (new rule, this issue — never approved for commit) |
| `graphify-out/obsidian-staging/` | ephemeral Obsidian export staging | ❌ (new rule, this issue) |
| `knowledge/curated/*.md` | five hand-written files | ✅ |
| `knowledge/generated/graphify/*.md`, `*.canvas` | safe, allowlisted export of the root graph | ✅ |
| `knowledge/generated/graphify/.obsidian/` | a contributor's personal Obsidian app state | ❌ (new rule, this issue — never synced by the export tool either) |
| `apps/cms/graphify-out/*` | subtree-owned; `ahliweb/awcms`'s own four tracked files | ✅ (governed by `apps/cms`'s own gate, not this one) |

## What `bun run audit:graf` checks

Modelled on `apps/cms/scripts/graph-artifacts-check.ts` — the same five questions over the root artefacts (only the tracked files are tracked, the report agrees with the graph, every community has a chosen name, exclusions hold, `.graphifyignore` still names `apps/cms`), plus two that only exist at a federated root: no node in the tracked graph has a `source_file` under `apps/cms/` (no duplicate extraction), and `apps/cms/graphify-out/` still tracks exactly its own four files (no root tooling has ever written into the subtree). See `packages/gerbang/audit-graf.mjs`'s own docblock for the full list and what is deliberately not checked, and `tests/audit-graf.test.mjs` for each check proven to go red on the defect it exists to catch.

### Bounded content staleness (issue #186)

The model's own gate reports graph staleness but never fails on it (`apps/cms/scripts/graph-artifacts-check.ts`'s own docblock). `audit:graf` cannot make the same choice: nothing else in this repo would ever notice this root graph had stopped describing the tree — `graphify` is not installed in CI, so no CI job can regenerate it, and the only defence left is a gate that FAILS once the drift is large enough to matter.

The obvious measure — `git rev-list --count <built_at_commit>..HEAD` — is already printed as an informational `freshness:` note on every run, but it cannot be the failing check: CI checkouts are not guaranteed to be full, and a shallow checkout makes that range unreadable, not wrong, which is worse than either a red or a green verdict for a check meant to be trusted when it says nothing. `audit:graf` instead re-derives the same content hash `graphify` itself already computes and records in `graphify-out/manifest.json`'s `ast_hash` field per file: `hashlib.md5(usedforsecurity=False)` over the raw file bytes (`graphify` 0.9.35's own `detect.py::_md5_file`) — verified reproducible with nothing but `node:crypto`, no `graphify` install, no Python, no network.

`packages/gerbang/lib/graf-checks.mjs`'s `diffManifestStaleness` re-hashes every path `manifest.json` recorded, against a candidate set of currently git-tracked, in-scope files (never `apps/cms/`, never this workflow's own output, never a `*.id.md` mirror, and restricted to extensions the manifest has already shown are graphable here — a deliberate under-approximation of `graphify`'s own file-type/noise-dir/secret-file classification rather than a reimplementation of it, see that function's own docblock), and counts three things: files whose current hash disagrees with the recorded one (**changed**), in-scope files the manifest never saw (**added**), and manifest entries no longer in that candidate set (**removed**). `audit-graf.mjs`'s `MAX_STALE_FILES` (40, documented in its own docblock) is the bound: past it, the gate fails with a count broken down by changed/added/removed and a pointer to `bun run knowledge:graph:update`; at or under it, the same breakdown is only a note. `tests/graf-checks-staleness.test.mjs` proves the counting logic directly (under/at/over the bound, added/removed in isolation); `tests/audit-graf.test.mjs` proves the runner's wiring against real files.

## The Obsidian export boundary

`bun run knowledge:obsidian:export` stages the ROOT graph's export (never the combined one — a federated Obsidian export would re-materialise almost all of `apps/cms`'s own graph as committed notes, exactly the duplication this workflow exists to avoid), validates every file the export produced, and syncs only an allowlist of `.md`/`.canvas` files to `knowledge/generated/graphify/`. `knowledge/curated/` is read once, to reject any generated file whose name would collide with one already there — it is never written to. `packages/gerbang/lib/obsidian-safety.mjs` is the validation logic (path traversal, symlink escape, unexpected extension, and curated collision are each rejected, and the whole sync aborts rather than writing a partial result); `tests/obsidian-safety.test.mjs` and `tests/knowledge-obsidian-export.test.mjs` prove it.

## Cross-repo source-of-truth rules

- **`ahliweb/awcms`** owns generic CMS backend Graphify policy and graph semantics — its own `.graphifyignore`, its own tracked-artefact list, its own `graph:artifacts:check` gate.
- **`apps/cms`**, in this repo, is a synchronised subtree CONSUMER of that policy. It is not a fork of it and does not diverge from it locally.
- **`awcms-one`** (this repo) owns root monorepo Graphify policy and cross-workspace composition — everything documented in this directory.
- **`ahliweb/awcms-astro`** remains the family's frontend reference where relevant (see [`ahliweb/awcms-astro#113`](https://github.com/ahliweb/awcms-astro/issues/113)), but this workspace's own storefront (`apps/storefront`) decisions are owned here, not inherited from it.
- **A combined graph is an analysis view, not a new authority.** `graphify-out/combined/graph.json` restates root + `apps/cms` for cross-workspace queries; it introduces no fact that was not already true in one of the two graphs it merges, and it is never committed.
- If a change to `apps/cms`'s OWN Graphify policy (its `.graphifyignore`, its tracked-artefact list, its gate) turns out to be needed, it is proposed at [`ahliweb/awcms#805`](https://github.com/ahliweb/awcms/issues/805) and arrives here through `git subtree pull` — never patched locally in a way a future sync would conflict with or silently overwrite (root [`AGENTS.md`](../AGENTS.md#the-subtree-embed)).

## Security and privacy: what this workflow considers, and does not certify

These are engineering controls aligned with this repo's existing security posture (root [`SECURITY.md`](../SECURITY.md), `apps/cms`'s own [threat model](../apps/cms/docs/awcms/20_threat_model_security_architecture.md)) and, informally, with ISO/IEC 27001/27002/27005/27034/27701 principles. **This workflow makes no claim of certification or compliance with any of those standards** — issue #11 is explicit that none is being asserted here.

| # | Risk | Control |
| --- | --- | --- |
| 1 | `.env`, secrets, or private migration data get indexed | The root `.gitignore`'s existing `.env` / `.env.*` rules apply to `graphify` too — it reads `.gitignore` before `.graphifyignore` and can only exclude further, never re-include. No migration dump or credential file exists at this repo's root. |
| 2 | Semantic extraction unexpectedly reaches an external provider | Off by default (`--code-only`, verified above); no provider key is read by this workflow's own scripts; a semantic run is always a deliberate, manual, human-initiated act — never triggered by `knowledge:graph:update`. |
| 3 | Query logs / caches leak repository context | `graphify-out/cache/`, every `graphify-out/.*` marker, and `graphify-out/memory/` (the `save-result`/`reflect` feature, unused by this workflow) are gitignored and machine-local; never tracked, never synced. |
| 4 | A merged graph mixes stale `apps/cms` state with current root state | `knowledge:graph:combine` prints each input's `built_at_commit` distance to `HEAD` and is regenerated on demand rather than cached; it is never committed, so a stale combined graph cannot outlive the session that built it. |
| 5 | Duplicate extraction produces contradictory node identities | `.graphifyignore` excludes `apps/cms/`; `bun run audit:graf`'s `checkNoSubtreeNodes` fails the gate if any root-graph node is sourced from there anyway. |
| 6 | Obsidian export overwrites curated or team files | The stage → validate → allowlist-sync boundary (above); a curated-filename collision aborts the whole sync rather than overwriting anything; `.obsidian/` app state is never synced. |
| 7 | Prompt injection from untrusted text or imported content, consumed by an agent | Every node, edge, label, and generated note is repository content an agent READS as data — never as an instruction. This directory's own generated files are machine output an agent must not hand-edit (root [`AGENTS.md`](../AGENTS.md)'s new "Working with the knowledge graph" section states this explicitly), and the same "verify before acting" rule in that section applies to anything a graph query surfaces, including quoted text from a document node. |
| 8 | Root automation writes into the subtree | `packages/gerbang/lib/subtree-guard.mjs`'s `assertNotUnderSubtree` guards every write `tools/knowledge-graph-combine.mjs` and `tools/knowledge-obsidian-export.mjs` perform; `bun run audit:graf`'s `checkSubtreeArtifactsUnchanged` is the standing, after-the-fact proof; `tests/knowledge-no-subtree-write.test.mjs` exercises both. |
| 9 | Graph artefacts inflate the repository, a release, or a Docker build context | The tracked root set is four small files over a 2254-node graph; `.dockerignore` excludes `graphify-out/` and `knowledge/` wholesale; the one large artefact this workflow ever produces (`graphify-out/combined/graph.json`, tens of megabytes) is gitignored and never enters a commit, a release tarball, or a Docker build context. |

## `knowledge/curated/`

Five short files, each stating facts that are not safely inferable from code — see each file for what it covers and what it deliberately links to instead of restating:

- [`curated/monorepo-map.md`](curated/monorepo-map.md) — what is root-owned, subtree-owned, and planned, and why.
- [`curated/ownership-boundaries.md`](curated/ownership-boundaries.md) — the subtree embed and sync rules, and who may edit what.
- [`curated/contracts-index.md`](curated/contracts-index.md) — backend / storefront / shared-contract responsibility and cross-workspace data flow.
- [`curated/security-index.md`](curated/security-index.md) — tenant-isolation and security boundaries, linking to canonical sources.
- [`curated/lessons-learned.md`](curated/lessons-learned.md) — re-platform rationale and operational decisions recorded so they are not relitigated.
