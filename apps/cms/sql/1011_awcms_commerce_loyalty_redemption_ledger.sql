-- Issue #363 (ADR-0043) - the points ledger learns to take a redemption back.
--
-- A cancelled or refunded order that spent points gives them back with a
-- COMPENSATING row, never by editing or deleting the original `redeem` row
-- (ADR-0026 D2). That row is a new entry kind, `restore`:
--
--   * `points > 0` (the opposite sign of the `redeem` it compensates);
--   * `reverses_entry_id` names the `redeem` row it compensates (the same
--     column a `reversal` uses for an earn);
--   * `source_type` is `order` (the order was cancelled or expired) or
--     `refund` (a settled refund returned part of the money), and `source_id`
--     is that order's or refund's id - the restore's own identity, distinct from
--     the identity of the redemption it undoes. Its idempotency key is
--     `restore:order:<orderId>` / `restore:refund:<refundId>`, so a replay,
--     a re-delivered event or a re-run job cannot restore twice.
--   * it carries `expires_at`, like an `earn`: a restored point is a new lot
--     that lapses no later than the soonest-expiring lot the redemption
--     consumed. Without that, redeeming near expiry and cancelling would turn
--     lapsing points into permanent ones (ADR-0043 D7).
--
-- One cancellation restore per redeem row is enforced by the existing
-- `awcms_commerce_loyalty_ledger_reverses_key` partial unique index (it covers
-- every row with a `reverses_entry_id` whose source is not a refund); refund
-- restores are unbounded in number (partial refunds), like refund reversals.
--
-- Every change below widens a CHECK, so every existing row stays valid. The
-- constraints are dropped and re-added under their original names, the
-- precedent of `sql/995`.

ALTER TABLE awcms_commerce_loyalty_ledger
  DROP CONSTRAINT IF EXISTS awcms_commerce_loyalty_ledger_kind_check;
ALTER TABLE awcms_commerce_loyalty_ledger
  ADD CONSTRAINT awcms_commerce_loyalty_ledger_kind_check
  CHECK (kind IN ('earn', 'redeem', 'expire', 'adjustment', 'reversal', 'restore'));

ALTER TABLE awcms_commerce_loyalty_ledger
  DROP CONSTRAINT IF EXISTS awcms_commerce_loyalty_ledger_sign_check;
ALTER TABLE awcms_commerce_loyalty_ledger
  ADD CONSTRAINT awcms_commerce_loyalty_ledger_sign_check
  CHECK (
    (kind = 'earn' AND points > 0)
    OR (kind = 'redeem' AND points < 0)
    OR (kind = 'expire' AND points <= 0)
    OR (kind = 'adjustment' AND points <> 0)
    OR (kind = 'reversal' AND points <> 0)
    OR (kind = 'restore' AND points > 0)
  );

-- A reversal and a restore each name the row they compensate; nothing else does.
ALTER TABLE awcms_commerce_loyalty_ledger
  DROP CONSTRAINT IF EXISTS awcms_commerce_loyalty_ledger_reversal_target_check;
ALTER TABLE awcms_commerce_loyalty_ledger
  ADD CONSTRAINT awcms_commerce_loyalty_ledger_reversal_target_check
  CHECK ((kind IN ('reversal', 'restore')) = (reverses_entry_id IS NOT NULL));

-- Only an earn lot and a restore lot may lapse.
ALTER TABLE awcms_commerce_loyalty_ledger
  DROP CONSTRAINT IF EXISTS awcms_commerce_loyalty_ledger_expiry_only_on_earn_check;
ALTER TABLE awcms_commerce_loyalty_ledger
  ADD CONSTRAINT awcms_commerce_loyalty_ledger_expiry_only_on_earn_check
  CHECK (expires_at IS NULL OR kind IN ('earn', 'restore'));

-- A refund-sourced entry names the refund it came from: a reversal of the
-- earn, or (new) a restore of the redemption.
ALTER TABLE awcms_commerce_loyalty_ledger
  DROP CONSTRAINT IF EXISTS awcms_commerce_loyalty_ledger_refund_source_check;
ALTER TABLE awcms_commerce_loyalty_ledger
  ADD CONSTRAINT awcms_commerce_loyalty_ledger_refund_source_check
  CHECK (
    source_type <> 'refund'
    OR (kind IN ('reversal', 'restore') AND source_id IS NOT NULL)
  );

-- A restore comes from a cancelled/expired order or a settled refund only.
ALTER TABLE awcms_commerce_loyalty_ledger
  DROP CONSTRAINT IF EXISTS awcms_commerce_loyalty_ledger_restore_source_check;
ALTER TABLE awcms_commerce_loyalty_ledger
  ADD CONSTRAINT awcms_commerce_loyalty_ledger_restore_source_check
  CHECK (kind <> 'restore' OR (source_type IN ('order', 'refund') AND source_id IS NOT NULL));

-- The expiry scan (`expireDueLoyaltyPointsForTenant`, and the lazy expiry that
-- runs before every spend) now looks at restore lots as well as earn lots, so
-- its supporting partial index widens to match. Same name, same columns.
DROP INDEX IF EXISTS awcms_commerce_loyalty_ledger_expiring_idx;
CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_ledger_expiring_idx
  ON awcms_commerce_loyalty_ledger (tenant_id, expires_at)
  WHERE kind IN ('earn', 'restore') AND expires_at IS NOT NULL;

-- An issued document is a copy of its order and its trigger insists the money
-- matches (`sql/980`). Its `discount` is everything the customer did not pay in
-- money, so it now also counts the points discount - otherwise an invoice for an
-- order that spent points could never be issued. Orders without a points
-- discount (`loyalty_discount = 0`, every existing row) compare exactly as
-- before. Only the discount comparison changes; the rest of the function is
-- `sql/980`'s, unchanged.
CREATE OR REPLACE FUNCTION awcms_commerce_documents_match_source()
RETURNS trigger AS $awcms_commerce_documents_match_source$
DECLARE
  src record;
BEGIN
  SELECT subtotal, discount, voucher_discount, loyalty_discount, shipping_cost, insurance_fee, tax, total,
         status, payment_status
  INTO src
  FROM awcms_commerce_orders
  WHERE tenant_id = NEW.tenant_id AND id = NEW.source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document source order % does not exist', NEW.source_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF src.subtotal IS DISTINCT FROM NEW.subtotal
    OR (src.discount + src.voucher_discount + src.loyalty_discount) IS DISTINCT FROM NEW.discount
    OR src.shipping_cost IS DISTINCT FROM NEW.shipping_cost
    OR src.insurance_fee IS DISTINCT FROM NEW.insurance_fee
    OR src.tax IS DISTINCT FROM NEW.tax
    OR src.total IS DISTINCT FROM NEW.total
  THEN
    RAISE EXCEPTION
      'document % money does not match its source order %: a document is a copy of the order, never a second authority',
      NEW.number, NEW.source_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF src.status IN ('cancelled', 'expired') THEN
    RAISE EXCEPTION 'order % is % and cannot be documented', NEW.source_id, src.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.doc_type = 'receipt' AND src.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'a receipt needs a fully paid order (order % is %)', NEW.source_id, src.payment_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_documents_match_source$ LANGUAGE plpgsql;
