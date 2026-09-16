-- Issue #23 — the `restore` permission Issue #4 deliberately withheld
-- (`sql/154`'s header) now that a restore endpoint exists for both activity
-- codes (`POST .../products/{id}/restore`, `POST .../categories/{id}/restore`
-- — `office-directory.ts`'s shape). Mirrors
-- `commerce/domain/commerce-permissions.ts`'s `restore` entries exactly, same
-- idempotent `ON CONFLICT DO NOTHING` shape as `sql/154`.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'categories', 'restore', 'Restore a soft-deleted category record'),
  ('commerce', 'products', 'restore', 'Restore a soft-deleted product record')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
