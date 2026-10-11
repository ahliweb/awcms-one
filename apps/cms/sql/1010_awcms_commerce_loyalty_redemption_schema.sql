-- Issue #363 (Wave B, D7 carve-out of epic #280) - loyalty point redemption
-- into checkout and the POS. awcms-one ADR-0043 states the decisions; this
-- issue owns migrations 1010-1014 (ADR-0037): 1010 schema (this file), 1011
-- ledger integration, 1012 worker grants. 1013 and 1014 are held and unused.
--
-- Same conventions as `sql/940`/`sql/950` (not repeated in full): ENABLE +
-- FORCE ROW LEVEL SECURITY with one tenant-isolation policy, `numeric(14,2)`
-- money (ADR-0003), integer points, composite `(tenant_id, ...)` foreign keys,
-- an index for every FK column, `text` + CHECK for every enumerated column.
--
-- ## What a redemption is
--
-- Spending points on an order is two facts that must commit together or not at
-- all (threat-model control C-30): a `redeem` row on the append-only points
-- ledger (`sql/950`, the debit) and a DISCOUNT LINE on the order that reduces
-- the amount due. This file adds the discount line:
--
--   * `awcms_commerce_loyalty_redemptions` - one immutable row per order that
--     spent points: how many points, the rate and the cap in force, the goods
--     basis the cap was measured against, and the discount that resulted. The
--     rate is SNAPSHOTTED here, so changing the tenant's point value later
--     never alters an order that already exists, and a refund or restore is
--     always computed from what the customer was actually given.
--   * `awcms_commerce_orders.loyalty_discount` - the same discount on the order
--     header, so every reader that already reads `total` keeps one source. It
--     is NOT folded into `discount`/`voucher_discount`: those two already
--     overlap for a voucher order (a pre-existing quirk this change does not
--     touch), and a points discount must stay separately reportable and
--     separately refundable. `total` is the amount actually due, i.e. it is
--     already net of this discount.
--   * `awcms_commerce_loyalty_redemption_settings` - the tenant's point value,
--     and its optional cap. There is NO default row and no default value: a
--     tenant with no row has redemption unavailable (owner answer Q6, PRD L4).
--
-- ## Rounding cannot mint value
--
-- A point is a whole number and the rate is a whole number of rupiah, so the
-- discount is `points * rupiah_per_point` rupiah exactly. The CHECK on the
-- redemption row states that identity in the database, so not even an
-- application bug can record a discount that is not a whole-rupiah multiple of
-- the points spent.
--
-- ## Points and a refundable deposit are never combined (owner answer Q8)
--
-- `awcms_commerce_orders_loyalty_no_deposit_check` makes the combination
-- impossible below the application, in both directions: an order that carries
-- a points discount must not be a deposit order (`dp_amount` set and below the
-- total), and a deposit order cannot be given one afterwards.
--
-- ## Immutable
--
-- A redemption row is write-once: a trigger rejects every UPDATE and `awcms_app`
-- is REVOKEd UPDATE and DELETE. The reversal of a redemption is NOT an edit of
-- this row; it is a compensating `restore` row on the points ledger (`sql/1011`)
-- with its own source identity. "How much of this redemption is still in force"
-- is derived from the ledger, never stored.
--
-- ## Retention
--
-- The same fiscal-record class as the points ledger it belongs to (floor five
-- years, default and ceiling ten, `commerce/module.ts`). The ledger FK is
-- ON DELETE CASCADE so a ledger purge batch can never be blocked by, or split
-- from, its redemption; the account and order FKs are RESTRICT, so an account
-- or order still referenced by a redemption cannot be purged out from under it.

-- 1. settings ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_loyalty_redemption_settings (
  tenant_id uuid PRIMARY KEY REFERENCES awcms_tenants (id),
  -- What one point is worth, in whole rupiah. No default: absent row = off.
  rupiah_per_point integer NOT NULL,
  -- Optional cap on the share of the GOODS subtotal payable in points, as a
  -- whole percentage (1..100). NULL = no cap.
  max_goods_percent integer,
  updated_by_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_loyalty_redemption_settings_rate_check
    CHECK (rupiah_per_point BETWEEN 1 AND 1000000),
  CONSTRAINT awcms_commerce_loyalty_redemption_settings_cap_check
    CHECK (max_goods_percent IS NULL OR max_goods_percent BETWEEN 1 AND 100)
);

-- The (tenant, cursor) composite the generic purge engine filters + orders by.
CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_redemption_settings_tenant_updated_idx
  ON awcms_commerce_loyalty_redemption_settings (tenant_id, updated_at);

ALTER TABLE awcms_commerce_loyalty_redemption_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_loyalty_redemption_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY awcms_commerce_loyalty_redemption_settings_tenant_isolation
  ON awcms_commerce_loyalty_redemption_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- 2. the order discount line ------------------------------------------------

ALTER TABLE awcms_commerce_orders
  ADD COLUMN IF NOT EXISTS loyalty_discount numeric(14, 2) NOT NULL DEFAULT 0;

ALTER TABLE awcms_commerce_orders
  DROP CONSTRAINT IF EXISTS awcms_commerce_orders_loyalty_discount_check;
ALTER TABLE awcms_commerce_orders
  ADD CONSTRAINT awcms_commerce_orders_loyalty_discount_check
  CHECK (loyalty_discount >= 0);

-- Q8: points and a refundable deposit never share an order (both directions).
ALTER TABLE awcms_commerce_orders
  DROP CONSTRAINT IF EXISTS awcms_commerce_orders_loyalty_no_deposit_check;
ALTER TABLE awcms_commerce_orders
  ADD CONSTRAINT awcms_commerce_orders_loyalty_no_deposit_check
  CHECK (loyalty_discount = 0 OR dp_amount IS NULL OR dp_amount >= total);

-- 3. the redemption record --------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_loyalty_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_id uuid NOT NULL,
  account_id uuid NOT NULL,
  -- The `redeem` row on the points ledger this discount is the other half of.
  ledger_entry_id uuid NOT NULL,
  channel text NOT NULL,
  -- Whole points spent (> 0), the rate and cap in force at that instant.
  points bigint NOT NULL,
  rupiah_per_point integer NOT NULL,
  max_goods_percent integer,
  -- The goods subtotal the cap was measured against (subtotal less voucher
  -- discount): shipping, insurance and tax are never part of it.
  goods_basis numeric(14, 2) NOT NULL,
  discount numeric(14, 2) NOT NULL,
  -- When the points would lapse if they are given back: the soonest expiry
  -- among the earn lots this redemption consumed (NULL when every consumed lot
  -- was non-expiring). A restore row copies it, so redeeming and cancelling
  -- can never turn lapsing points into permanent ones (ADR-0043 D7).
  restore_expires_at timestamptz,
  -- The staff member who rang the sale up (POS); NULL for a storefront order.
  actor_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_loyalty_redemptions_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_loyalty_redemptions_account_fk
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES awcms_commerce_loyalty_accounts (tenant_id, id),
  CONSTRAINT awcms_commerce_loyalty_redemptions_ledger_fk
    FOREIGN KEY (tenant_id, ledger_entry_id)
    REFERENCES awcms_commerce_loyalty_ledger (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_loyalty_redemptions_channel_check
    CHECK (channel IN ('storefront', 'pos')),
  CONSTRAINT awcms_commerce_loyalty_redemptions_points_check
    CHECK (points > 0 AND points <= 1000000000000),
  CONSTRAINT awcms_commerce_loyalty_redemptions_rate_check
    CHECK (rupiah_per_point BETWEEN 1 AND 1000000),
  CONSTRAINT awcms_commerce_loyalty_redemptions_cap_check
    CHECK (max_goods_percent IS NULL OR max_goods_percent BETWEEN 1 AND 100),
  CONSTRAINT awcms_commerce_loyalty_redemptions_basis_check
    CHECK (goods_basis >= 0),
  -- Whole points at a whole-rupiah rate: the discount is EXACTLY their product.
  CONSTRAINT awcms_commerce_loyalty_redemptions_discount_check
    CHECK (discount > 0 AND discount = points::numeric * rupiah_per_point),
  -- Never more than the goods it pays for ...
  CONSTRAINT awcms_commerce_loyalty_redemptions_within_basis_check
    CHECK (discount <= goods_basis),
  -- ... nor more than the cap, when one was in force.
  CONSTRAINT awcms_commerce_loyalty_redemptions_within_cap_check
    CHECK (
      max_goods_percent IS NULL
      OR discount * 100 <= goods_basis * max_goods_percent
    )
);

-- One redemption per order, and one per ledger debit.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_loyalty_redemptions_order_key
  ON awcms_commerce_loyalty_redemptions (tenant_id, order_id);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_loyalty_redemptions_ledger_key
  ON awcms_commerce_loyalty_redemptions (tenant_id, ledger_entry_id);

-- FK index for `account_fk`; also "an account's redemptions, newest first".
CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_redemptions_account_idx
  ON awcms_commerce_loyalty_redemptions (tenant_id, account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_redemptions_tenant_idx
  ON awcms_commerce_loyalty_redemptions (tenant_id);

-- The (tenant, cursor) composite the generic purge engine filters + orders by.
CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_redemptions_tenant_created_idx
  ON awcms_commerce_loyalty_redemptions (tenant_id, created_at);

ALTER TABLE awcms_commerce_loyalty_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_loyalty_redemptions FORCE ROW LEVEL SECURITY;
CREATE POLICY awcms_commerce_loyalty_redemptions_tenant_isolation
  ON awcms_commerce_loyalty_redemptions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE OR REPLACE FUNCTION awcms_commerce_loyalty_redemptions_reject_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'awcms_commerce_loyalty_redemptions is write-once: a reversal is a compensating restore row on the points ledger'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS awcms_commerce_loyalty_redemptions_no_update
  ON awcms_commerce_loyalty_redemptions;
CREATE TRIGGER awcms_commerce_loyalty_redemptions_no_update
  BEFORE UPDATE ON awcms_commerce_loyalty_redemptions
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_loyalty_redemptions_reject_update();

-- Idempotent: REVOKE of a privilege not held is a silent no-op (sql/021).
REVOKE UPDATE, DELETE ON awcms_commerce_loyalty_redemptions FROM awcms_app;

COMMENT ON TABLE awcms_commerce_loyalty_redemptions IS
  'Issue #363 (ADR-0043) - the discount line of a points redemption: write-once, one per order, the rate and cap in force snapshotted. The debit is the paired redeem row on awcms_commerce_loyalty_ledger; a reversal is a restore row there, never an edit here.';
COMMENT ON TABLE awcms_commerce_loyalty_redemption_settings IS
  'Issue #363 (ADR-0043) - the tenant''s point value (whole rupiah per point) and optional cap on the share of the goods subtotal. No row = redemption unavailable; there is no default value.';
COMMENT ON COLUMN awcms_commerce_orders.loyalty_discount IS
  'Issue #363 - the points-redemption discount on this order (numeric(14,2), >= 0). `total` is already net of it. Separate from discount/voucher_discount on purpose.';
