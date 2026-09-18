-- Issue #4 — permission catalog seed for the `commerce` module, mirroring
-- `src/modules/commerce/module.ts`'s `permissions` array exactly, one row per
-- entry (a gate checks the two stay in step).
--
-- Same shape/limitation as every prior permission-seed migration here (see
-- `sql/042`'s header): this extends the global ABAC catalog only. Existing
-- tenants' `owner` role does NOT retroactively gain these — only tenants
-- created after this migration runs get them via the setup-initialize grant
-- (`INSERT INTO awcms_role_permissions ... SELECT ... FROM awcms_permissions`).
--
-- `awcms_permissions` is a GLOBAL catalog (no `tenant_id`, no RLS — the
-- action VOCABULARY is process-wide; the tenant-scoped grant lives in
-- `awcms_role_permissions`). Idempotent via `ON CONFLICT DO NOTHING`.
--
-- Two activity codes, one per resource, four CRUD actions each. No
-- `restore` action for either: this slice ships no restore endpoint (see
-- `sql/901`'s header and `commerce/domain/commerce-permissions.ts`'s), and
-- seeding a permission with no enforcing code is exactly the defect class
-- `media-library/domain/media-permissions.ts`'s header warns against (the
-- since-revoked `attach`/`detach` keys, `sql/087`).
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'categories', 'read', 'Read category records'),
  ('commerce', 'categories', 'create', 'Create category records'),
  ('commerce', 'categories', 'update', 'Update category records'),
  ('commerce', 'categories', 'delete', 'Soft-delete category records'),
  ('commerce', 'products', 'read', 'Read product records'),
  ('commerce', 'products', 'create', 'Create product records'),
  ('commerce', 'products', 'update', 'Update product records, including a legal product status transition'),
  ('commerce', 'products', 'delete', 'Soft-delete product records')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
