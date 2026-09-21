# Ownership boundaries and subtree sync rules

Who may edit what, and the one mechanical trap that protects every future `apps/cms` sync — facts about *process*, not about code, so nothing in `apps/cms/` itself states them.

## Source-of-truth boundaries

- **`apps/cms/`'s own source is upstream's tree.** A change that belongs upstream — a fix to `awcms` shared infrastructure, a change to a module `awcms` itself owns — is made in [`ahliweb/awcms`](https://github.com/ahliweb/awcms) and pulled in via `git subtree pull --prefix=apps/cms awcms main`, never patched locally in a way a future pull would conflict with or silently overwrite.
- **Work specific to this platform** (the `commerce` module, [issue #4](https://github.com/ahliweb/awcms-one/issues/4)) is additive inside `apps/cms`'s own module directory, following its own module-admission discipline (`apps/cms/AGENTS.md`).
- **Root-level tooling** (`packages/gerbang/`, `tools/`, `tests/`, `knowledge/`) governs the whole repo and stays workspace-agnostic. A check that only makes sense for one workspace belongs in that workspace's own gate chain, not the root suite.
- **`apps/cms`'s own Graphify contract** (`apps/cms/.graphifyignore`, `apps/cms/graphify-out/`, `apps/cms/docs/awcms/knowledge-graph.md`) is upstream's policy, consumed here read-only. A needed change goes to [`ahliweb/awcms#805`](https://github.com/ahliweb/awcms/issues/805) first — see [`../README.md`](../README.md#cross-repo-source-of-truth-rules).

## The one rule that protects every future subtree sync

**A pull request that syncs `apps/cms/` from upstream must be merged with a MERGE COMMIT — never squashed, never rebased.**

Not a style preference: `git subtree pull` finds the merge base between this repo's history and upstream's, then replays upstream's commits on top of it. Squashing that pull collapses every replayed commit into one synthetic commit git did not create through a merge, which destroys the merge base the *next* `git subtree pull` needs. Every sync after that then conflicts against history git can no longer line up — and the damage is not obvious at the time: the squashed PR merges cleanly, CI is green, and the break only surfaces the next time someone tries to pull from upstream, far from the commit that caused it. Nothing in `apps/cms/` or its history shows this rule; it lives only here and in root [`AGENTS.md`](../../AGENTS.md#the-one-rule-that-protects-every-future-sync).

Since issue #149 this is also a mechanical property of the repository, not only a documented one: squash and rebase merges are disabled repository-wide (`allow_squash_merge=false`, `allow_rebase_merge=false`, `allow_merge_commit=true`), so GitHub's own merge button cannot produce the failure mode described above, for this PR class or any other. Required linear history stays off, deliberately — it would conflict with the full-history model this rule protects.

## What this means for the knowledge-graph workflow specifically

Everything under `knowledge/`, plus the root `graphify-out/`, `.graphifyignore`, and `bun run knowledge:*` / `audit:graf` scripts, is root-owned and follows the ordinary root rules above — none of it is subtree-synced, and none of it is upstream's to review. The one boundary specific to this workflow: it must never WRITE into `apps/cms/`, checked by `packages/gerbang/lib/subtree-guard.mjs` at every write site and proven by `tests/knowledge-no-subtree-write.test.mjs` — see [`../README.md`](../README.md) for the mechanism.
