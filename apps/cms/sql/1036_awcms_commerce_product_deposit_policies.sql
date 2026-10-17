-- Issue #378 (ADR-0045 D5, ADR-0041 D4, owner answer Q2) - the per-product
-- deposit policy. Data model: docs/booking-commerce-adapter-data-model.md
-- section 4.3.
--
-- A product WITHOUT an active row is paid in full. There is deliberately no
-- tenant-level row, setting or fallback (Q2): a deposit is a choice made per
-- product. A row says the deposit is a PERCENT of the line's taxed total (rounded
-- half up in integer cents) or a FIXED amount per unit of quantity (per night for
-- a nightly product), capped at the line total and floored at one cent when an
-- order is created. The result is SNAPSHOTTED on the order as `dp_amount` at
-- creation; a later edit of this table never alters an existing order, which is
-- why the table needs no versioning (the audit log is the history).
--
-- ## No DELETE; removal is a retirement
--
-- The data model reaches "full payment" by removing the row. The application
-- role has no DELETE here (an audit-relevant configuration fact is retired, not
-- erased), so removal sets `retired_at`; the active row is the one with
-- `retired_at IS NULL`, and a later policy for the same product is a new row.
-- A retired row is frozen.
--
-- ## `allow_dp` is a mirror (ADR-0045 D5)
--
-- `awcms_commerce_products.allow_dp` (sql/904) predates this table and nothing
-- read it as a rule. The product write path in `application/` sets it true when
-- it creates or keeps an active row and false when it retires one, in the same
-- transaction. THIS MIGRATION BACKFILLS NOTHING: D5's one-time backfill corrects
-- a product that has a policy row but a false flag, and no policy row exists
-- before this migration, so there is nothing to correct and no row is ever
-- invented (G10). A product with `allow_dp = true` and no row keeps today's
-- behaviour (the store-wide down-payment rule), which the cart quote falls back
-- to only when no row exists.
--
-- Money is numeric(14,2) (ADR-0003). Every trigger function pins search_path.

CREATE TABLE IF NOT EXISTS awcms_commerce_product_deposit_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  product_id uuid NOT NULL,
  kind text NOT NULL,
  percent numeric(5, 2),
  fixed_amount numeric(14, 2),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_product_deposit_policies_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_product_deposit_policies_product_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES awcms_commerce_products (tenant_id, id),
  CONSTRAINT awcms_commerce_product_deposit_policies_kind_check
    CHECK (kind IN ('percent', 'fixed')),
  CONSTRAINT awcms_commerce_product_deposit_policies_shape_check
    CHECK (
      (kind = 'percent'
        AND percent IS NOT NULL AND percent > 0 AND percent <= 100
        AND fixed_amount IS NULL)
      OR (kind = 'fixed'
        AND fixed_amount IS NOT NULL AND fixed_amount > 0
        AND percent IS NULL)
    )
);

-- At most one ACTIVE policy per product.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_product_deposit_policies_product_active_key
  ON awcms_commerce_product_deposit_policies (tenant_id, product_id)
  WHERE retired_at IS NULL;

-- The FK column's own index (db:fk-index) and the purge cursor.
CREATE INDEX IF NOT EXISTS awcms_commerce_product_deposit_policies_product_idx
  ON awcms_commerce_product_deposit_policies (tenant_id, product_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_product_deposit_policies_tenant_deleted_idx
  ON awcms_commerce_product_deposit_policies (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_product_deposit_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_product_deposit_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_product_deposit_policies_tenant_isolation
  ON awcms_commerce_product_deposit_policies
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE DELETE ON awcms_commerce_product_deposit_policies FROM awcms_app;

-- Identity columns are frozen; kind and amounts may be edited while the policy
-- is active; a retirement happens once and freezes the row. The BEGIN/END below
-- are PL/pgSQL block delimiters in a dollar-quoted body, not transaction control.
CREATE OR REPLACE FUNCTION awcms_commerce_product_deposit_policies_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $awcms_commerce_product_deposit_policies_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_product_deposit_policies row % is frozen: identity and product never change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.retired_at IS NOT NULL AND (
    NEW.retired_at IS DISTINCT FROM OLD.retired_at
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.percent IS DISTINCT FROM OLD.percent
    OR NEW.fixed_amount IS DISTINCT FROM OLD.fixed_amount
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_product_deposit_policies row % is retired and stays retired',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$awcms_commerce_product_deposit_policies_guard$;

DROP TRIGGER IF EXISTS awcms_commerce_product_deposit_policies_guard
  ON awcms_commerce_product_deposit_policies;
CREATE TRIGGER awcms_commerce_product_deposit_policies_guard
  BEFORE UPDATE ON awcms_commerce_product_deposit_policies
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_product_deposit_policies_guard();

COMMENT ON TABLE awcms_commerce_product_deposit_policies IS
  'Issue #378 (ADR-0045 D5, ADR-0041 D4) - per-product deposit policy (percent or fixed per unit). No active row = paid in full; there is no tenant default. The order snapshots the result as dp_amount, so edits never alter an order.';
