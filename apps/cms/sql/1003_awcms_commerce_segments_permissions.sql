-- Issue #360 (ADR-0042) - permission catalog seed for CRM segments, mirroring
-- `src/modules/commerce/module.ts`'s `permissions` array exactly (see
-- `sql/902`'s header for the reasoning this migration does not repeat: global
-- catalog, idempotent via `ON CONFLICT DO NOTHING`, existing tenants do not
-- retroactively gain these).
--
-- Resource-split on purpose (threat model control C-27), each key with its own
-- enforcing route, and only verbs the upstream-owned `AccessAction` union
-- already has:
--
--   * `commerce.segments.{read,create,update,delete}` - define: list and read
--     definitions and their versions (rules only, never a customer), create a
--     segment, add a version / rename, retire. `delete` is high-risk.
--   * `commerce.segment_previews.read` - a COUNT-only preview of a rule or a
--     version. Needs no customer permission: a count reveals no customer.
--   * `commerce.segment_members.read` - list a version's members. The routes
--     additionally require `commerce.customers.read`.
--   * `commerce.segment_members.export` - export a version's members as CSV
--     (`export` is the platform's high-risk verb: the file leaves the system).
--     Also requires `commerce.customers.read`.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'segments', 'read', 'List and read CRM segments and their versions (Issue #360)'),
  ('commerce', 'segments', 'create', 'Define a CRM segment (Issue #360)'),
  ('commerce', 'segments', 'update', 'Rename a CRM segment or add a version of its rules (Issue #360)'),
  ('commerce', 'segments', 'delete', 'Retire a CRM segment, keeping its versions (Issue #360)'),
  ('commerce', 'segment_previews', 'read', 'Preview how many customers a segment rule matches (Issue #360)'),
  ('commerce', 'segment_members', 'read', 'List the customers a segment version matches (Issue #360)'),
  ('commerce', 'segment_members', 'export', 'Export the customers a segment version matches as CSV (Issue #360)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
