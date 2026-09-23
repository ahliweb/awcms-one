---
bump: patch
type: structure
impact: internal
---

# CodeQL code scanning for JavaScript/TypeScript

Issue #184 (part of epic #179) adds GitHub CodeQL code scanning alongside the secret scanning + push protection and Dependabot security updates already enabled on this repository (issue #182).

- `.github/workflows/codeql.yml` — a new, separate workflow (`javascript-typescript`, `build-mode: none`) on push to `main`, every pull request, a weekly schedule, and manual dispatch. `github/codeql-action/{init,analyze}` are pinned to a commit SHA (`1c5b675653bb5c22dbe9b12b556ec555138e09fd`, `# v4.38.1`, verified against `github/codeql-action`'s own tag), the job's own permissions are the least required (`security-events: write`, `actions: read`, on top of the workflow-level `contents: read`), and the query suite is `security-extended` — not upstream `ahliweb/awcms`'s own `security-extended,security-and-quality`, since this repository has no CodeQL triage playbook of its own yet.
- `.github/codeql/codeql-config.yml` excludes only generated/build/vendored output (`node_modules`, `dist`, `.astro`, `graphify-out`, generated i18n catalogs, lockfiles, vendored datasets, Playwright run artefacts) at any depth in the workspace. **`apps/cms/**` SOURCE stays in scope** — it is the code that actually runs in this deployment, even though that tree is upstream `ahliweb/awcms` embedded via `git subtree`; a resulting finding there is triaged per `SECURITY.md` (fixed here only if it is one of `AGENTS.md`'s documented local divergences or this repository's own `commerce` module, otherwise reported/fixed upstream and pulled in via the normal subtree sync).
- Not a required status check yet — promoted, if ever, only after it has run green on `main` for a while, the same bar `check-cms` and `template-init-smoke` were held to before their own promotion.
- Docs: `SECURITY.md` (+ `.id.md`) now names all three forms of automated scanning in force and how a CodeQL alert on `apps/cms/**` is triaged; `docs/alur-kerja-pengembangan.md` (+ `.id.md`) gets a new "CI: a fifth workflow, not required — `codeql`" section describing the workflow's shape and scope decision.
