---
bump: patch
type: fix
impact: internal
---

# `bun run check:cms` is green again inside the subtree embed

`apps/cms/tests/version-check.test.ts` asserted that more than 20 git tags were examined — true in a clone of `ahliweb/awcms`, false by construction here, where `git tag` answers with this repo's own `v0.x` line and upstream's tags are deliberately never fetched. The whole CMS gate chain was red on a clean `main` because of it (issue #22).

- The non-vacuity floor is skipped only when `apps/cms` is embedded inside a larger repository; the namespace-conformance and version-not-behind assertions still run.
- `AGENTS.md` now carries a "known local divergences" list under the subtree section, so the next `git subtree pull` conflict on this file is expected rather than a surprise.
