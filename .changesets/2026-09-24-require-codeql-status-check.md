---
bump: minor
type: structure
impact: public
---

# Promote CodeQL to a required pull-request status check

CodeQL (issue #184) ran on every push and PR for a full triage cycle
(issue #206) with a green track record and no un-triaged findings — the
probation condition set when it was introduced by PR #194. That
prerequisite is now satisfied, so it is promoted from advisory to a
required merge gate on `main` (issue #214).

- `main`'s branch protection now requires `Analyze (javascript-typescript)`
  — the CodeQL workflow's own job-status check (app: GitHub Actions) —
  additively, alongside the eleven contexts issue #215 had already
  established. All eleven survive unchanged; `enforce_admins` and `strict`
  are untouched.
- **Not** the sibling `CodeQL` check (app: GitHub Advanced Security, the
  code-scanning-results check posted only once a SARIF upload succeeds):
  verified from a real PR's check-runs that the job-status check is the
  one that fails closed on a workflow/analyzer failure, which is what a
  required security gate needs — the results check cannot represent an
  analyzer crash that never got far enough to upload a SARIF at all.
- `security-extended`, `apps/cms/**` in scope, the weekly schedule,
  SHA-pinned actions, and least-privilege workflow permissions are all
  unchanged. `security-and-quality` is deliberately not made
  merge-blocking — a separate signal/risk decision, out of scope here.
- Documentation and workflow comments that described CodeQL as "not
  required" are updated: `AGENTS.md`/`AGENTS.id.md`, `SECURITY.md`/
  `SECURITY.id.md`, `README.md`/`README.id.md`, `docs/status.md`/
  `docs/status.id.md`, `docs/alur-kerja-pengembangan.md`/`.id.md`, and
  `.github/workflows/codeql.yml`'s own comments.
