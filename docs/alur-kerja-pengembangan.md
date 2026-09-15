🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](alur-kerja-pengembangan.id.md)

# Development workflow

Branching, the homegrown changeset convention, the release cut, and this repository's actual GitHub branch protection — read from the repository's own live settings, not from what was planned, since the two have since diverged (see the note at the end of this section).

## Branching and PRs

One branch per issue, cut from `main`; a PR back into `main`, titled to reference the issue it closes. [`CONTRIBUTING.md`](../CONTRIBUTING.md) names the full contribution flow and the Definition of Done in [`AGENTS.md`](../AGENTS.md#definition-of-done) — this document does not repeat either, only the parts specific to how a change actually lands.

## Branch protection on `main`

Verified directly against this repository's GitHub settings at the time of writing (`gh api repos/ahliweb/awcms-one/branches/main/protection`):

| Setting | Value |
| --- | --- |
| Required status check | `Check` (the single job `.github/workflows/ci.yml` defines) |
| Strict (branch must be up to date before merging) | Yes |
| Force pushes | Refused |
| Branch deletion | Refused |
| Required signatures | No |
| Enforce for admins | No |
| Required linear history | No |
| Required conversation resolution | No |

`delete_branch_on_merge` is enabled repository-wide (also verified via `gh api repos/ahliweb/awcms-one`), so a merged branch is cleaned up automatically regardless of merge strategy. **Squash merges, rebase merges, and ordinary merge commits are all still allowed repository-wide** — branch protection here requires the `Check` job to pass before a merge, it does not restrict *how* a PR may be merged. The recommendation to disable squash/rebase merges specifically for PRs that run a `git subtree pull` (so the mechanical trap described in [ADR-0001](adr/0001-git-subtree-with-full-history-for-apps-cms.md) is enforced rather than merely documented) is recorded here and in `AGENTS.md`, and has **not** been taken — merging such a PR with anything other than a merge commit remains a rule a reviewer has to remember, not one GitHub enforces.

## Homegrown changesets, not `@changesets/cli`

A change affecting public behaviour, workspace structure, dependencies, or deployment gets a file in [`.changesets/`](../.changesets/README.md) in the same change that causes it: `YYYY-MM-DD-summary-in-kebab-case.md`, with `bump: major | minor | patch` frontmatter chosen while writing the change, because that is the only moment anyone reliably knows the answer. `bun run audit:rilis` watches the waiting backlog and reddens once it crosses 10 files or 14 days old — a signal a release is due, not a fault. At the time of writing, 5 changesets are waiting, the oldest dated the day this document was written.

## The release cut

`bun run release` (a maintainer's action, [`tools/rilis.mjs`](../tools/rilis.mjs)) folds every waiting changeset into `CHANGELOG.md`, using the **largest** `bump` among them to decide the next version — one `minor` beside nine `patch` entries makes the whole release `minor`, so the size of a release is a consequence of what went into it, not a judgement made at release time from a list of file names. `--commit` additionally tags `vX.Y.Z`.

## CI: one job, everything unconditional

`.github/workflows/ci.yml` defines a single job, `Check`, running on every push to `main`, every pull request, and on manual dispatch. Every step in it needs no build, no live `apps/cms`, and no database — the lockfile check, `bun install --frozen-lockfile`, a storefront type-check step that self-activates once `apps/storefront/package.json` exists (it does, as of this document), the root `bun test`, `audit:dokumen`, `audit:translation`, `audit:graf`, `audit:rilis`, and `bun audit --audit-level=low`. Nothing in this workflow builds a container image, deploys anything, or runs `apps/cms`'s own gate chain (`check:cms`) — see [`docs/deployment.md`](deployment.md) and [`docs/pengujian.md`](pengujian.md) for why the latter needs a database this CI job does not provision.

## Not enforced today

A merge-strategy restriction tied specifically to `apps/cms`-touching PRs (the honour-system rule above). A required review count or code-owner requirement — branch protection here names one required check and nothing about reviewers. `check:cms` (or any `apps/cms` gate) running in this repository's own CI.
