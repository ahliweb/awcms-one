-- Commerce - booking revenue slice per the owner decisions of #450: refunds count
-- when they are DECIDED, and every refund and uncollected amount is allocated
-- across goods, shipping, insurance and tax (Issue #478; spec
-- `docs/aw-business-platform-metrics.md` sections 3.9 D1 and D3; ADR-0045
-- "Owner decisions on the booking revenue slice"; parent sql/1047).
--
-- ONE table changes, `awcms_commerce_report_booking_orders` (the per-order row of
-- the `commerce.booking_revenue` projection): seven ADDITIVE money columns, no new
-- table, no new role and no new grant (sql/1047's table-level SELECT / INSERT /
-- UPDATE / DELETE for `awcms_worker`, `awcms_app`'s default privileges, ENABLE and
-- FORCE ROW LEVEL SECURITY and the tenant-isolation policy all cover a new column
-- of the same table). No down migration: the columns default to 0 and the
-- projection ignores them if the code is rolled back.
--
--   refund_payable      money decided to be refunded and not yet paid out (a
--                       return record exists, the reversal leg has not settled:
--                       planned, processing or failed). A new companion column
--                       beside `outstanding` (D1). Settling a leg moves cents
--                       from `refund_payable` to `paid_back` and NEVER moves net.
--   goods_paid_back     the GOODS share (subtotal less discount) of `paid_back`
--   goods_payable       the GOODS share of `refund_payable`
--   goods_uncollected   the GOODS share of `uncollected`
--                       -> the three add up to the Refunds step of the waterfall;
--                       net = gross - discount - (the three) (D3).
--   shipping_refunded   what refunds AND the uncollected balance took out of the
--   insurance_refunded  shipping / insurance / tax companion column, so a full
--   tax_refunded        refund of a taxed order leaves tax 0 and net 0 and never a
--                       negative net (tax collected is not revenue).
--
-- `paid_back` and `uncollected` keep their meaning: the MONEY that went back and
-- the MONEY that will never be collected, all components. They stay the base of the
-- settled figure and of the balance CHECK of sql/1047. The new control identity is
--
--   net + shipping + insurance + tax (each after its refunded share)
--     = settled - refund_payable + outstanding - surplus
--
-- ## Rollout: descriptor version 1 -> 2, one rebuild per tenant
--
-- `commerce.booking_revenue` goes from descriptor version 1 to 2 in the same change.
-- A tenant that already sold bookings runs ONE rebuild of the projection
-- (`POST /api/v1/reports/projections/commerce.booking_revenue/rebuild`), which
-- re-derives every row from the order, the payment ledger, the return records and
-- the adapter's refund decisions and restates the prior days (the 35-day
-- restatement flag applies to a late event on the live path, never to a rebuild).
--
-- Until that rebuild runs the existing rows must keep reading as they did, so the
-- three goods shares are seeded from the money columns here: before D3 every paid
-- back and uncollected cent was a goods cent. That is exactly what the previous
-- release reported, so nothing visible changes for a tenant that has not rebuilt
-- yet, and the rebuild (which rewrites every row) replaces the seed. The UPDATE
-- touches only rows with a refund or an uncollected balance, and re-running this
-- file changes nothing (the guard needs all three goods shares to still be zero).
-- The migration runs as the owner role (sql/019: BYPASSRLS), across tenants.

-- One statement per column: scripts/subject-data-registry-check.ts reads the
-- first column of an ALTER TABLE ... ADD COLUMN list only.
ALTER TABLE awcms_commerce_report_booking_orders
  ADD COLUMN IF NOT EXISTS refund_payable numeric(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE awcms_commerce_report_booking_orders
  ADD COLUMN IF NOT EXISTS goods_paid_back numeric(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE awcms_commerce_report_booking_orders
  ADD COLUMN IF NOT EXISTS goods_payable numeric(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE awcms_commerce_report_booking_orders
  ADD COLUMN IF NOT EXISTS goods_uncollected numeric(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE awcms_commerce_report_booking_orders
  ADD COLUMN IF NOT EXISTS shipping_refunded numeric(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE awcms_commerce_report_booking_orders
  ADD COLUMN IF NOT EXISTS insurance_refunded numeric(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE awcms_commerce_report_booking_orders
  ADD COLUMN IF NOT EXISTS tax_refunded numeric(14, 2) NOT NULL DEFAULT 0;

-- Seed the goods shares of the rows that exist before the rebuild (see above).
-- The seed is capped at the goods of the order (a taxed order that was fully
-- refunded read net < 0 before; the cap keeps the CHECK below valid for it, and the
-- rebuild computes the real shares anyway).
UPDATE awcms_commerce_report_booking_orders
SET goods_paid_back = LEAST(paid_back, GREATEST(gross - discount, 0)),
    goods_uncollected = LEAST(
      uncollected,
      GREATEST(gross - discount, 0)
        - LEAST(paid_back, GREATEST(gross - discount, 0))
    )
WHERE (paid_back > 0 OR uncollected > 0)
  AND goods_paid_back = 0
  AND goods_payable = 0
  AND goods_uncollected = 0;

-- Constraints are added once; a re-run of the file must not fail on them.
DO $awcms_booking_revenue_refund_payable$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'awcms_commerce_report_booking_orders_refund_money_check'
  ) THEN
    ALTER TABLE awcms_commerce_report_booking_orders
      ADD CONSTRAINT awcms_commerce_report_booking_orders_refund_money_check
      CHECK (refund_payable >= 0 AND goods_paid_back >= 0 AND goods_payable >= 0
        AND goods_uncollected >= 0 AND shipping_refunded >= 0
        AND insurance_refunded >= 0 AND tax_refunded >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'awcms_commerce_report_booking_orders_refund_share_check'
  ) THEN
    -- A share is part of the money it belongs to, and the three goods shares can
    -- never take more than the goods of the order (net never goes below zero).
    ALTER TABLE awcms_commerce_report_booking_orders
      ADD CONSTRAINT awcms_commerce_report_booking_orders_refund_share_check
      CHECK (goods_paid_back <= paid_back
        AND goods_payable <= refund_payable
        AND goods_uncollected <= uncollected
        AND goods_paid_back + goods_payable + goods_uncollected
          <= GREATEST(gross - discount, 0)
        AND shipping_refunded <= shipping
        AND insurance_refunded <= insurance
        AND tax_refunded <= tax);
  END IF;
END
$awcms_booking_revenue_refund_payable$;

COMMENT ON COLUMN awcms_commerce_report_booking_orders.refund_payable IS
  'Issue #478 (metrics 3.9 D1) - money decided to be refunded (a return record exists) and not yet paid out; settling a leg moves cents from here to paid_back and never moves net.';
COMMENT ON COLUMN awcms_commerce_report_booking_orders.goods_paid_back IS
  'Issue #478 (metrics 3.9 D3) - the goods share (subtotal less discount) of paid_back; one of the three parts of the Refunds step.';
COMMENT ON COLUMN awcms_commerce_report_booking_orders.goods_payable IS
  'Issue #478 (metrics 3.9 D1, D3) - the goods share of refund_payable; one of the three parts of the Refunds step.';
COMMENT ON COLUMN awcms_commerce_report_booking_orders.goods_uncollected IS
  'Issue #478 (metrics 3.9 D3) - the goods share of uncollected; one of the three parts of the Refunds step.';
COMMENT ON COLUMN awcms_commerce_report_booking_orders.shipping_refunded IS
  'Issue #478 (metrics 3.9 D3) - the part of the shipping companion that refunds and the uncollected balance took out of it.';
COMMENT ON COLUMN awcms_commerce_report_booking_orders.insurance_refunded IS
  'Issue #478 (metrics 3.9 D3) - the part of the insurance companion that refunds and the uncollected balance took out of it.';
COMMENT ON COLUMN awcms_commerce_report_booking_orders.tax_refunded IS
  'Issue #478 (metrics 3.9 D3) - the part of the tax companion that refunds and the uncollected balance took out of it; tax collected is not revenue.';
