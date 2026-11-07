---
bump: patch
type: docs
impact: internal
---

# Neutralise references to the owner's internal standard

Source citations in `AGENTS.md`, `AGENTS.id.md`, the embedded deploy skill and the skills-check script and test now name the owner's internal cross-portfolio standard in plain text instead of a repository path. The same edit is made upstream in `ahliweb/awcms`, so the next `apps/cms` sync stays conflict-free on these lines. No behaviour change.
