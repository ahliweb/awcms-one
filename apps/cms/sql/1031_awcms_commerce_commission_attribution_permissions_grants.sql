-- Issue #391 (ADR-0046) - permission catalog seed and `awcms_worker` grants for
-- the commission sale-attribution adapter (`sql/1030`).
--
-- ## Permissions
--
-- Mirrors `src/modules/commerce/module.ts`'s `permissions` array exactly (see
-- `sql/902`'s header for the reasoning this migration does not repeat: global
-- catalog, idempotent via `ON CONFLICT DO NOTHING`, existing tenants do not
-- retroactively gain these). Four keys on two activity codes, existing
-- `AccessAction` verbs only (the upstream-owned union is not widened):
--
--   * `commerce.commission_settings.read|manage` - see and change whether the
--     adapter is on and which rule it applies;
--   * `commerce.commission_staff_links.read|manage` - see and change which
--     employment earns the commission of which login's sales.
--
-- `manage` is already a high-risk action (`HIGH_RISK_ACTIONS`), which is the
-- right posture: both decide who is paid. Neither is implied by the other, by
-- `commerce.orders.*`, or by any `hr_commission.*` key - and holding one of
-- these opens no commission amount, accrual or rule (those stay behind
-- `hr_commission.*`, which commerce never reads).
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'commission_settings', 'read', 'View whether employee-commission attribution is on and which commission rule it applies (Issue #391)'),
  ('commerce', 'commission_settings', 'manage', 'Switch employee-commission attribution on or off and choose the commission rule it applies (Issue #391)'),
  ('commerce', 'commission_staff_links', 'read', 'List which employment earns the commission of which login''s counter sales (Issue #391)'),
  ('commerce', 'commission_staff_links', 'manage', 'Link a login to the employment that earns its counter-sale commission, and retire a link (Issue #391)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;

-- ## awcms_worker
--
-- The `commerce.order_paid_commission_attributor` consumer runs in
-- `domain-events:dispatch`, as `awcms_worker`. It reads this module's two
-- tables and the order, and reports each line through `CommissionAccrualPort`,
-- whose posting core (`hr_commission`'s `accrueCommission`) and the triggers on
-- the accrual table run in the CALLER's transaction and therefore with the
-- caller's privileges. That is why the worker needs the grants below on tables
-- another module owns; none of them is wider than what the posting core and its
-- guard triggers execute:
--
--   * `awcms_hr_commission_accruals` SELECT, INSERT - find an existing accrual
--     by source identity; write a new one. NEVER UPDATE or DELETE: the worker
--     cannot approve, void, pay or rewrite an accrual (those transitions are
--     authenticated API actions).
--   * `awcms_hr_commission_transitions` SELECT, INSERT - the accrual's own birth
--     trigger appends the first log row.
--   * `awcms_hr_commission_rules` / `awcms_hr_employments` SELECT, plus
--     `UPDATE (id)` - the posting core and the insert guard read the rule and the
--     employment `FOR SHARE`, so a concurrent retire or termination queues
--     behind the accrual; PostgreSQL requires UPDATE privilege on at least one
--     column for any row-locking read. The single-column grant on the immutable
--     primary key is the narrowest way to hold that, and the worker still cannot
--     change a rule or an employment (no other column, and both tables have
--     immutability triggers).
--   * `awcms_tenant_settings` SELECT - the tenant's time zone, from which the
--     sale's civil date is derived (the ledger assumes none).
--   * `awcms_tenant_modules` SELECT - the consumer does nothing for a tenant
--     that has switched `hr_commission` off.
--
-- Tenant-RLS tables all; the worker's tenant is set per transaction.
GRANT SELECT ON awcms_commerce_commission_settings TO awcms_worker;
GRANT SELECT ON awcms_commerce_commission_staff_links TO awcms_worker;
GRANT SELECT, INSERT ON awcms_hr_commission_accruals TO awcms_worker;
GRANT SELECT, INSERT ON awcms_hr_commission_transitions TO awcms_worker;
GRANT SELECT ON awcms_hr_commission_rules TO awcms_worker;
GRANT SELECT ON awcms_hr_employments TO awcms_worker;
GRANT UPDATE (id) ON awcms_hr_commission_rules TO awcms_worker;
GRANT UPDATE (id) ON awcms_hr_employments TO awcms_worker;
GRANT SELECT ON awcms_tenant_settings TO awcms_worker;
GRANT SELECT ON awcms_tenant_modules TO awcms_worker;
