🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](CONTRIBUTING.id.md)

# Contributing Guide

Thank you for intending to help. Before anything else: this repo re-platforms the borneojek-mart commerce store onto the AWCMS stack ([issue #1](https://github.com/ahliweb/awcms-one/issues/1)), and it embeds `ahliweb/awcms` whole as `apps/cms` via `git subtree`. Read [`AGENTS.md`](AGENTS.md) before touching anything — it is the binding working contract, not a summary, and it carries one rule (the subtree merge-commit requirement) that is easy to break by habit and expensive to recover from.

AI agent contributors: `AGENTS.md` is written for you as much as for a human. Read it first, in full.

## Setting up

```bash
bun --version          # >= 1.3.0, per engines.bun
cp .env.example .env
bun install
bun test                # the root gate suite
```

| Command | Purpose |
| --- | --- |
| `bun install` | Resolves the whole workspace |
| `bun test` | The root gate suite (excludes `apps/cms/**`, which needs a live PostgreSQL — see `bunfig.toml`) |
| `bun run check:lockfile` | Proves `bun.lock` matches every workspace's `package.json` |
| `bun run audit:dokumen` | Dead links, ADR index, named paths, ADR citations, linked counts across this repo's markdown |
| `bun run audit:rilis` | The waiting changeset backlog |
| `bun run audit:translation` | Stale or missing Indonesian mirrors |
| `bun run docs:i18n:stamp` | Writes the language banner + source-hash marker on a document's mirror |
| `bun run check:cms` | `apps/cms`'s own full gate chain — see `apps/cms/AGENTS.md` |
| `bun audit` | Dependency-chain vulnerabilities |
| `bun run release` | Cuts a tagged release from the waiting changesets (a maintainer's action) |

`apps/storefront` does not exist yet ([issue #5](https://github.com/ahliweb/awcms-one/issues/5)); the root `dev`/`build`/`check`/`serve` scripts will delegate into it once it does. Until then there is nothing for them to run.

## The contribution flow

1. **Start from an issue** with a clear scope.
2. **Branch from `main` before touching any file.** Do not commit directly to `main`.
3. **One iteration = one atomic scope**, scoped to one workspace unless the change is genuinely about more than one — see `AGENTS.md`'s "Workspace boundaries". Finish and validate it before moving on.
4. **Update the documentation** in the same iteration when behaviour, workflow, structure, or configuration changes. A governance document ships its Indonesian mirror in the same change (`bun run docs:i18n:stamp`).
5. **Write a changeset** in [`.changesets/`](.changesets/README.md) in the same iteration, not batched up at the end.
6. **Run `bun test`** (and `bun run check:cms` if the change touched `apps/cms/`); both must be clean.
7. **Open a Pull Request** with `Closes #<issue>`. Merge after review and a green CI.
8. **If the PR syncs `apps/cms/` from upstream** (`git subtree pull`), it **must** be merged with a merge commit — never squashed, never rebased. `AGENTS.md`'s "The subtree embed" explains why. This is also now mechanically true of every PR in the repo: squash and rebase merges are disabled repository-wide (issue #149), so a merge commit is the only method GitHub's merge button offers.
9. **When the waiting changeset backlog is due** (`bun run audit:rilis` reddens past 10 files or 14 days), a maintainer runs `bun run release`, which folds the backlog into `CHANGELOG.md` and tags `vX.Y.Z`.

### Branch naming

`feat/<slug>`, `fix/<slug>`, `docs/<topic>`, `chore/<slug>`, `translation/<locale>-<slug>`.

### Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <summary>`.

| Type | For |
| --- | --- |
| `feat` | A new capability |
| `fix` | Correcting wrong behaviour |
| `translation` | Filling in or editing a locale mirror |
| `docs` | Documentation |
| `chore` | Dependencies, configuration, tooling |
| `refactor` | A change of code shape with no change of behaviour |

The commit body explains **why**, rather than repeating the diff.

## Rules that are not negotiable

Full detail and reasoning: [`AGENTS.md`](AGENTS.md). The ones most often broken without anyone noticing — because breaking them never fails a build on its own:

- **A `git subtree pull` PR is merged with a merge commit, never squashed or rebased.**
- **Nothing outside `apps/cms/` depends on its internals** — only its public API, once `apps/storefront` exists to call it.
- **A root-level gate stays workspace-agnostic.** A check specific to one workspace belongs in that workspace's own gate chain.
- **`bun.lock` is regenerated in full**, never hand-edited: `rm -rf node_modules bun.lock && bun install`.

## Translation

This repo's governance documents follow English-source, Indonesian-mirror: the bare path (`README.md`) is authoritative, `<name>.id.md` is the mirror, and `bun run audit:translation` fails when a mirror's recorded hash no longer matches its source. `bun run docs:i18n:stamp` writes the banner and the marker after you translate by hand — it does not translate for you.

This repo's own code (`packages/gerbang/`, `tools/`, `tests/`) is written in English and is not mirrored; see `AGENTS.md`'s "Language" section. `apps/cms` carries its own separate translation convention as embedded `ahliweb/awcms` code.

## Definition of Done

The full and binding list is in [`AGENTS.md`](AGENTS.md#definition-of-done). In brief:

- [ ] The atomic scope is met; no unrelated changes hitched a ride.
- [ ] `bun test` is green (and `bun run check:cms` too, if `apps/cms/` was touched).
- [ ] `bun run audit:dokumen`, `bun run audit:rilis`, and `bun run audit:translation` are green.
- [ ] A changeset is written when the change affects public behaviour, structure, dependencies, or deployment.
- [ ] Documentation explaining the changed behaviour is updated with it, mirror included.

## Reporting problems

- Security vulnerabilities: [`SECURITY.md`](SECURITY.md) — do **not** open a public issue.
- Bugs and questions: [`SUPPORT.md`](SUPPORT.md).
- Contributor behaviour: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
