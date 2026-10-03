-- Issue #288 (ADR-0030) — permission catalog seed for closed-loop stored
-- value, mirroring `src/modules/commerce/module.ts`'s `permissions` array
-- exactly (see `sql/902`'s header for the reasoning this migration does not
-- repeat: global catalog, idempotent via `ON CONFLICT DO NOTHING`, existing
-- tenants do not retroactively gain these).
--
-- Resource-split, existing `AccessAction` verbs only (ADR-0025 D9's
-- reasoning), each with its own enforcing route:
--
--   * `commerce.stored_value_programs.read|update` — read / change the
--     per-tenant program configuration (expiry, refund policy, balance cap).
--   * `commerce.stored_value.read`   — accounts, ledger, the liability report,
--     the reconcile report.
--   * `commerce.stored_value.create` — issue a card/credit and load value
--     onto it (money INTO the liability).
--   * `commerce.stored_value.update` — disable / enable an account and run
--     the expiry sweep.
--   * `commerce.stored_value_adjustments.create` — a manual, reasoned
--     correction of a balance. SEPARATE from `.create` above: a role that may
--     issue a card to a paying customer is not thereby trusted to edit a
--     balance by hand.
--   * `commerce.stored_value_reconcile.approve` — repair a drifted projection
--     (`approve` is the platform's high-risk verb, so a tenant may author SoD
--     rules against it).
--
-- Redeeming is NOT a stored-value permission: it happens only as a tender on
-- a payment (`commerce.pos.create` / `commerce.payments.create`), which is
-- exactly what keeps it closed-loop.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'stored_value_programs', 'read', 'Read the gift-card / store-credit program configuration (Issue #288)'),
  ('commerce', 'stored_value_programs', 'update', 'Change the gift-card / store-credit program configuration: enable, expiry, refund policy, balance ceiling (Issue #288)'),
  ('commerce', 'stored_value', 'read', 'Read gift-card / store-credit accounts, their ledger, the liability report and the reconcile report (Issue #288)'),
  ('commerce', 'stored_value', 'create', 'Issue a gift card / store credit and load value onto it (Issue #288)'),
  ('commerce', 'stored_value', 'update', 'Disable or enable a gift-card / store-credit account and run the expiry sweep (Issue #288)'),
  ('commerce', 'stored_value_adjustments', 'create', 'Post a reasoned manual adjustment to a gift-card / store-credit balance (Issue #288)'),
  ('commerce', 'stored_value_reconcile', 'approve', 'Repair a gift-card / store-credit balance projection that drifted from its ledger (Issue #288)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
