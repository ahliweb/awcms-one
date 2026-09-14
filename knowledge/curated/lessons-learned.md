# Lessons learned

Decisions recorded so they are not relitigated by someone who did not see the reasoning the first time — the specific failure this file exists to prevent in each case is stated, not just the conclusion.

## Why re-platform rather than upgrade Laravel in place

`awcms-one` re-expresses borneojek-mart's commerce domain on Bun/Astro/PostgreSQL-RLS rather than modernising the existing PHP/Laravel/MySQL/React-Inertia stack incrementally. The commerce module needs `awcms` shared infrastructure — tenant-scoped row-level security, ABAC authorization, the transactional outbox — that has no equivalent to graft onto the Laravel app; building it there would mean re-inventing what `apps/cms` already gets for free by embedding `awcms` whole. Full framing: [issue #1](https://github.com/ahliweb/awcms-one/issues/1).

## Why `git subtree`, not a package dependency or a fork

A package dependency cannot carry the shared infrastructure `apps/cms` needs without re-exporting nearly all of `awcms`; a fork would let this repo's own `apps/cms` drift from upstream fixes silently. `git subtree` keeps upstream's full commit history inside this repo and lets fixes flow in both directions — at the cost of one mechanical trap (squashing a subtree-sync PR destroys the merge base the next sync needs), which is why that rule is recorded in three places: root [`AGENTS.md`](../../AGENTS.md#the-one-rule-that-protects-every-future-sync), root [`README.md`](../../README.md), and [`ownership-boundaries.md`](ownership-boundaries.md) here.

## Why the root knowledge graph is `--code-only` by default (issue #11)

The first working root build used `graphify extract . --code-only` deliberately, not merely because no `GEMINI_API_KEY`/`GOOGLE_API_KEY` happened to be set: issue #11 requires semantic/LLM extraction to be explicit and off by default, and code-only is the mode that is provably local — no provider key read, no network call, for any file, ever. A future contributor who wants richer doc/paper/image extraction opts in by hand; the root workflow's own scripts never do.

## Why the federated graph is generated, not committed

An earlier draft of this workflow considered committing `graphify-out/combined/graph.json` so a fresh clone could query it without running `graphify` first. Measured against the real toolchain: merging this workspace's 396-node graph with `apps/cms`'s own ~12700-node one produces a combined graph in the tens of megabytes — essentially a second copy of `apps/cms`'s own graph, committed at the root, growing every time either side grows. That is exactly the duplication issue #11's Objective forbids. The combined graph stays generated, gitignored, and regenerated on demand (`bun run knowledge:graph:combine`) instead.

## Why the Obsidian export runs against the root graph, not the combined one

The same reasoning as above, applied to notes instead of JSON: exporting the combined graph would write one Obsidian note per node — nearly 13000 of them, almost all restating `apps/cms`'s own content — into a directory this repo commits. `knowledge:obsidian:export` exports the root graph only; a developer who wants a personal, federated vault runs the export against `graphify-out/combined/graph.json` themselves, to a location this workflow does not manage. See [`../README.md`](../README.md#why-the-root-graph-not-the-combined-one) for the full reasoning.
