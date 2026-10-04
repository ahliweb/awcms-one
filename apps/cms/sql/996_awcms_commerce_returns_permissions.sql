-- Issue #287 (ADR-0033) — permission catalog seed for returns and refunds,
-- mirroring `src/modules/commerce/module.ts`'s `permissions` array exactly
-- (see `sql/902`'s header for the reasoning this migration does not repeat:
-- global catalog, idempotent via `ON CONFLICT DO NOTHING`, existing tenants do
-- not retroactively gain these).
--
-- Resource-split, existing `AccessAction` verbs only (ADR-0025 D9's
-- reasoning), each with its own enforcing route:
--
--   * `commerce.returns.read`    — list / read returns, their lines and refund
--     legs.
--   * `commerce.returns.create`  — record a return or exchange (puts goods
--     back, books the value) and link an exchange's replacement order.
--   * `commerce.refunds.read`    — read refund legs and their compensations.
--   * `commerce.refunds.create`  — settle a refund leg: hand cash back, book a
--     manual transfer, return value to a gift card, issue store credit, or
--     call the payment provider. A refund leg also needs
--     `commerce.payments.revoke` (taking money out of the books), which the
--     handler checks through the same chokepoint.
--   * `commerce.refunds_offline.approve` — attest that a refund the system
--     could not make (a provider that refused, no adapter configured) was
--     made OUTSIDE it. `approve` is the platform's high-risk verb, so a
--     tenant may author separation-of-duties rules against it.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'returns', 'read', 'Read returns, exchanges, their lines and refund legs (Issue #287)'),
  ('commerce', 'returns', 'create', 'Record a return or exchange of goods sold on an order, and link an exchange''s replacement order (Issue #287)'),
  ('commerce', 'refunds', 'read', 'Read refund legs and the compensations a settled refund had (Issue #287)'),
  ('commerce', 'refunds', 'create', 'Settle a refund leg: hand back cash, book a manual refund, return value to a gift card, issue store credit or call the payment provider (Issue #287)'),
  ('commerce', 'refunds_offline', 'approve', 'Attest that a refund was made outside the system when the provider or adapter could not make it (Issue #287)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
