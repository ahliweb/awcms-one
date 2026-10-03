-- Issue #284 (ADR-0028) — permission catalog seed for POS registers and
-- cash-up, mirroring `src/modules/commerce/module.ts`'s `permissions` array
-- exactly (see `sql/902`'s header for the reasoning this migration does not
-- repeat: global catalog, idempotent via `ON CONFLICT DO NOTHING`, existing
-- tenants do not retroactively gain these).
--
-- Deliberately SEPARATE keys, each with its own enforcing route, so that
-- ringing up a sale (`commerce.pos.create`) grants none of them:
--
--   * `commerce.registers.{read,create,update}` — register definitions.
--   * `commerce.register_sessions.read`   — list/detail/cash-up report.
--   * `commerce.register_sessions.create` — OPEN a session.
--   * `commerce.register_sessions.update` — USE a session: drawer movements
--     and handovers.
--   * `commerce.register_sessions.export` — the cash-up CSV (`export` is the
--     platform's existing high-risk verb: the file leaves the system).
--   * `commerce.register_cash_ups.create`  — CLOSE a session (cash-up).
--   * `commerce.register_cash_ups.approve` — approve a variance above the
--     tenant's threshold (`approve` is high-risk, so a tenant may author SoD
--     rules against it).
--   * `commerce.register_corrections.approve` — post-close correction (high
--     risk for the same reason; a correction rewrites how a closed shift
--     reads).
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'registers', 'read', 'List POS registers (Issue #284)'),
  ('commerce', 'registers', 'create', 'Define a POS register (Issue #284)'),
  ('commerce', 'registers', 'update', 'Rename, relabel or (de)activate a POS register (Issue #284)'),
  ('commerce', 'register_sessions', 'read', 'Read register sessions and their cash-up reports (Issue #284)'),
  ('commerce', 'register_sessions', 'create', 'Open a register session with an opening float (Issue #284)'),
  ('commerce', 'register_sessions', 'update', 'Use a register session: record drawer movements and hand it over (Issue #284)'),
  ('commerce', 'register_sessions', 'export', 'Export a register session''s cash-up report as CSV (Issue #284)'),
  ('commerce', 'register_cash_ups', 'create', 'Close a register session by counting the drawer (cash-up) (Issue #284)'),
  ('commerce', 'register_cash_ups', 'approve', 'Approve or reject a cash-up whose variance exceeds the approval threshold (Issue #284)'),
  ('commerce', 'register_corrections', 'approve', 'Post a compensating correction to a closed register session (Issue #284)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
