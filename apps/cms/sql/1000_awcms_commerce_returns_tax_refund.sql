-- Issue #323 (ADR-0033 addendum, ADR-0039) — refund the tax on returned units.
--
-- A return's `refund_total` was `goods_gross - discount_share + shipping_refund`
-- and `sql/994` pinned it with a CHECK that had no tax term. In both tax modes
-- that meant the customer was never given back the tax charged on the units
-- they returned (flat), or the tax ledger (engine, #293) reversed an amount the
-- refund money did not include. This migration adds the missing component:
--
--   refund_total = goods_gross - discount_share + shipping_refund + tax_refund
--
-- `tax_refund` is the tax that was charged on the returned units:
--
--   * flat mode / orders with no tax snapshot: the order's stored tax prorated
--     per unit with the SAME largest-remainder + first-units-carry-the-cents
--     decomposition the returns code uses for goods and discount, so the tax
--     refunded across every return of an order never exceeds the order's tax
--     and equals it exactly once every unit has gone back;
--   * engine mode, exclusive pricing: the tax total of the return's reversal
--     snapshot in the tax ledger (`documentId = return:<id>`), so the money
--     refunded and the ledger agree to the cent;
--   * engine mode, inclusive pricing: 0 — the tax is already inside the goods
--     value the customer is refunded, adding it again would pay it twice.
--
-- Existing rows stay valid: the column defaults to 0 (what they were refunded)
-- and the CHECK is dropped and re-added by name with the extra term.
--
-- ADR-0037 D2: this alters the `994` returns table, so it takes a number ABOVE
-- every returns/report object (`1000`, the four-digit continuation that
-- upstream's ADR-0130 made sortable) rather than a gap number.

ALTER TABLE awcms_commerce_returns
  ADD COLUMN IF NOT EXISTS tax_refund numeric(14, 2) NOT NULL DEFAULT 0;

ALTER TABLE awcms_commerce_returns
  DROP CONSTRAINT IF EXISTS awcms_commerce_returns_amounts_check;

ALTER TABLE awcms_commerce_returns
  ADD CONSTRAINT awcms_commerce_returns_amounts_check
  CHECK (
    goods_gross >= 0 AND discount_share >= 0 AND shipping_refund >= 0
    AND tax_refund >= 0
    AND discount_share <= goods_gross
    AND refund_total = goods_gross - discount_share + shipping_refund + tax_refund
  );

-- Σ shipping refunded on an order may not exceed the shipping it was charged,
-- and (new) Σ tax refunded may not exceed the tax it was charged. Locks the
-- order row first (the same lock every ledger writer takes), so two returns of
-- one order cannot both pass the check.
CREATE OR REPLACE FUNCTION awcms_commerce_returns_insert_guard()
RETURNS trigger AS $awcms_commerce_returns_insert_guard$
DECLARE
  charged numeric(14, 2);
  charged_tax numeric(14, 2);
  already numeric(14, 2);
  already_tax numeric(14, 2);
BEGIN
  SELECT shipping_cost, tax INTO charged, charged_tax
  FROM awcms_commerce_orders
  WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'awcms_commerce_returns: order % not found', NEW.order_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT COALESCE(SUM(shipping_refund), 0), COALESCE(SUM(tax_refund), 0)
    INTO already, already_tax
  FROM awcms_commerce_returns
  WHERE tenant_id = NEW.tenant_id AND order_id = NEW.order_id;
  IF already + NEW.shipping_refund > COALESCE(charged, 0) THEN
    RAISE EXCEPTION
      'awcms_commerce_returns: shipping refunded on order % would exceed the shipping charged (%)',
      NEW.order_id, COALESCE(charged, 0)
      USING ERRCODE = 'check_violation';
  END IF;
  IF already_tax + NEW.tax_refund > COALESCE(charged_tax, 0) THEN
    RAISE EXCEPTION
      'awcms_commerce_returns: tax refunded on order % would exceed the tax charged (%)',
      NEW.order_id, COALESCE(charged_tax, 0)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_returns_insert_guard$ LANGUAGE plpgsql;

-- A return is history: `tax_refund` joins the immutable money columns.
CREATE OR REPLACE FUNCTION awcms_commerce_returns_update_guard()
RETURNS trigger AS $awcms_commerce_returns_update_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.note IS DISTINCT FROM OLD.note
    OR NEW.goods_gross IS DISTINCT FROM OLD.goods_gross
    OR NEW.discount_share IS DISTINCT FROM OLD.discount_share
    OR NEW.shipping_refund IS DISTINCT FROM OLD.shipping_refund
    OR NEW.tax_refund IS DISTINCT FROM OLD.tax_refund
    OR NEW.refund_total IS DISTINCT FROM OLD.refund_total
    OR NEW.source_key IS DISTINCT FROM OLD.source_key
    OR NEW.actor_tenant_user_id IS DISTINCT FROM OLD.actor_tenant_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_returns row % is history: only status and the exchange link may change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT (OLD.status = 'open' AND NEW.status = 'completed')
  THEN
    RAISE EXCEPTION
      'awcms_commerce_returns row % : status moves only open -> completed',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.exchange_order_id IS NOT NULL
    AND NEW.exchange_order_id IS DISTINCT FROM OLD.exchange_order_id
  THEN
    RAISE EXCEPTION
      'awcms_commerce_returns row % : the exchange order is linked once and never changed',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_returns_update_guard$ LANGUAGE plpgsql;

COMMENT ON COLUMN awcms_commerce_returns.tax_refund IS
  'Issue #323 — the tax charged on the returned units, refunded with them: the order tax prorated per unit (flat), or the reversal snapshot tax total (engine, exclusive pricing); 0 under inclusive pricing (the tax is already inside the goods value). refund_total = goods_gross - discount_share + shipping_refund + tax_refund.';
