🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0021-zero-github-actions-local-ci-with-exact-sha-statuses.id.md)

# ADR-0021 — Zero GitHub Actions: local CI with exact-SHA commit statuses

- **Status:** Accepted
- **Date:** 26 September 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0019](0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md) (the `codeql`/`e2e`/`check-cms` gates this ADR replaces the running surface of, not their intent); [ADR-0020](0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md) (a separate, non-required workflow this ADR does not touch); AGENTS.md's "The gates" (the twelve required status checks this ADR's part 1 reproduces 1:1); issue [#225](https://github.com/ahliweb/awcms-one/issues/225)

## Context

Every gate this repository runs today — `Check (toko|berita|landing)`, `check-cms`, all four `template-init-smoke` legs, all three `e2e` legs, and `codeql`'s `Analyze (javascript-typescript)` — runs on GitHub-hosted Actions runners, defined in `.github/workflows/{ci,template-init-smoke,e2e,codeql}.yml`. The owner decided to move this workspace's CI off GitHub Actions entirely: **zero GitHub Actions**, running the same checks on infrastructure this project controls directly instead.

Stated honestly, up front: this is not a cost decision. GitHub-hosted Actions runners are free for a public repository — `ahliweb/awcms-one` has no minute quota to exceed and no bill this change reduces. The reasons are elsewhere: running CI on infrastructure under this project's own control, rather than a shared multi-tenant hosted runner fleet, and reporting results with the precision an exact commit SHA gives rather than trusting a workflow run's own idea of "which commit this was for."

Two things follow directly from "zero Actions", and this ADR is explicit about both because they are easy to reach for as a middle ground and neither is chosen here:

- **Not a self-hosted Actions runner.** `actions/runner` registered against this repository would still be a GitHub Actions workflow, defined in `.github/workflows/*.yml`, subject to Actions' own trigger model, its own log format, its own required-check semantics — only the *compute* would have moved. "Zero Actions" means the workflow files themselves go away (this PR keeps them, deliberately — see "Migration sequence" below — but the mechanism that will eventually replace them entirely is not Actions-shaped at all).
- **Not GHAS-equivalent.** GitHub Advanced Security's code scanning, its alert lifecycle (dismiss/reopen, auto-triage), Dependabot's own PR-opening automation, and secret-scanning push protection are GitHub product surfaces this change does not reproduce and does not attempt to. The `security` leg below is deliberately scoped and its blind spots are stated, not hidden.

## Decision

### D1 — `tools/ci/` is the local/server CI runner; twelve `local-ci/*` contexts (Option A)

A new Bun/TypeScript tool, `tools/ci/`, reproduces exactly what `.github/workflows/{ci,template-init-smoke,e2e,codeql}.yml` do today, leg for leg, as a **flat 1:1 mapping** between what used to be a required Actions status check and a `local-ci/*` commit-status context (Option A, rejected alternatives below):

| Former required check | `local-ci/*` context |
| --- | --- |
| `Check (toko)` | `local-ci/check-toko` |
| `Check (berita)` | `local-ci/check-berita` |
| `Check (landing)` | `local-ci/check-landing` |
| `check-cms` | `local-ci/check-cms` |
| `template-init-smoke (toko)` | `local-ci/template-toko` |
| `template-init-smoke (berita)` | `local-ci/template-berita` |
| `template-init-smoke (landing)` | `local-ci/template-landing` |
| `template-init-smoke (root-suite)` | `local-ci/template-root` |
| `e2e (toko)` | `local-ci/e2e-toko` |
| `e2e (berita)` | `local-ci/e2e-berita` |
| `e2e (landing)` | `local-ci/e2e-landing` |
| `Analyze (javascript-typescript)` | `local-ci/security` |

The table lives once, exported from `tools/ci/legs.ts` (`LEGS`/`LEG_CONTEXTS`), so a later branch-protection migration and this repo's own docs read it rather than re-typing twelve names in a second place.

### D2 — Exact-SHA reporting: a disposable worktree, never the developer's own checkout

`bun run ci` resolves the current checkout's HEAD commit, creates a **disposable `git worktree`** of that exact SHA, and runs every leg inside it — never mutating the caller's own working tree, because several legs (`template:init` chief among them) rewrite files in place. `bun run ci:pr -- <n>` does the same after fetching `refs/pull/<n>/head` and resolving *that* exact SHA. Every commit status is posted against the SHA the code actually ran at, via `POST /repos/{owner}/{repo}/statuses/{sha}` — the same mechanism a GitHub App or any third-party CI integration uses, and the reason "Option A" (a flat context list) is legible to branch protection: GitHub's own required-status-check UI has never distinguished an Actions job from any other status-API poster.

### D3 — The status credential

A dedicated fine-grained personal access token or GitHub App installation token, scoped to `statuses:write` (and `security-events:write` only if `--upload-sarif` is used), is the recommended credential — `LOCAL_CI_GITHUB_TOKEN`. Falling back to `gh auth token` (the operator's own logged-in `gh` CLI session) is supported so a first run needs no separate setup, but it is not the recommended steady state: a personal `gh` session's token is scoped to everything that account can do, wider than local CI needs. Never printed — `tools/ci/lib/statuses.ts` and every other module here name only an HTTP status code and response body on failure, and the shared redaction helper (`tools/ci/lib/redact.ts`) scrubs any bearer token, DSN password, or GitHub-token-shaped string out of every log/evidence file before it is written.

### D4 — The fork-PR policy: refuse by default, `--allow-fork` to override

`bun run ci:pr` refuses to run a pull request's code when it is from a fork, unless `--allow-fork` is passed explicitly. This is the same risk GitHub's own documentation warns about for self-hosted Actions runners, restated for a locally-run CI: checking out and executing a PR's code gives that code a shell on infrastructure this project controls, and a fork PR is by definition code from someone without write access. `--allow-fork` exists for the maintainer who has already read the diff and accepts the risk for one specific PR — it is never a standing setting.

### D5 — The Bun pin, enforced fail-closed, not by a `setup-bun` step

Actions pinned Bun for every job via `oven-sh/setup-bun`'s `bun-version`. Local CI has no such step — it runs on whatever Bun is already on the host's PATH — so `tools/ci/lib/bun-pin.ts` reads the exact pin from the root `package.json`'s `packageManager` and refuses to run any leg at all when the Bun actually running does not match it, with a message naming both versions. Pure and side-effect-free by construction, so `tests/local-ci-bun-pin.test.mjs` exercises it with fixture strings today, and a future `tests/versi-toolchain.test.mjs` update can point at the same function instead of duplicating the comparison.

### D6 — Evidence, state, and retention live outside the repository

Locks, recorded per-(repo, PR, head SHA, CI-definition version) results, and leg evidence (logs, SARIF, Playwright reports/screenshots) live under `${XDG_STATE_HOME:-~/.local/state}/awcms-one-ci/` — never inside the repository, and never inside the disposable worktree a run creates (which is removed when the run ends, unless `--keep`). The "CI-definition version" is a content hash of `tools/ci/**` plus the root `package.json`/`bun.lock` — a leg's own logic, or what it installs, changing invalidates every previously recorded result for a commit, so the watcher (D8) never trusts a result produced under different logic as "already checked."

### D7 — The security leg's scope and its honest blind spots

`local-ci/security` runs the CodeQL CLI directly (`javascript-typescript`, `build-mode: none`, the `security-extended` query suite, this repo's own already-committed `.github/codeql/codeql-config.yml`, left exactly where it is), gitleaks (a container image **pinned by digest**, never a moving tag), and `bun audit`. It fails closed on an analysis/extraction error, and fails on any SARIF result with `security-severity >= 7.0` unless that exact `(ruleId, path)` pair is listed in the committed baseline, `tools/ci/security-baseline.json`. This file is seeded, not empty: running the CLI locally for real (this PR's own verification step) reproduced exactly the nine `>= 7.0` findings this repository's GitHub code-scanning alerts #5–#11 already carry, every one already `dismissed` there with a real reviewer's reason (`false positive`, `won't fix`, or `used in tests` — `gh api repos/ahliweb/awcms-one/code-scanning/alerts`). The baseline restates those nine existing decisions, quoting each alert's own dismissal comment, rather than asking a maintainer to re-triage a finding this repository already closed once. A tenth entry was added the same day by the same process for `tools/ci/lib/lock.ts` itself — `js/file-system-race` on the cross-run watch lock's `existsSync`/`unlinkSync`/`openSync` sequence, the exact same "single-operator local tooling, no trust boundary between check and write" reasoning already accepted for `tools/rilis.mjs`/`tools/knowledge-graph-update.mjs`, triaged rather than silenced because this leg's own first real run surfaced it as a genuine (if familiar-shaped) finding in NEW code. The baseline grows further only this way — a maintainer explicitly triaging a finding and recording why it is accepted, never as a way to silence one that has not been looked at. `--upload-sarif` optionally posts the resulting SARIF to GitHub's own code-scanning endpoint so the Security tab keeps working during the migration window; the leg's own pass/fail never depends on that upload succeeding.

This is deliberately not GHAS-equivalent, and the blind spots are named rather than left implicit: `.astro` files have no CodeQL extractor (the same limit `.github/workflows/codeql.yml` already stated); the CLI's raw path-exclusion handling does not reproduce `codeql-action`'s own compiled query-suite filtering of `codeql-config.yml`'s `paths-ignore` byte-for-byte; and the Security tab's own alert lifecycle (dismiss/reopen state) has no local equivalent — `--upload-sarif` feeds that surface but this leg does not read it back.

### D8 — `bun run ci:watch`, one polling pass at a time

`bun run ci:watch` lists open PRs, skips any whose (repo, PR, head SHA, CI-definition version) already has a recorded result (D6), and runs+reports the rest — holding an O_EXCL lock file for its whole pass so two invocations never overlap. `tools/ci/systemd/awcms-one-ci-watch.{service,timer}` are USER unit files (no root) an operator installs by hand to fire this every 10 minutes; this change documents installing them and does not install them itself.

## Migration sequence

This PR (#225 part 1) is deliberately incomplete on its own: `.github/workflows/*.yml` are **not removed** here, and branch protection is **not touched** here. The sequence, in order:

1. **This PR** — `tools/ci/` exists, is unit-tested, and has been run for real (`bun run ci`) against this repository's own HEAD, all twelve legs green.
2. **A follow-up PR swaps branch protection** from the twelve GitHub Actions contexts to the twelve `local-ci/*` contexts, only once `bun run ci:watch` (or a manually-run `bun run ci:pr`) has posted real, green statuses against a real PR's head SHA — this PR's own verification step does exactly that, once, by hand, as a proof the mechanism works before anything is required on it.
3. **Only after branch protection points at `local-ci/*`** does a later PR delete `.github/workflows/{ci,template-init-smoke,e2e,codeql}.yml` — removing them earlier would leave `main` with no required check answering while the new mechanism is still being proven.

`.github/workflows/images.yml` and `release.yml` are out of scope for this migration; they are not required status checks and this ADR does not touch them.

## Consequences

- CI now runs on infrastructure this project controls end to end, with results traceable to an exact commit SHA rather than a workflow run's own bookkeeping.
- A contributor without access to whatever host runs `ci:watch` cannot get a `local-ci/*` result on their own PR without a maintainer (or a `--allow-fork` override) running one for them — this is the direct cost of D4's fork policy, accepted deliberately.
- The security leg's blind spots (D7) are real and documented, not incidental; a future iteration can close the path-exclusion gap without revisiting this ADR's other decisions.
- Every leg's evidence lives outside the repository (D6), so a maintainer debugging a red `local-ci/*` result needs access to the host that ran it, or to a `--keep`/`--report`-produced worktree, rather than a GitHub Actions log URL anyone with read access could open.
- Until the migration sequence's step 2 lands, `.github/workflows/*.yml` and `tools/ci/`'s legs run in parallel, checking the same commits twice — accepted as the cost of proving the replacement before anything depends on it exclusively.

## Rejected alternatives

- **A self-hosted GitHub Actions runner.** Still Actions-shaped end to end (workflow files, Actions' own trigger/log/required-check model) — only the compute moves off GitHub's fleet. Rejected because the owner's decision was "zero Actions," not "cheaper Actions," and a public repository already runs GitHub-hosted Actions for free, so a self-hosted runner would add operational surface (a machine to patch, secure, and keep online) for no cost benefit and none of the control this ADR's actual motivation asks for.
- **Option B — a single aggregate `local-ci` status context**, rather than twelve. Rejected: branch protection (and a human glancing at a PR) would lose per-leg visibility — a red aggregate context answers "something failed" but not which of twelve very different checks (a type error vs. a flaky e2e screenshot vs. a CodeQL finding) without opening evidence a human has to fetch from the state directory first. The flat per-leg mapping (D1) costs nothing extra to report and keeps the same debugging ergonomics `Check (toko)` vs. `Check (berita)` already gave as two separate Actions jobs.
- **Semgrep-only for the security leg**, in place of CodeQL. Rejected for this change: Semgrep's community ruleset does not cover the same taint-tracking dataflow analysis CodeQL's `security-extended` suite already proved useful for this repository (SECURITY.md's "CodeQL triage" section documents real findings it caught), and swapping the underlying analyzer would silently change what "security-severity >= 7.0" even means against the existing baseline process — a decision this migration change should not make as a side effect of moving where CI runs.
