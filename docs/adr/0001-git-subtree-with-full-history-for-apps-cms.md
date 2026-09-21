🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0001-git-subtree-with-full-history-for-apps-cms.id.md)

# ADR-0001 — `apps/cms` is `ahliweb/awcms`, embedded via `git subtree` with full history

- **Status:** Accepted
- **Date:** 15 September 2026
- **Decision maker:** ahliweb
- **Related:** [issue #1](https://github.com/ahliweb/awcms-one/issues/1) (the re-platform epic); [issue #2](https://github.com/ahliweb/awcms-one/issues/2) (this embed); [`AGENTS.md`](../../AGENTS.md#the-subtree-embed) (the sync mechanics and the one rule that protects them); [`knowledge/curated/ownership-boundaries.md`](../../knowledge/curated/ownership-boundaries.md)

## Context

`commerce` — the module this platform actually needs (issue #4) — depends on `awcms` shared infrastructure that has no standalone package: `withTenant` (the RLS tenant context), `authorizeInTransaction` (RBAC/ABAC), `appendDomainEvent` (the transactional outbox), `recordAuditEvent`, `_shared/module-contract`'s `defineModule`, `getDatabaseClient`, the SQL migration runner, and `_shared/api-response`. None of it is published as a package. `commerce` cannot stand on its own without re-inventing all of that, which `ahliweb/media-lenterakalteng` — the model this repository's own workspace layout and gates are adapted from — already did once by embedding `awcms` whole rather than depending on it.

Three ways to bring that tree into this repository were on the table:

| | full history (`git subtree`) | `--squash` | vendored copy |
| --- | --- | --- | --- |
| Repo size | +~70 MB packed (1,530 commits carried as ancestry) | working tree only | working tree only |
| `git blame` into `apps/cms` | complete | lost | lost |
| Future `git subtree pull` sync | real merge base, low friction | synthetic base, conflict-prone | manual diff forever |
| Matches `media-lenterakalteng` | yes (that repo's own `.git` is 123 MB) | no | no |

`apps/cms` is code this team actively patches and debugs going forward — `commerce` itself already touches 29 of its files (see Consequences) — so losing `git blame` there is a real, ongoing maintainability cost, not a one-time inconvenience. And fidelity of the upstream sync was the entire reason to choose "embed" over "depend on a package" in the first place; `--squash` or a vendored copy would each buy that decision back at a discount that erodes on the very first sync.

## Decision

`apps/cms` is `ahliweb/awcms` v10.3.0 (commit `749404d4963af1dfaf8a5cf8b229299b29556ce2`), embedded whole via `git subtree add --prefix=apps/cms`, with **no `--squash`** — upstream's full commit history is retained as ancestry. The upstream remote is named `awcms`, fetching only `main` (`+refs/heads/main:refs/remotes/awcms/main` — adding it unnarrowed pulled in seven Dependabot branches the first time, which is exactly the mess a subtree sync never needs). Sync going forward is `git subtree pull --prefix=apps/cms awcms main`.

**The one rule that protects every future sync: a PR that runs `git subtree pull` must be merged with a merge commit, never squashed, never rebased.** `git subtree pull` works by finding the merge base between this repo's history and upstream's and replaying upstream's commits on top of it. Squashing that pull collapses every replayed commit into one synthetic commit git did not create through a merge, which destroys the merge base the *next* pull needs — and the damage is invisible at the time: the squashed PR merges cleanly, CI is green, and the break only surfaces the next time anyone tries to sync, far from the commit that caused it. Nothing in this repository's branch protection stops this mechanically today (GitHub's required check is named `Check`, not a merge-strategy restriction — see [`docs/alur-kerja-pengembangan.md`](../alur-kerja-pengembangan.md)); the guard is this paragraph, read before the merge button is clicked, recorded in three places (`AGENTS.md`, this ADR, and [`knowledge/curated/ownership-boundaries.md`](../../knowledge/curated/ownership-boundaries.md)) precisely because it is not yet enforced by a fourth.

`apps/cms`'s own source stays upstream's tree. Work specific to this platform — the `commerce` module — is additive inside `apps/cms`'s own module directory, following its own module-admission discipline (`apps/cms/AGENTS.md`), never a local patch to code the next `git subtree pull` would conflict with or silently overwrite.

**Status update (2026-09-21, issue #149):** the paragraph above records the decision as it stood on 15 September 2026, when nothing in this repository's settings stopped a squash or rebase merge mechanically. That gap is now closed: repository merge settings are `allow_merge_commit=true`, `allow_squash_merge=false`, `allow_rebase_merge=false` (verified via `gh api repos/ahliweb/awcms-one`), so a merge commit is the only method GitHub's merge button offers, for this PR class and every other. Required linear history remains deliberately disabled, since it would conflict with the full-history subtree model this ADR chose. See [`AGENTS.md`](../../AGENTS.md#the-one-rule-that-protects-every-future-sync) and [`docs/alur-kerja-pengembangan.md`](../alur-kerja-pengembangan.md) for the current state.

## Consequences

- **Admitting `commerce` alone modified 29 files outside the module's own directory** (verified: `git show --numstat 733ee996 -- apps/cms/`, filtered to paths outside `src/modules/commerce/`, `sql/153`–`155`, the module's own API routes, its OpenAPI fragment, its admin screen, and its own domain test). Three groups: **registries** a new module must join (`apps/cms/src/modules/index.ts`, `domain-event-runtime/domain/event-type-registry.ts`, `module-management/domain/sidebar-menu.ts`, `apps/cms/scripts/admin-screen-coverage-ledger.ts`, `apps/cms/scripts/security-readiness.ts`, `asyncapi/awcms-domain-events.asyncapi.yaml`, `openapi/awcms-public-api.src.yaml`); **generated inventories** that re-derive from source (`openapi/awcms-public-api.openapi.yaml`, `apps/cms/docs/awcms/api-reference.md`, `apps/cms/docs/awcms/repo-inventory.md`, `apps/cms/docs/awcms/module-composition-inventory.json`, `apps/cms/docs/awcms/work-class-registry.generated.json`, `apps/cms/docs/PROJECT_STATE.md`, `locales/en.po`/`id.po`, `apps/cms/src/lib/i18n/catalogs/id.generated.ts`); and small **module-count bumps** in prose documentation (`apps/cms/docs/ARCHITECTURE.md`, `apps/cms/docs/awcms/13_final_master_index_traceability.md`, `apps/cms/docs/awcms/alur-pengembangan-mini-first.md`, `.claude/skills/README.md`, `.claude/skills/awcms-new-module/SKILL.md`, plus their `.id.md` mirrors) and `apps/cms/tests/openapi-bundle.test.ts`.
- **After every subtree sync, the generators must be re-run** (`bun run check` inside `apps/cms` names each one) rather than hand-merged — the generated files above are exactly the class of file a merge conflict resolution is most likely to get wrong by editing instead of regenerating.
- **Upstreaming `commerce` into `ahliweb/awcms` itself, so it arrives here via ordinary sync instead of living as a local addition, is a family-platform decision that has not been taken.** It would remove the 29-file admission cost for every *future* module this platform adds, at the cost of `commerce` becoming a generic, reusable `awcms` module rather than this platform's own. Recorded here so it is not silently assumed either way.
- `.git` grew to accommodate 1,530 upstream commits and 2,591 files in one embedding commit — the price named up front in exchange for keeping `git subtree pull` available at all.
