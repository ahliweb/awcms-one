🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](AGENTS.id.md)

# AGENTS.md — awcms-one's working contract

Applies to humans and AI agents working in this repo alike. Read this before doing anything else. Where a rule here collides with a habit that feels natural, the rule here wins — every item exists because breaking it has caused, or would cause, a defect that is invisible until someone acts on the wrong assumption.

## What this repo is

**awcms-one** re-platforms the borneojek-mart commerce store — PHP/Laravel/MySQL/React-Inertia — onto the AWCMS stack: Bun, Astro, and PostgreSQL under row-level security. This is a **re-platform, not a refactor**: no Laravel code is carried over. The source schema is read from the live `commerce_bj_mart` MySQL database and re-expressed as AWCMS module tables under PostgreSQL RLS. Full framing: [issue #1](https://github.com/ahliweb/awcms-one/issues/1).

The approach is scaffold-first, then one thin vertical slice (catalog listing + product detail) to prove the stack end to end before the full commerce build. **Increment 1 — this epic — is foundation plus that authored slice, with no live database.** Everything type-checks and every gate that does not need PostgreSQL runs green; migrating and seeding a real Postgres instance is increment 2.

This document's own workspace layout, gate mechanism, and changeset convention are adapted from [`ahliweb/media-lenterakalteng`](https://github.com/ahliweb/media-lenterakalteng). Where a rule below is inherited from that repo's own hard-won lesson rather than one this repo has found for itself, it says so.

## What is here today, and what is not

Truthfully, as of this document landing:

- **Here:** the workspace root and its governance, `packages/config`, `packages/gerbang`, `tools/`, and `apps/cms` (`ahliweb/awcms` v10.3.0, embedded via `git subtree` with full history — closes [issue #2](https://github.com/ahliweb/awcms-one/issues/2)).
- **Not here yet:** `apps/storefront` (the public Astro storefront — [issue #5](https://github.com/ahliweb/awcms-one/issues/5)), `packages/kontrak` (the type-only DTO contract between them plus its import-direction gate — [issue #6](https://github.com/ahliweb/awcms-one/issues/6)), the `commerce` module inside `apps/cms` ([issue #4](https://github.com/ahliweb/awcms-one/issues/4)), and formal architecture documentation ([issue #7](https://github.com/ahliweb/awcms-one/issues/7)).

Do not write code, gates, or documentation that assumes any of the "not here yet" items already exist. A path cited in backticks that does not exist in this repo is caught by `bun run audit:dokumen`'s named-path check unless it is listed in that gate's `EXCLUDED_PATHS`, with a reason.

## The subtree embed

`apps/cms` is `ahliweb/awcms` embedded whole via `git subtree`, not a dependency or a copy. This preserves upstream's full commit history inside this repo and lets fixes flow in both directions.

| | |
| --- | --- |
| Upstream remote | `awcms` → `https://github.com/ahliweb/awcms.git`, fetch refspec narrowed to `+refs/heads/main:refs/remotes/awcms/main` |
| Embed point | `ahliweb/awcms` v10.3.0, commit `749404d4963af1dfaf8a5cf8b229299b29556ce2` |
| Sync command | `git subtree pull --prefix=apps/cms awcms main` |

**Why the remote's fetch is narrowed to `main` only:** adding the remote without narrowing its refspec drags in every upstream branch, including dependabot branches — seven of them, the first time this remote was added here. A subtree sync only ever wants `main`.

### The one rule that protects every future sync

**A pull request that syncs `apps/cms/` from upstream (a `git subtree pull`) must be merged with a MERGE COMMIT — never squashed, never rebased.**

This is not a style preference; it is a mechanical trap. `git subtree pull` works by finding the merge base between this repo's history and upstream's, and replaying upstream's commits on top of it. Squashing that pull collapses every one of those upstream commits into one synthetic commit that git did not create through a merge — which destroys the merge base the *next* `git subtree pull` needs to find. Every future sync after that then conflicts against history git can no longer line up, and the damage is not obvious at the time: the squashed PR merges cleanly, CI is green, and the break only surfaces the next time someone tries to pull from upstream, far from the commit that caused it.

**Nothing mechanically stops this today.** This repository's merge settings currently allow squash merges, rebase merges, and merge commits alike, and `main` carries no branch protection yet (this document's own PR is what introduces CI; branch protection is a separate, not-yet-taken step). The only guard is this paragraph, read before the merge button is clicked. If branch protection is configured later, restricting `apps/cms`-touching PRs to merge commits only is the mechanical version of this rule and should replace the honour system above it — but until then, read this first.

Every other PR in this repo may be merged however the reviewer prefers; `delete_branch_on_merge` is enabled repo-wide, so a merged branch is cleaned up automatically regardless of merge strategy.

### What is, and is not, this repo's to edit

`apps/cms`'s own source is upstream's tree, carried here for the reasons in [`README.md`](README.md#why-apps-cms-embeds-awcms-whole). Changes that belong upstream — a fix to `awcms` shared infrastructure, a change to a module `awcms` itself owns — should be made there and pulled in via the sync above, not patched locally in a way that a future `git subtree pull` will conflict with or silently overwrite. Work that is specific to this platform (the `commerce` module, issue #4) is additive inside `apps/cms`'s own module directory, following its own module-admission discipline (`apps/cms/AGENTS.md`).

## Workspace boundaries

This is a Bun workspace (`workspaces: ["apps/*", "packages/*"]`); each directory under `apps/` and `packages/` is a separate concern, and a change should stay inside the workspace(s) it is actually about. Concretely:

- Nothing outside `apps/cms/` should depend on `apps/cms`'s **internals** — only its public API, once `apps/storefront` exists to call it.
- Root-level tooling (`packages/gerbang/`, `tools/`, `tests/`) governs the whole repo and should stay workspace-agnostic: a check that only makes sense for one workspace belongs in that workspace's own gate chain (`apps/cms/package.json`'s `check` script, and eventually `apps/storefront`'s own), not bolted onto the root suite.
- A change that touches `apps/cms/` for reasons unrelated to a subtree sync should say so plainly in its PR — the merge-commit rule above applies specifically to subtree syncs, not to every PR that happens to touch that directory.

## The gates

`bun test` plus three `audit:*` scripts, all adapted from `ahliweb/media-lenterakalteng`'s `packages/gerbang`. None needs a build, a network, or `apps/cms`, so all of them run unconditionally on every push (`.github/workflows/ci.yml`).

| Gate | What it catches |
| --- | --- |
| `bun run audit:dokumen` | Dead relative links in markdown; an ADR index incomplete in either direction or carrying a duplicate row (once `docs/adr/` exists — it self-skips until then); a file path named in backticks that does not exist in this repo; an `ADR-NNNN` citation that resolves to nothing; a spelled-out number that disagrees with the set it claims to count, inside an explicitly marked block |
| `bun run audit:rilis` | The waiting `.changesets/` backlog crossing its bound — 10 files or 14 days old, both starting assumptions pending real release history (see that gate's own docblock) |
| `bun run audit:translation` | An Indonesian mirror (`<name>.id.md`) whose recorded source hash no longer matches its English source, or a governance document with no mirror at all |
| `bun test` | The root gate test suite — `tests/*.test.mjs` — plus, once they exist, `apps/storefront`'s own tests. `apps/cms/**` is excluded via `bunfig.toml`'s `pathIgnorePatterns`, not via a flag on the `test` script (see that file's own comment for why the distinction is load-bearing: CI invokes `bun test` bare, and a flag on `bun run test` would silently not apply) |

**Deliberately not ported**, and the reason is not "not built yet" alone — it is that each one guards a surface this repo does not have: `audit:konten` (checks published HTML/build output), `audit:aset` (a reader's byte budget over that same output), `audit:graf` (hygiene over a `graphify-out/` artefact corpus), `audit:serapan` (which upstream `awcms` ADRs nobody here has read yet — a decision log this repo does not maintain). Porting any of them today would produce a gate that passes trivially forever, which is worse than absence: a green check that has checked nothing is indistinguishable, from the outside, of one that checked something and found it clean. Add each one back in the change that actually creates the surface it would guard.

### Rules the gate scripts themselves follow

Enforced by `tests/standar-skrip.test.mjs`, and worth stating here because they are easy to break without anything failing until this test:

- **git is never reached through a shell.** Every script that needs git goes through `packages/gerbang/lib/git.mjs`, which spawns an argv array. `execSync` with an interpolated string is a real injection risk, not a hypothetical one — a git ref name can contain `$`, a backtick, `;`, `&`, and `|`, and `execSync` runs its argument through `/bin/sh`.
- **One finding/report apparatus.** Both audit gates build their report through `packages/gerbang/lib/reporter.mjs`'s `createReporter`, not a second hand-rolled printer.
- **`packages/gerbang/lib/` modules are side-effect free.** Importing one must run nothing and print nothing — a module that can exit or write to stdout on import is a decision a caller did not make.
- **A helper is declared once.** `stripTrailingCommas`, `readFileIfPresent`, and similar are not re-declared inside a gate or tool that could import them instead.

## Configuration and toolchain

- **Bun is this repo's runtime and package manager.** Its version is pinned in **three places that must move together**: `packageManager` and `engines.bun` in the root `package.json`, and `bun-version` in every job of `.github/workflows/ci.yml`. Raising one without the others makes a local install, CI, and any future container image behave differently — silently. `apps/cms/package.json`'s own `packageManager` (`bun@1.4.2`) is a leftover from when it was a standalone repository before the subtree embed; it does not govern this workspace and is not part of this pin (`bun install` runs once, at the root, for the whole workspace).
- **`bun.lock` must be a true statement about this repo.** `bun run check:lockfile` checks it before install, for the root and every real workspace member: the workspace name must belong to this repo (a lockfile copied from elsewhere is recognisable exactly here) and every dependency block must match its `package.json` precisely. Regenerate in full with `rm -rf node_modules bun.lock && bun install`; never hand-edit `bun.lock`.
- **GitHub Actions are pinned to a commit SHA, not a tag**, with a `# vX.Y.Z` comment Dependabot reads to keep both in step. A tag can move; a SHA cannot, and an action runs with access to the workflow token and the whole checkout.
- **A bare `bun test` from the root must never execute `apps/cms/**`.** The exclusion lives in `bunfig.toml`'s `[test] pathIgnorePatterns`, which `bun test` reads however it is invoked — not as a flag on the `test` script in `package.json`, which CI's bare `bun test` would silently skip.
- **Every env variable a root-level script reads belongs in `.env.example`**, with the consequence of leaving it unset. `apps/cms` maintains its own `.env.example` for its own runtime configuration; this repo's root file does not duplicate it.

## Changesets and releases

A change affecting public behaviour, workspace structure, dependencies, or deployment gets a file in `.changesets/` in the same change that causes it — see [`.changesets/README.md`](.changesets/README.md) for the format. `bump` is the field that matters: the next release's version is the **largest** `bump` among the changesets waiting when `bun run release --apply` runs, so the size of a release is a consequence of what went into it rather than a judgement made at release time from a list of file names.

`bun run audit:rilis` watches the waiting backlog and reddens once it crosses 10 files or 14 days old — a signal that a release is due, not a fault to apologise for. A maintainer then runs `bun run release`, which folds the waiting changesets into `CHANGELOG.md`, bumps `package.json`, and (with `--commit`) tags `vX.Y.Z`.

## Definition of Done

- [ ] The change is scoped to one workspace (or explicitly, deliberately, more than one) — see "Workspace boundaries" above.
- [ ] `bun install` resolves cleanly.
- [ ] `bun test` from the root is green, and — if the change touches `apps/cms/` — `bun run check:cms` is green too.
- [ ] `bun run audit:dokumen`, `bun run audit:rilis`, and `bun run audit:translation` are green.
- [ ] A new governance document, or a change to an existing one, ships its Indonesian mirror in the same change (`bun run docs:i18n:stamp` writes the banner and hash marker).
- [ ] A changeset is written when the change affects public behaviour, workspace structure, dependencies, or deployment.
- [ ] A new env variable read by a root-level script is documented in `.env.example`.
- [ ] A PR that syncs `apps/cms/` from upstream is merged with a merge commit — see "The subtree embed" above.
- [ ] Documentation explaining changed behaviour is updated in the same change — in this repo, documentation is part of the deliverable, not a follow-up.

## Language

English at the bare path is the authoritative source; Indonesian at `<name>.id.md` is the mirror, recording the hash of the English it was translated from. This document's mirror is [`AGENTS.id.md`](AGENTS.id.md).

This repository's own code — `packages/gerbang/`, `tools/`, `tests/`, and their identifiers, comments, and gate/test messages — is written in **English** throughout. This is a deliberate choice for this repo's own new code, made because there is no existing convention here to match and English is the safer default for tooling that CI, Dependabot, and any future contributor's editor all read directly. `apps/cms` carries `ahliweb/awcms`'s own, separate convention as embedded code; this repository does not govern or change it.
