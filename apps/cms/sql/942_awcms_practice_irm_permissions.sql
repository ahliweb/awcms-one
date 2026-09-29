-- Issue #270 (IRMbyDUS practice-irm module) — permission catalog seed for
-- the `domains` activity code, mirroring
-- `src/modules/practice-irm/module.ts`'s `permissions` array exactly (see
-- `sql/902`'s header for the full reasoning this migration does not
-- repeat: global catalog, idempotent via `ON CONFLICT DO NOTHING`, existing
-- tenants do not retroactively gain these).
--
-- No permission is seeded for `awcms_practice_irm_sessions` on purpose —
-- there is no tenant-staff permission over a customer's practice session at
-- all. See `domain/practice-irm-permissions.ts`'s own header on the
-- deliberate "Journal leakage" mitigation this omission is part of.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('practice_irm', 'domains', 'read', 'Read the five canonical IRM domains'' admin-editable content (Issue #270)'),
  ('practice_irm', 'domains', 'create', 'Create a domain''s content row when none exists yet (Issue #270)'),
  ('practice_irm', 'domains', 'update', 'Update a domain''s name/description/copy (Issue #270)'),
  ('practice_irm', 'domains', 'delete', 'Reset a domain''s content back to the built-in default (Issue #270)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
