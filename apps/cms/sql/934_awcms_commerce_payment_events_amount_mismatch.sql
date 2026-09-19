-- Issue #113 (epic #33, contract #106's D2, ADR-0017) — widen
-- `awcms_commerce_payment_events.outcome` with `'amount_mismatch'`.
--
-- Defense in depth for the webhook intake route and the
-- `commerce:payments:reconcile` job: a provider-reported `gross_amount` that
-- does NOT equal the order's own `total` must never mark the order paid, even
-- though the signature verified (a tampered Snap transaction, a stale
-- callback for an amended order, or a provider-side bug). Such an event is
-- still RECORDED — the `(tenant_id, provider, event_key)` replay guard still
-- applies, and an operator needs to see it in the order's payment-events
-- panel — under this new outcome, with an audit-log entry beside it.
--
-- `sql/926`'s original CHECK admitted only `applied`/`ignored`/`replay`; a
-- CHECK constraint cannot be altered in place, so it is dropped and
-- re-created with the wider list. No data change.

ALTER TABLE awcms_commerce_payment_events
  DROP CONSTRAINT IF EXISTS awcms_commerce_payment_events_outcome_check;

ALTER TABLE awcms_commerce_payment_events
  ADD CONSTRAINT awcms_commerce_payment_events_outcome_check
    CHECK (outcome IN ('applied', 'ignored', 'replay', 'amount_mismatch'));

COMMENT ON COLUMN awcms_commerce_payment_events.outcome IS
  'applied | ignored | replay | amount_mismatch (Issue #113: provider gross_amount differed from the order total — recorded, audited, order NOT marked paid).';
