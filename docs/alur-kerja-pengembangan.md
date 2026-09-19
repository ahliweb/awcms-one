🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](alur-kerja-pengembangan.id.md)

# Development workflow

Branching, the homegrown changeset convention, the release cut, and this repository's actual GitHub branch protection — read from the repository's own live settings, not from what was planned, since the two have since diverged (see the note at the end of this section).

## Branching and PRs

One branch per issue, cut from `main`; a PR back into `main`, titled to reference the issue it closes. [`CONTRIBUTING.md`](../CONTRIBUTING.md) names the full contribution flow and the Definition of Done in [`AGENTS.md`](../AGENTS.md#definition-of-done) — this document does not repeat either, only the parts specific to how a change actually lands.

## Branch protection on `main`

Verified directly against this repository's GitHub settings at the time of writing (`gh api repos/ahliweb/awcms-one/branches/main/protection`):

| Setting | Value |
| --- | --- |
| Required status checks | `Check` **and** `check-cms` — both `.github/workflows/ci.yml` jobs |
| Strict (branch must be up to date before merging) | Yes |
| Force pushes | Refused |
| Branch deletion | Refused |
| Required signatures | No |
| Enforce for admins | No |
| Required linear history | No |
| Required conversation resolution | No |

`check-cms` was added to the required list after two green runs on `main`, using the exact command [`docs/deployment.md`](deployment.md) and issue #25's own PR recorded in advance — see "CI: two jobs" below for what each one runs. `delete_branch_on_merge` is enabled repository-wide (also verified via `gh api repos/ahliweb/awcms-one`), so a merged branch is cleaned up automatically regardless of merge strategy. **Squash merges, rebase merges, and ordinary merge commits are all still allowed repository-wide** — branch protection here requires both jobs to pass before a merge, it does not restrict *how* a PR may be merged. The recommendation to disable squash/rebase merges specifically for PRs that run a `git subtree pull` (so the mechanical trap described in [ADR-0001](adr/0001-git-subtree-with-full-history-for-apps-cms.md) is enforced rather than merely documented) is recorded here and in `AGENTS.md`, and has **not** been taken — merging such a PR with anything other than a merge commit remains a rule a reviewer has to remember, not one GitHub enforces.

## Homegrown changesets, not `@changesets/cli`

A change affecting public behaviour, workspace structure, dependencies, or deployment gets a file in [`.changesets/`](../.changesets/README.md) in the same change that causes it: `YYYY-MM-DD-summary-in-kebab-case.md`, with `bump: major | minor | patch` frontmatter chosen while writing the change, because that is the only moment anyone reliably knows the answer. `bun run audit:rilis` watches the waiting backlog and reddens once it crosses 20 files or 14 days old — a signal a release is due, not a fault.

## Wave-based delivery, in this epic

Increment 2 (epic #21) was delivered as a sequence of atomic, single-issue PRs rather than one large change: a first wave of independent foundation work (#22's `check:cms` fix, #24's storefront chrome, #25's local PostgreSQL + seed + `check-cms`), then CMS/storefront pairs that had to serialise against the same module (`commerce` catalog #23 → marketing #26 → orders/customers #29 on the `apps/cms` side; chrome #24 → news #28 → catalog #27 → checkout #30 on the `apps/storefront` side, each depending on the previous one's shared files), with this documentation issue (#31) running last because it is the one thing that has to see every other issue merged before it can describe the tree truthfully. Each PR names its own "Notes/Deviations/Decisions for #31" section specifically so this refresh does not have to re-derive them from the diff.

## The release cut

`bun run release` (a maintainer's action, [`tools/rilis.mjs`](../tools/rilis.mjs)) folds every waiting changeset into `CHANGELOG.md`, using the **largest** `bump` among them to decide the next version — one `minor` beside nine `patch` entries makes the whole release `minor`, so the size of a release is a consequence of what went into it, not a judgement made at release time from a list of file names. `--commit` additionally tags `vX.Y.Z`. Issue #31 (this documentation refresh) does not cut the release itself — see [`.changesets/README.md`](../.changesets/README.md) for the backlog bound and `README.md`'s "Gates" section for `audit:rilis`.

## CI: two jobs — one unconditional, one against a real database

`.github/workflows/ci.yml` defines two jobs.

**`check`** (`name: Check`, `timeout-minutes: 15`) runs on every push to `main`, every pull request, and on manual dispatch, needing no build, no live `apps/cms`, and no database: `bun run check:lockfile`, `bun install --frozen-lockfile`, a storefront type-check step (`bun run check`, which delegates into `apps/storefront`'s own `bun --bun astro check` — this step's `if: hashFiles('apps/storefront/package.json') != ''` guard is a leftover from before that workspace existed and is now always true), the root `bun test`, `audit:dokumen`, `audit:translation`, `audit:graf`, `audit:rilis`, and `bun audit --audit-level=low`. Nothing in this job builds a container image or deploys anything.

**`check-cms`** (`name: check-cms`, `needs: check`, `timeout-minutes: 20`) runs against a real `postgres:18.4` service container (`POSTGRES_USER=awcms`, `POSTGRES_DB=awcms`, port 5432, health-checked with `pg_isready`):

1. `bun install --frozen-lockfile` at the root.
2. `cd apps/cms && DATABASE_URL="" bun run check` — the full ~53-step chain (lint, docs/i18n, every registry/consistency gate, typecheck, `bun test` with every DB-gated suite skipping cleanly, `bun run build`).
3. `DATABASE_URL=postgres://awcms:awcms_ci_password@127.0.0.1:5432/awcms` is written to `$GITHUB_ENV`, then `bun run db:migrate:cms` applies every migration to the fresh service database.
4. `cd apps/cms && bun test tests/integration/ --timeout 60000` — the DB-gated integration suite, now running for real (over 670 tests as of the orders/customers PR).
5. A job-summary step (`if: always()`) greps the trailing `N skip` count from both log files and reports the before/after DB-gated skip count, so a reviewer can see the suites actually ran instead of silently skipping twice.

Both jobs are required status checks on `main` (see "Branch protection on `main`" above) — this closes the gap earlier drafts of this document described: `apps/cms`'s own gate chain, and its RLS/DB coverage, run in THIS repository's CI on every PR, not only locally.

## CI: a third, not-yet-required workflow — `template-init-smoke`

`.github/workflows/template-init-smoke.yml` (issue #138) is a SEPARATE workflow file, not a third job on `ci.yml` — that file is owned by a different, concurrently-landing change (issue #137), and this workflow's own scope asked for a new file rather than a job bolted onto it. It matrices over `toko`/`berita`/`landing` (ADR-0018 D2): for each profile, it runs `bun run template:init --profil <profile> --yes` against its own checkout (including that tool's own trailing gate chain), starts the storefront's stub CMS, runs `SITE_PROFILE=<profile> bun run build` from `apps/storefront`, then a root `bun test`. It is **not yet a required status check** — following the same promotion pattern `check-cms` itself went through (see "Branch protection on `main`" above): added to the required list only after it has run green on `main` for a while.

## Not enforced today

A merge-strategy restriction tied specifically to `apps/cms`-touching PRs (the honour-system rule in [`AGENTS.md`](../AGENTS.md#the-one-rule-that-protects-every-future-sync)). A required review count or code-owner requirement — branch protection here names two required checks and nothing about reviewers. A CI step that builds or publishes a container image, or deploys anywhere — see [`docs/deployment.md`](deployment.md) for what "deploying this repository" means today.
