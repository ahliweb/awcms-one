-- Permission catalog rows for the customer-retention report (Issue #364,
-- ADR-0044). One activity code, `report_retention`, with `read` and the
-- high-risk `export`: two rows, existing AccessAction verbs only (the
-- upstream-owned union is not widened). Mirrors `module.ts`'s `permissions`
-- array and `domain/commerce-permissions.ts`'s COMMERCE_REPORT_RETENTION_*
-- constants; `access:permissions:enforcement:check` fails if a row here has no
-- enforcing route. Neither is implied by `reporting.dashboard.read`, by
-- `commerce.customers.read` (which opens individual customers) or by another
-- report permission: "may see how many customers came back" is not "may list
-- who they are".
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'report_retention', 'read', 'Read the customer-retention (90-day repeat rate) report (Issue #364)'),
  ('commerce', 'report_retention', 'export', 'Export the customer-retention report as CSV (Issue #364)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
