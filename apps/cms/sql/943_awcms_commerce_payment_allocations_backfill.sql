-- Issue #285 (ADR-0025) — expand -> BACKFILL step of the payment-allocation
-- ledger: every order the old single-axis model already recorded as paid gets
-- exactly one `backfill` allocation, so the ledger is the complete truth from
-- the day it ships and no reader needs a "legacy order, no rows" branch.
--
-- Deterministic and idempotent:
--   * one row per order, keyed `backfill:{order id}` (`UNIQUE (tenant_id,
--     source_key)`, sql/940) with `ON CONFLICT DO NOTHING`;
--   * additionally skipped for any order that already has ANY ledger row, so a
--     re-run after real allocations exist can never add a phantom one;
--   * the timestamp carried is the order's own `paid_at` (falling back to its
--     `created_at`), never `now()` — `sql/053`'s precedent: this records when
--     the money genuinely arrived, and `now()` would claim every historical
--     payment happened at deploy time (which would also skew the tender-mix
--     report's date range).
--
-- This runs as the migration owner (superuser/BYPASSRLS — sql/019/sql/053's
-- header), so it reads and writes across every tenant; `tenant_id` is copied
-- from the order row, never inferred.
--
-- What "paid" meant, and how each tender is reconstructed — honestly, from
-- columns that exist, inventing nothing:
--
--   * `payment_method` `cash`/`manual_qris`/`manual_bank`/`gateway` map to the
--     tender of the same name (`manual_bank` -> `manual_bank_transfer`). A
--     gateway order carries its `gateway_provider`/`gateway_ref` (sql/926,
--     stamped by `markOrderPaidBySystem`); an order an admin marked paid by
--     hand with no provider stamp keeps `provider = 'legacy'` (the CHECK
--     requires a gateway leg to name one) and no reference.
--   * `dp`: the legacy flow flipped the whole order to `paid` the moment the
--     FIRST confirmation was accepted — i.e. on the down payment alone. The
--     backfilled amount is therefore the sum of that order's ACCEPTED
--     confirmations (capped at the order total), falling back to `dp_amount`,
--     and the order's cached `payment_status` is corrected to `dp_paid`
--     (`partially_paid` if even the down payment is not covered) so the
--     ledger and the cache agree. Every other order's amount is its `total`:
--     `paid` was, for them, "paid in full".
--   * Cash change was never stored before this issue, so a backfilled cash row
--     carries no `tendered_amount`/`change_amount` (the CHECK allows both
--     NULL).
--   * An order with `total = 0` is skipped — a zero-amount leg is forbidden
--     (`amount > 0`) and there is nothing to settle.

WITH accepted AS (
  SELECT tenant_id, order_id, SUM(amount) AS accepted_total
  FROM awcms_commerce_payment_confirmations
  WHERE status = 'accepted' AND deleted_at IS NULL
  GROUP BY tenant_id, order_id
),
candidates AS (
  SELECT
    o.id AS order_id,
    o.tenant_id,
    o.payment_method,
    o.total,
    o.dp_amount,
    o.gateway_provider,
    o.gateway_ref,
    COALESCE(o.paid_at, o.created_at) AS paid_moment,
    CASE
      WHEN o.payment_method = 'dp' THEN
        LEAST(o.total, COALESCE(NULLIF(a.accepted_total, 0), o.dp_amount, o.total))
      ELSE o.total
    END AS amount
  FROM awcms_commerce_orders o
  LEFT JOIN accepted a ON a.tenant_id = o.tenant_id AND a.order_id = o.id
  WHERE o.payment_status = 'paid'
    AND o.total > 0
    AND NOT EXISTS (
      SELECT 1 FROM awcms_commerce_payment_allocations x
      WHERE x.tenant_id = o.tenant_id AND x.order_id = o.id
    )
)
INSERT INTO awcms_commerce_payment_allocations (
  tenant_id, order_id, kind, tender_type, amount, status,
  provider, provider_reference, note, source, source_key,
  actor_kind, created_at, settled_at
)
SELECT
  c.tenant_id,
  c.order_id,
  'payment',
  CASE c.payment_method
    WHEN 'cash' THEN 'cash'
    WHEN 'manual_qris' THEN 'manual_qris'
    WHEN 'gateway' THEN 'gateway'
    ELSE 'manual_bank_transfer'
  END,
  c.amount,
  'succeeded',
  CASE WHEN c.payment_method = 'gateway' THEN COALESCE(c.gateway_provider, 'legacy') END,
  CASE WHEN c.payment_method = 'gateway' THEN c.gateway_ref END,
  'Backfilled from the legacy payment_status = paid (Issue #285).',
  'backfill',
  'backfill:' || c.order_id::text,
  'system',
  c.paid_moment,
  c.paid_moment
FROM candidates c
ON CONFLICT (tenant_id, source_key) DO NOTHING;

-- Keep the cached `payment_status` honest for the one legacy shape where
-- "paid" never meant paid in full: a down-payment order whose backfilled
-- amount does not cover the total.
UPDATE awcms_commerce_orders o
SET payment_status = CASE
      WHEN a.amount >= COALESCE(o.dp_amount, o.total) THEN 'dp_paid'
      ELSE 'partially_paid'
    END
FROM awcms_commerce_payment_allocations a
WHERE a.tenant_id = o.tenant_id
  AND a.order_id = o.id
  AND a.source = 'backfill'
  AND o.payment_status = 'paid'
  AND o.payment_method = 'dp'
  AND a.amount < o.total;
