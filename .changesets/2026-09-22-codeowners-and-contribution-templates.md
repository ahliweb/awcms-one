---
bump: patch
type: structure
impact: internal
---

# CODEOWNERS, a PR template, and issue forms

Contribution routing had no structure: no `CODEOWNERS` to route review requests, no PR template to put `AGENTS.md`'s Definition of Done in front of a contributor (human or agent) at the exact moment they open a PR, and no issue forms to separate the three shapes this repo's own history actually produces — a bug report, a feature request, and a `git subtree pull` of `apps/cms` from `ahliweb/awcms`, which carries its own checklist nothing else was reminding anyone of.

- `.github/CODEOWNERS`: `@ahliweb` (the repo's single user-account owner — not an org, no team syntax) as the default, plus explicit routing lines for `apps/cms/`, `.github/`, `packages/gerbang/`, `tools/`, and `docs/adr/`. Advisory only — branch protection does not require a code-owner review, so this drives GitHub's own routing UI, not a merge gate.
- `.github/pull_request_template.md`: Summary, linked issue, how it was verified, and a checklist mirroring `AGENTS.md`'s Definition of Done in substance — short enough to actually fill in.
- `.github/ISSUE_TEMPLATE/`: `bug_report.yml` and `feature_request.yml` (both with an area dropdown covering storefront/cms-commerce/cms-upstream/tooling-gates/docs/deployment), `upstream_sync.yml` (upstream commit/PR, reason, and a checklist naming the documented local divergences by path), and `config.yml` (blank issues off in the web chooser only — `gh issue create` and the API, which is how this repo's own epics get opened, are unaffected; a contact link routes vulnerability reports to a private GitHub Security Advisory, per `SECURITY.md`).
- `CONTRIBUTING.md` (+ `.id.md`): the contribution flow now points at the issue forms and the PR template, and a new "Code ownership" section explains what `CODEOWNERS` does and does not gate.

No code, gate, or runtime behaviour changes — this is contribution-process scaffolding.
