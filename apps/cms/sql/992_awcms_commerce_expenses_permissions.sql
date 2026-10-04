-- Issue #294 (ADR-0031) — permission catalog seed for expenses, mirroring
-- `src/modules/commerce/module.ts`'s `permissions` array exactly (see
-- `sql/902`'s header for the reasoning this migration does not repeat: global
-- catalog, idempotent via `ON CONFLICT DO NOTHING`, existing tenants do not
-- retroactively gain these).
--
-- Resource-split on purpose, each key with its own enforcing route, none
-- implied by `commerce.register_sessions.update` or `commerce.pos.create`, and
-- only verbs the upstream-owned `AccessAction` union already has:
--
--   * `commerce.expense_categories.{read,create,update}` - categories.
--   * `commerce.expenses.{read,create,update,export}` - read list/detail/
--     summary, create a draft, edit/discard a draft, export CSV (`export` is
--     the platform's high-risk verb: the file leaves the system).
--   * `commerce.expense_postings.create`  - submit a draft for posting (posts it
--     outright when within the tenant's approval threshold).
--   * `commerce.expense_postings.approve` - approve/reject a pending expense
--     above the threshold (high-risk: a tenant may author SoD rules on it).
--   * `commerce.expense_reversals.approve` - reverse a posted expense (a
--     compensating entry; high-risk for the same reason).
--   * `commerce.expense_receipts.read`   - mint a short-lived presigned URL for
--     an expense's PRIVATE receipt (separate from `expenses.read` on purpose: a
--     receipt can show a person's name or an account number).
--   * `commerce.expense_receipts.create` - attach a private receipt.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'expense_categories', 'read', 'List expense categories (Issue #294)'),
  ('commerce', 'expense_categories', 'create', 'Define an expense category (Issue #294)'),
  ('commerce', 'expense_categories', 'update', 'Rename or (de)activate an expense category (Issue #294)'),
  ('commerce', 'expenses', 'read', 'List and read expenses and the expense summary (Issue #294)'),
  ('commerce', 'expenses', 'create', 'Create a draft expense (Issue #294)'),
  ('commerce', 'expenses', 'update', 'Edit or discard a draft expense (Issue #294)'),
  ('commerce', 'expenses', 'export', 'Export expenses as CSV (Issue #294)'),
  ('commerce', 'expense_postings', 'create', 'Submit a draft expense for posting (Issue #294)'),
  ('commerce', 'expense_postings', 'approve', 'Approve or reject an expense above the approval threshold (Issue #294)'),
  ('commerce', 'expense_reversals', 'approve', 'Reverse a posted expense with a compensating entry (Issue #294)'),
  ('commerce', 'expense_receipts', 'read', 'Issue a short-lived download URL for an expense receipt (Issue #294)'),
  ('commerce', 'expense_receipts', 'create', 'Attach a private receipt to an expense (Issue #294)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
