---
bump: minor
type: structure
impact: public
---

# Local/server CI runner with exact-SHA commit statuses (#225 part 1)

The owner decided to move this workspace's CI off GitHub Actions entirely. This is part 1: `tools/ci/` reproduces every leg `.github/workflows/{ci,template-init-smoke,e2e,codeql}.yml` runs today, one-to-one, as twelve `local-ci/*` commit-status contexts reported against the exact SHA each leg ran at — see [ADR-0021](../docs/adr/0021-zero-github-actions-local-ci-with-exact-sha-statuses.md).

- `bun run ci` runs all twelve legs against HEAD inside a disposable `git worktree`, never mutating the developer's own checkout; `bun run ci:pr -- <n>` does the same for a pull request, refusing fork PRs unless `--allow-fork` is given explicitly.
- `bun run ci:watch` polls open PRs and skips any (repo, PR, head SHA, CI-definition version) already recorded; `tools/ci/systemd/` documents the systemd user timer that runs it every 10 minutes (not installed by this change).
- Every leg fails closed if the running Bun does not match the root `package.json`'s pin; every log/evidence file is redacted for tokens and DSN passwords before it touches disk.
- The `local-ci/security` leg runs the CodeQL CLI, gitleaks (pinned by digest), and `bun audit`, checked against a committed `tools/ci/security-baseline.json` seeded with this repository's nine already-dismissed GitHub code-scanning alerts (quoting each one's own dismissal reason) plus one further entry for a genuine new-code finding this leg's own first run surfaced in `tools/ci/lib/lock.ts`.
- `.github/workflows/*.yml` are **not removed** by this change — see the ADR's "Migration sequence" for why branch protection moves to `local-ci/*` first, in a follow-up PR.
