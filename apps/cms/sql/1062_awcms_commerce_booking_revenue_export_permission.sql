-- Permission catalog row for the booking revenue waterfall's CSV (Issue #478,
-- ADR-0045 amendment note). One activity code, `report_booking_revenue`, with
-- the high-risk `export` only: existing AccessAction verbs, the upstream-owned
-- union not widened. The on-screen waterfall and its JSON route stay on
-- `reporting.dashboard.read` (like the sales reports beside them); only the FILE
-- is gated here, the way the operational (999) and retention (1021) CSVs are.
-- Mirrors `module.ts`'s `permissions` array and
-- `domain/commerce-permissions.ts`'s COMMERCE_REPORT_BOOKING_REVENUE_*
-- constants; `access:permissions:enforcement:check` fails if this row has no
-- enforcing route. NOT implied by `reporting.dashboard.read`, by
-- `commerce.orders.read` or by another report permission: "may see the
-- waterfall" is not "may take the day-by-day money out as a file". Like 999 and
-- 1021 it seeds no role grant; an operator assigns the key. It depends on no
-- object created by a later file (ADR-0037).
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'report_booking_revenue', 'export', 'Export the booking revenue waterfall as CSV (Issue #478)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
