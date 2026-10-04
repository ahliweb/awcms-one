-- Permission catalog rows for the returns & refunds operational report (Issue
-- #316, ADR-0035 D1/D5). One activity code, `report_returns`, with `read` and
-- the high-risk `export`: two rows, existing AccessAction verbs only (the
-- upstream-owned union is not widened). Mirrors `module.ts`'s `permissions`
-- array and `domain/commerce-permissions.ts`'s COMMERCE_REPORT_RETURN_*
-- constants; `access:permissions:enforcement:check` fails if a row here has no
-- enforcing route. Neither is implied by `reporting.dashboard.read` or by the
-- returns permissions (`commerce.returns.read`, which opens individual rows).
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'report_returns', 'read', 'Read the returns and refunds operational report (Issue #316)'),
  ('commerce', 'report_returns', 'export', 'Export the returns and refunds operational report as CSV (Issue #316)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
