-- Issue #287 (ADR-0033) — the additive changes a return needs on tables that
-- already exist. Every statement is expand-only and idempotent; nothing is
-- renamed, dropped or rewritten.
--
--   1. `awcms_commerce_order_events.return_id` — a return is announced on the
--      order's event stream (a `to_status = 'returned'` row), which is the
--      cursor stream the three sales-report projections already consume. The
--      column lets a projection find the return a row stands for. NULL for
--      every status-transition row, ON DELETE SET NULL (the event outlives a
--      retention-purged return; the projection then reads nothing for it).
--   2. A database-level cap on payment reversals. ADR-0025 enforced "Σ
--      reversals of a payment <= the payment" in the application under the
--      order lock because a CHECK cannot span rows; a trigger can, and the
--      refund workflow raises the stakes (money leaves through this path), so
--      the cap is now ALSO a property of the table. The application path is
--      unchanged and still runs first.
--   3. The loyalty ledger's `source_type` gains `refund`, and the "one
--      compensating entry per original entry" unique index (sql/950) stops
--      applying to refund-sourced reversals: a partial refund takes back a
--      PROPORTION of an earn lot, and a lot can be partly refunded several
--      times. The per-key uniqueness (`reversal:refund:{refund id}`) is the
--      idempotency guard for those; the cancellation reversal keeps its
--      one-per-lot index.
--   4. `awcms_commerce_affiliate_commissions.adjusted_amount` — the part of a
--      commission given back because the goods were refunded. The snapshot
--      `amount` is never rewritten; the effective commission is
--      `amount - adjusted_amount`.

-- 1. order events ----------------------------------------------------------

ALTER TABLE awcms_commerce_order_events
  ADD COLUMN IF NOT EXISTS return_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'awcms_commerce_order_events_return_fk'
  ) THEN
    ALTER TABLE awcms_commerce_order_events
      ADD CONSTRAINT awcms_commerce_order_events_return_fk
      FOREIGN KEY (tenant_id, return_id)
      REFERENCES awcms_commerce_returns (tenant_id, id)
      ON DELETE SET NULL (return_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS awcms_commerce_order_events_return_idx
  ON awcms_commerce_order_events (tenant_id, return_id)
  WHERE return_id IS NOT NULL;

-- 2. payment reversal cap --------------------------------------------------

CREATE OR REPLACE FUNCTION awcms_commerce_payment_allocations_reversal_cap()
RETURNS trigger AS $awcms_commerce_payment_allocations_reversal_cap$
DECLARE
  paid numeric(14, 2);
  already numeric(14, 2);
BEGIN
  SELECT amount INTO paid
  FROM awcms_commerce_payment_allocations
  WHERE tenant_id = NEW.tenant_id AND id = NEW.reverses_allocation_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'awcms_commerce_payment_allocations: reversed payment % not found', NEW.reverses_allocation_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO already
  FROM awcms_commerce_payment_allocations
  WHERE tenant_id = NEW.tenant_id
    AND reverses_allocation_id = NEW.reverses_allocation_id
    AND status = 'succeeded';
  IF already + NEW.amount > paid THEN
    RAISE EXCEPTION
      'awcms_commerce_payment_allocations: reversing % of payment % would exceed it (% paid, % already reversed)',
      NEW.amount, NEW.reverses_allocation_id, paid, already
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_payment_allocations_reversal_cap$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_payment_allocations_reversal_cap
  ON awcms_commerce_payment_allocations;
CREATE TRIGGER awcms_commerce_payment_allocations_reversal_cap
  BEFORE INSERT ON awcms_commerce_payment_allocations
  FOR EACH ROW
  WHEN (NEW.kind = 'reversal' AND NEW.status = 'succeeded')
  EXECUTE FUNCTION awcms_commerce_payment_allocations_reversal_cap();

-- 3. loyalty ledger --------------------------------------------------------

ALTER TABLE awcms_commerce_loyalty_ledger
  DROP CONSTRAINT IF EXISTS awcms_commerce_loyalty_ledger_source_type_check;
ALTER TABLE awcms_commerce_loyalty_ledger
  ADD CONSTRAINT awcms_commerce_loyalty_ledger_source_type_check
  CHECK (source_type IN ('order', 'expiry', 'redemption', 'manual', 'refund'));

DROP INDEX IF EXISTS awcms_commerce_loyalty_ledger_reverses_key;
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_loyalty_ledger_reverses_key
  ON awcms_commerce_loyalty_ledger (tenant_id, reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL AND source_type <> 'refund';

-- A refund-sourced entry names the refund it came from.
ALTER TABLE awcms_commerce_loyalty_ledger
  DROP CONSTRAINT IF EXISTS awcms_commerce_loyalty_ledger_refund_source_check;
ALTER TABLE awcms_commerce_loyalty_ledger
  ADD CONSTRAINT awcms_commerce_loyalty_ledger_refund_source_check
  CHECK (source_type <> 'refund' OR (kind = 'reversal' AND source_id IS NOT NULL));

-- 4. affiliate commissions -------------------------------------------------

ALTER TABLE awcms_commerce_affiliate_commissions
  ADD COLUMN IF NOT EXISTS adjusted_amount numeric(14, 2) NOT NULL DEFAULT 0;

ALTER TABLE awcms_commerce_affiliate_commissions
  DROP CONSTRAINT IF EXISTS awcms_commerce_affiliate_commissions_adjusted_check;
ALTER TABLE awcms_commerce_affiliate_commissions
  ADD CONSTRAINT awcms_commerce_affiliate_commissions_adjusted_check
  CHECK (adjusted_amount >= 0 AND adjusted_amount <= amount);
