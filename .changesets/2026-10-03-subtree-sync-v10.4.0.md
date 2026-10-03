---
bump: patch
type: dependency
impact: public
---

# Sync the AWCMS subtree to v10.4.0 (`cfc2df9a`)

`apps/cms` now embeds `ahliweb/awcms` at v10.4.0 (18 upstream commits since
`8e9bce0c`): the admin UI/UX parity work (ConfirmDialog, SettingsSaveBar,
ReasonPanel; `.admin-stat-card`/`.admin-status-pill` adopted by every screen;
the legacy `.stat-card`/`.status-badge` classes retired), an axe-core
accessibility smoke and a responsive overflow sweep, the OMES Mission Control
screens (migration `sql/168`), and dependency overrides. Merged with a merge
commit, as every subtree sync must be.

- Five commerce admin screens moved off the retired `.status-badge`/
  `.stat-grid` classes onto `.admin-status-pill`/`.admin-stat-card-grid`.
- `commerce-confirm-dialog-client.ts` no longer falls back to the browser's own
  confirm when no dialog is available (upstream now forbids it); it refuses,
  the same fail-closed posture as upstream's `confirm-dialog-client.ts`.
- **Operator action:** upstream took `sql/168`, so this repo's media-library
  migrations were renumbered forward to `sql/169_awcms_news_media_objects_visibility.sql`
  and `sql/170_awcms_media_library_media_download_permission.sql` (contents,
  and so checksums, unchanged). A database that already applied the old names
  must rename the two `awcms_schema_migrations.migration_name` rows before its
  next `db:migrate` (statements in `AGENTS.md`'s divergence list); a fresh
  database needs nothing.
- `APP_BUDGET_BYTES` re-measured on the merged build: 344,000 B (343,962 B).
- The `apps/cms` `http-cache-semantics` audit exception is now upstream's own
  and no longer a local divergence; the root `tools/ci/dependency-audit-exceptions.json`
  entry stays.
