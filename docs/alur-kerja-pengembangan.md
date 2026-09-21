🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](alur-kerja-pengembangan.id.md)

# Development workflow

Branching, the homegrown changeset convention, the release cut, and this repository's actual GitHub branch protection — read from the repository's own live settings, not from what was planned, since the two have since diverged (see the note at the end of this section).

## Branching and PRs

One branch per issue, cut from `main`; a PR back into `main`, titled to reference the issue it closes. [`CONTRIBUTING.md`](../CONTRIBUTING.md) names the full contribution flow and the Definition of Done in [`AGENTS.md`](../AGENTS.md#definition-of-done) — this document does not repeat either, only the parts specific to how a change actually lands.

## Branch protection on `main`

Verified directly against this repository's GitHub settings at the time of writing (`gh api repos/ahliweb/awcms-one/branches/main/protection`):

| Setting | Value |
| --- | --- |
| Required status checks | `Check (toko)`, `Check (berita)`, `Check (landing)` **and** `check-cms` — since increment 6 (issue #137) the storefront `Check` job is a 3-leg matrix, all four `.github/workflows/ci.yml` legs/jobs are required |
| Strict (branch must be up to date before merging) | Yes |
| Force pushes | Refused |
| Branch deletion | Refused |
| Required signatures | No |
| Enforce for admins | No |
| Required linear history | No |
| Required conversation resolution | No |

`check-cms` was added to the required list after two green runs on `main`, using the exact command [`docs/deployment.md`](deployment.md) and issue #25's own PR recorded in advance — see "CI: two jobs" below for what each one runs. `delete_branch_on_merge` is enabled repository-wide (also verified via `gh api repos/ahliweb/awcms-one`), so a merged branch is cleaned up automatically regardless of merge strategy.

**Squash and rebase merges are now disabled repository-wide (issue #149).** Verified via `gh api repos/ahliweb/awcms-one`: `allow_merge_commit=true`, `allow_squash_merge=false`, `allow_rebase_merge=false`. Branch protection (the table above) still only names required status checks — it does not itself restrict merge method, and GitHub cannot restrict a merge method to PRs touching one path — so the mechanical trap described in [ADR-0001](adr/0001-git-subtree-with-full-history-for-apps-cms.md) (a subtree-sync PR merged with anything but a merge commit) is now closed the only way GitHub allows: repository-wide. The operational consequence for an ordinary PR unrelated to `apps/cms` is the same as for a subtree sync — a merge commit is the only option the merge button offers; `delete_branch_on_merge` still cleans up the branch regardless. **Required linear history remains disabled**, deliberately: it would conflict with the full-history subtree model, which depends on real merge commits rather than a linear, rebased history.

## Homegrown changesets, not `@changesets/cli`

A change affecting public behaviour, workspace structure, dependencies, or deployment gets a file in [`.changesets/`](../.changesets/README.md) in the same change that causes it: `YYYY-MM-DD-summary-in-kebab-case.md`, with `bump: major | minor | patch` frontmatter chosen while writing the change, because that is the only moment anyone reliably knows the answer. `bun run audit:rilis` watches the waiting backlog and reddens once it crosses 20 files or 14 days old — a signal a release is due, not a fault.

## Wave-based delivery, in this epic

Increment 2 (epic #21) was delivered as a sequence of atomic, single-issue PRs rather than one large change: a first wave of independent foundation work (#22's `check:cms` fix, #24's storefront chrome, #25's local PostgreSQL + seed + `check-cms`), then CMS/storefront pairs that had to serialise against the same module (`commerce` catalog #23 → marketing #26 → orders/customers #29 on the `apps/cms` side; chrome #24 → news #28 → catalog #27 → checkout #30 on the `apps/storefront` side, each depending on the previous one's shared files), with this documentation issue (#31) running last because it is the one thing that has to see every other issue merged before it can describe the tree truthfully. Each PR names its own "Notes/Deviations/Decisions for #31" section specifically so this refresh does not have to re-derive them from the diff.

## The release cut

`bun run release` (a maintainer's action, [`tools/rilis.mjs`](../tools/rilis.mjs)) folds every waiting changeset into `CHANGELOG.md`, using the **largest** `bump` among them to decide the next version — one `minor` beside nine `patch` entries makes the whole release `minor`, so the size of a release is a consequence of what went into it, not a judgement made at release time from a list of file names. `--commit` additionally tags `vX.Y.Z`. Issue #31 (this documentation refresh) does not cut the release itself — see [`.changesets/README.md`](../.changesets/README.md) for the backlog bound and `README.md`'s "Gates" section for `audit:rilis`.

## CI: two jobs — one unconditional, one against a real database

`.github/workflows/ci.yml` defines two jobs.

**`check`** (`name: Check`, `timeout-minutes: 15`) runs on every push to `main`, every pull request, and on manual dispatch, needing no build, no live `apps/cms`, and no database. Since increment 6 (issue #137, [ADR-0018 D7](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md)), it is a **3-leg matrix** (`strategy.matrix.profile: [toko, berita, landing]`, `fail-fast: false`) — GitHub displays each leg as `Check (toko)`, `Check (berita)`, `Check (landing)`. Every leg runs `bun run check:lockfile`, `bun install --frozen-lockfile`, then `SITE_PROFILE=<leg> bun run check` (a storefront type-check that covers `src/profil/**` regardless of which group is active) and `cd apps/storefront && SITE_PROFILE=<leg> bun test tests/profil-build-smoke.test.ts tests/profil-routes.test.ts` — that leg's own build against the stub CMS, proving the excluded page groups are genuinely absent from `dist/` and the sitemaps. The root `bun test`, `audit:dokumen`, `audit:translation`, `audit:graf`, `audit:rilis`, and `bun audit --audit-level=low` are profile-independent, so they run **once, on the `toko` leg only** (`if: matrix.profile == 'toko'`), with no `SITE_PROFILE` set — in that step, `profil-build-smoke` itself builds all three profiles, so the `toko` leg alone still proves the whole matrix. Nothing in this job builds a container image or deploys anything.

**`check-cms`** (`name: check-cms`, `needs: check`, `timeout-minutes: 20`) runs against a real `postgres:18.4` service container (`POSTGRES_USER=awcms`, `POSTGRES_DB=awcms`, port 5432, health-checked with `pg_isready`):

1. `bun install --frozen-lockfile` at the root.
2. `cd apps/cms && DATABASE_URL="" bun run check` — the full ~53-step chain (lint, docs/i18n, every registry/consistency gate, typecheck, `bun test` with every DB-gated suite skipping cleanly, `bun run build`).
3. `DATABASE_URL=postgres://awcms:awcms_ci_password@127.0.0.1:5432/awcms` is written to `$GITHUB_ENV`, then `bun run db:migrate:cms` applies every migration to the fresh service database.
4. `cd apps/cms && bun test tests/integration/ --timeout 60000` — the DB-gated integration suite, now running for real (over 670 tests as of the orders/customers PR).
5. A job-summary step (`if: always()`) greps the trailing `N skip` count from both log files and reports the before/after DB-gated skip count, so a reviewer can see the suites actually ran instead of silently skipping twice.

All three `Check` legs and `check-cms` are required status checks on `main` (see "Branch protection on `main`" above) — this closes the gap earlier drafts of this document described: `apps/cms`'s own gate chain, and its RLS/DB coverage, run in THIS repository's CI on every PR, not only locally.

## CI: a third, not-yet-required workflow — `template-init-smoke`

`.github/workflows/template-init-smoke.yml` (issue #138) is a SEPARATE workflow file, not a third job on `ci.yml` — that file is owned by a different, since-landed change (issue #137), and this workflow's own scope asked for a new file rather than a job bolted onto it. It is **not yet a required status check** — following the same promotion pattern `check-cms` itself went through (see "Branch protection on `main`" above): added to the required list only after it has run green on `main` for a while, and only after at least three consecutive runs against the same code state have all come back green (issue #147's own acceptance criterion — see below for why that bar exists).

**Shape since issue #147.** The original workflow ran a full root `bun test` — including every storefront build-smoke test, each of which starts its own stub CMS and its own `astro build` — once per matrix leg, so three copies of that suite competed for the same two-core runner's CPU/IO at once. Two consecutive `main` runs each failed a DIFFERENT leg's `Root bun test` step on a DIFFERENT build-smoke test's stub-start deadline — contention, not a real profile defect, but exactly the kind of intermittent red that makes a "required" status untrustworthy. The fix is a responsibility split, not a bigger timeout:

- **The `template-init-smoke` matrix job** (`toko`/`berita`/`landing`, ADR-0018 D2) still runs the real thing per profile: `bun run template:init --profil <profile> --yes` against its own checkout (`TEMPLATE_INIT_TEST_SCOPE=root` keeps that tool's own trailing `bun test` scoped to the root gate tests, not the full workspace), starts the storefront's stub CMS (its PID written to a file so a later step can always find and kill it), runs `SITE_PROFILE=<profile> bun run build` from `apps/storefront`, then `bun scripts/assert-profil-dist.ts` — a deterministic check over that SAME already-built `dist/client` (excluded groups' files/directories absent, active groups' present, no sitemap entry or built-page link crossing into an excluded route), derived from `apps/storefront/src/config/profil.ts` the same way `apps/storefront/tests/profil-build-smoke.test.ts`/`apps/storefront/tests/profil-routes.test.ts` are, but without triggering a SECOND build the way running those two test files again would. A trailing `if: always()` step kills the stub's PID and, `if: failure()`, prints `/tmp/stub-awcms.log`.
- **A separate `root-suite` job**, with no matrix, runs `template:init --profil toko` (again `TEMPLATE_INIT_TEST_SCOPE=root`) and then the full `bun test` exactly ONCE, on its own runner with nothing else competing for CPU. This is now the only place in the whole workflow the full derived-repository suite runs.

Two details keep the workflow's own gate chain from failing on itself. First, the stub-CMS readiness probe polls **with a bearer token** (`curl -sf -H "Authorization: Bearer stub" http://localhost:4310/api/v1/commerce/products`) — the stub answers `401` to an unauthenticated request on purpose (`apps/storefront/scripts/stub-awcms.mjs`), and a plain `curl -f` would read that `401` as "not up yet" forever. Second, `tests/template-init.test.mjs` skips itself the moment it detects it is no longer running inside `awcms-one` (`package.json.name !== "awcms-one"`) — without that guard, a `template:init` run's own trailing `bun test` would discover and re-run its own test file inside the very repository it just initialised, whose full-run tests then try to build another temporary copy from `git ls-files`, which still lists paths that run's own removal step already `unlinkSync`'d (never `git rm`'d), throwing `ENOENT` on every one.

## Seeding a profile locally

`tools/seed-cms.ts` (`bun run db:seed:cms` / `bun run db:seed:cms:profil <name>`, issue #139) seeds an already-migrated `apps/cms` with one of four profiles: the neutral, fictional `toko`/`berita`/`landing` sample sets under `tools/seed-data/profil/**`, or `contoh:borneojek-mart` (the default in THIS repository — `template:init`, issue #138, rewrites that default to the deployment's own chosen profile in a derived repo, see [`docs/template.md`](template.md)) — the live reference deployment's own full content under `tools/seed-data/contoh/borneojek-mart/**`. See [`docs/template.md`](template.md)'s "Sample seeds" section for what each profile contains.

**Never seed a neutral profile into this repository's own shared local dev database** (`postgres://awcms:awcms_dev_password@localhost:5433/awcms`, `bun run db:up`'s default) — it already holds this repository's own BjekMart tenant, and `POST /api/v1/setup/initialize` is a once-per-database singleton lock (see `tools/seed-cms.ts`'s own `ensureTenantAndSession`): a second `--profil` run against that same database fails the bootstrap step rather than creating a second tenant. Use `--dry-run` instead to see what a profile WOULD seed (it validates the profile's JSON and prints an inventory summary, making no network call at all, so it needs no running `apps/cms` and is always safe to run), or point `AWCMS_BASE_URL`/`POSTGRES_*` at a disposable database when a real run against a profile is actually needed.

## Not enforced today

A required review count or code-owner requirement — branch protection here names required status checks and nothing about reviewers. A CI step that builds or publishes a container image, or deploys anywhere — see [`docs/deployment.md`](deployment.md) for what "deploying this repository" means today. (The merge-strategy restriction for `apps/cms`-touching PRs, previously listed here as honour-system only, is now mechanically enforced repository-wide — see "Branch protection on `main`" above — issue #149.)
