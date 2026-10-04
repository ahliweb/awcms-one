-- Issue #289 — permission catalog seed for the loyalty activity codes,
-- mirroring `src/modules/commerce/module.ts`'s `permissions` array exactly
-- (see `sql/902`'s header for the reasoning this migration does not repeat:
-- global catalog, idempotent via `ON CONFLICT DO NOTHING`, existing tenants
-- do not retroactively gain these).
--
-- Four permissions, three activity codes — NOT `commerce.loyalty.adjust`/
-- `.redeem`: `AccessAction` (identity-access, upstream-owned) has no
-- `adjust`/`redeem` member, and widening that union would put a new
-- divergence in an upstream file for every future subtree sync. A manual
-- points adjustment and a redemption are each a CREATE of a ledger row, so
-- they are `create` on their own activity code, which keeps them separately
-- grantable (a cashier can redeem without being able to adjust) without
-- touching upstream:
--
--   commerce.loyalty.read                 programs/accounts/ledger/summary
--   commerce.loyalty.manage               programs + reconcile repair (high-risk action)
--   commerce.loyalty_adjustments.create   manual adjustment (mandatory reason)
--   commerce.loyalty_redemptions.create   redeem points (owner/POS)
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'loyalty', 'read', 'View loyalty programs, customer point balances, the point ledger and the loyalty summary (Issue #289)'),
  ('commerce', 'loyalty', 'manage', 'Create, edit, activate and retire loyalty program versions, and repair a drifted balance projection from the ledger (Issue #289)'),
  ('commerce', 'loyalty_adjustments', 'create', 'Record a manual loyalty points adjustment — a signed ledger entry with a mandatory reason (Issue #289)'),
  ('commerce', 'loyalty_redemptions', 'create', 'Redeem a customer''s loyalty points at the counter or on their behalf (Issue #289)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
