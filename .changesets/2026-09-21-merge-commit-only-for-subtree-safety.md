---
bump: patch
type: docs
impact: internal
---

# Merge commit is now the only merge method — subtree-sync protection is mechanical, not procedural

Issue #149 closed the gap this repo's own governance had named since ADR-0001: nothing in
GitHub's settings stopped a `git subtree pull` PR from being squashed or rebased, which would
destroy the merge base the next upstream sync needs — invisibly, until that next sync fails far
from the commit that broke it. The fix is a repository setting, not code: `allow_merge_commit=true`,
`allow_squash_merge=false`, `allow_rebase_merge=false` (applied separately, verified via
`gh api repos/ahliweb/awcms-one`). Required linear history stays disabled, deliberately — it would
conflict with the full-history subtree model this repo depends on.

This change updates every place that documented the old gap as procedural-only ("a rule to
remember, not one CI enforces") so it instead states the current, mechanically-enforced reality,
and records the operational consequence for ordinary PRs: a merge commit is now the only method
GitHub's merge button offers, repository-wide, not only for subtree syncs.

- `AGENTS.md`/`AGENTS.id.md` — "The one rule that protects every future sync" now describes the
  enforced state instead of "nothing mechanically stops this today".
- `GOVERNANCE.md`/`GOVERNANCE.id.md` — the decision-flow diagram and "Changes that may not be made
  alone" no longer describe a merge-strategy fork that no longer exists.
- `CONTRIBUTING.md`/`CONTRIBUTING.id.md`, `SECURITY.md`/`SECURITY.id.md` — the subtree merge-commit
  rule now notes it is mechanically enforced.
- `docs/alur-kerja-pengembangan.md`/`.id.md` — "Branch protection on `main`" and "Not enforced
  today" updated; the merge-strategy item is removed from what is not enforced.
- `docs/adr/0001-git-subtree-with-full-history-for-apps-cms.md`/`.id.md` — a dated status-update
  note is appended after the original decision text, which is left untouched as history.
- `knowledge/curated/ownership-boundaries.md` — notes the rule is now also a mechanical property
  of the repository, not only a documented one.

No `apps/cms/**` files were changed. This is a docs/governance-only change; the repository
settings themselves were applied out of band by a maintainer.
