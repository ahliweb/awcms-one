---
bump: patch
type: dependency
impact: internal
---

# Sync `apps/cms` to upstream AWCMS v10.6.0

`apps/cms` now embeds `ahliweb/awcms` `main` at `61507bb7` (AWCMS v10.6.0), two commits past the previous sync (`a0dabcd9`).

- `idn-admin-regions` dataset rollback (ahliweb/awcms#914, #922): `now()` is the transaction start, so the active dataset could be stamped equal to or earlier than the one it superseded, and the strict `activated_at <` filter then found nothing to roll back to. Rollback now takes the latest superseded dataset by `(activated_at, id)` with no comparison. Covered by a new integration test.
- Version bump to 10.6.0 with upstream's `CHANGELOG.md` and `PROJECT_STATE` updates. No new migrations, no dependency changes.
- No standing local divergence was resolved or added. The only conflict was in `apps/cms/docs/PROJECT_STATE.md` and its Indonesian mirror (upstream's version and release-note rows against this embed's module and migration counts); both lineages were kept and the mirror restamped.
