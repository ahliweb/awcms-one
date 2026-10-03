-- Issue #285 (ADR-0025) — permission catalog seed for the payment-allocation
-- ledger, mirroring `src/modules/commerce/module.ts`'s `permissions` array
-- exactly (see `sql/902`'s header for the reasoning this migration does not
-- repeat: global catalog, idempotent via `ON CONFLICT DO NOTHING`, existing
-- tenants do not retroactively gain these).
--
--   * `commerce.payments.read`   — list an order's ledger rows, the tender-mix
--     and outstanding-balance reports.
--   * `commerce.payments.create` — record an additional tender against an
--     order (`POST .../orders/{id}/payments`).
--   * `commerce.payments.revoke` — record a compensating reversal of a
--     payment (`POST .../payments/{id}/reversals`). `revoke` is the
--     platform's existing HIGH-RISK action verb (`AccessAction`), chosen over
--     inventing a `reverse` verb in the upstream-owned `identity_access`
--     union: a reversal takes money back out of the books, which is exactly
--     the class of action the high-risk set (and the SoD rules a tenant may
--     author against it) exists for — a role that may record a payment need
--     not be trusted to un-record one.
--   * `commerce.pos_due.create`  — finalize a POS sale that leaves a balance
--     DUE (`allowDue: true`). A separate key from `commerce.pos.create` so a
--     tenant can let cashiers ring cash/QRIS sales without letting them hand
--     goods over on credit.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'payments', 'read', 'Read an order''s payment-allocation ledger and the tender-mix / outstanding-balance reports (Issue #285)'),
  ('commerce', 'payments', 'create', 'Record an additional payment (tender) against an order (Issue #285)'),
  ('commerce', 'payments', 'revoke', 'Record a compensating reversal of a payment — takes money back out of the order''s settlement (Issue #285)'),
  ('commerce', 'pos_due', 'create', 'Finalize a POS sale that leaves a balance due instead of settling in full (Issue #285)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
