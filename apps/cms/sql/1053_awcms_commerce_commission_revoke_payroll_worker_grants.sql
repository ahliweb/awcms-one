-- Issue #391 (ADR-0046 D10) - REVOKE the payroll-table privileges that `sql/1031`
-- and `sql/1051` gave `awcms_worker`, so the commission adapter ships DORMANT.
--
-- Why: upstream's payroll catalog boundary (ahliweb/awcms#1015) allows ONLY
-- `awcms_app` to hold privileges on payroll-family tables (`awcms_hr_*`); its
-- worker allowlist (`PAYROLL_WORKER_EXECUTE_ALLOWLIST`) is empty, and
-- `hr-attendance-autosettle` pins the worker's UPDATE grants on
-- `awcms_hr_employments` to exactly `updated_at`. The grants below breached both
-- gates. This repo does not edit upstream's gates, so the grants go.
--
-- Consequence: the commission consumers (order-paid attributor and the two
-- reversers) cannot post through `CommissionAccrualPort` as `awcms_worker`, so
-- they are no longer registered in `domain-events:dispatch` and enabling the
-- adapter is refused (409 `COMMISSION_ADAPTER_DORMANT`). The code stays; it is
-- dormant until upstream provides a sanctioned worker path to the port, at which
-- point a follow-up migration re-grants through that path.
--
-- Kept: the worker's SELECT on `awcms_hr_employments` (and UPDATE (updated_at)),
-- which is UPSTREAM's own grant (`sql/280`, the attendance-correction settler)
-- and not ours to revoke; `sql/1031`'s duplicate of that SELECT is harmless.
-- Also kept (commerce-owned or non-payroll): the worker's SELECT on
-- `awcms_commerce_commission_settings` / `_staff_links`, and on
-- `awcms_tenant_settings` / `awcms_tenant_modules`.
--
-- Column-level privileges are revoked explicitly because a table-level REVOKE
-- does not remove them. REVOKE of a privilege never granted is a no-op, so this
-- is idempotent and safe on a database that never applied 1031/1051.
REVOKE UPDATE (status, voided_at, voided_by, void_reason_code)
  ON awcms_hr_commission_accruals FROM awcms_worker;
REVOKE UPDATE (id) ON awcms_hr_commission_rules FROM awcms_worker;
REVOKE UPDATE (id) ON awcms_hr_employments FROM awcms_worker;
REVOKE SELECT, INSERT ON awcms_hr_commission_accruals FROM awcms_worker;
REVOKE SELECT, INSERT ON awcms_hr_commission_transitions FROM awcms_worker;
REVOKE SELECT ON awcms_hr_commission_rules FROM awcms_worker;
