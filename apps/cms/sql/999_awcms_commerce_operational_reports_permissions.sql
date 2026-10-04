-- Permission catalog rows for the POS operational reports (Issue #296,
-- ADR-0035). Five activity codes - one per report family - each with `read`
-- and the high-risk `export`: ten rows, existing AccessAction verbs only (the
-- upstream-owned union is not widened). Mirrors `module.ts`'s `permissions`
-- array and `domain/commerce-permissions.ts`'s COMMERCE_REPORT_* constants;
-- `access:permissions:enforcement:check` fails if a row here has no enforcing
-- route. None of these is implied by `reporting.dashboard.read` or by the
-- source-domain permissions (ADR-0035 D5).
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'report_tenders', 'read', 'Read the tender-mix operational report (Issue #296)'),
  ('commerce', 'report_tenders', 'export', 'Export the tender-mix operational report as CSV (Issue #296)'),
  ('commerce', 'report_cash_ups', 'read', 'Read the cash-up variance operational report (Issue #296)'),
  ('commerce', 'report_cash_ups', 'export', 'Export the cash-up variance operational report as CSV (Issue #296)'),
  ('commerce', 'report_expenses', 'read', 'Read the expenses operational report (Issue #296)'),
  ('commerce', 'report_expenses', 'export', 'Export the expenses operational report as CSV (Issue #296)'),
  ('commerce', 'report_loyalty', 'read', 'Read the loyalty-points operational report (Issue #296)'),
  ('commerce', 'report_loyalty', 'export', 'Export the loyalty-points operational report as CSV (Issue #296)'),
  ('commerce', 'report_stored_value', 'read', 'Read the stored-value liability operational report (Issue #296)'),
  ('commerce', 'report_stored_value', 'export', 'Export the stored-value liability operational report as CSV (Issue #296)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
