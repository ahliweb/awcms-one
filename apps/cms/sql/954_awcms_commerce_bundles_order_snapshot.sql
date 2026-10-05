-- Issue #290 (epic #281, ADR-0036 D5) — the immutable per-order snapshot of what
-- a bundle line was made of when it was sold.
--
-- A bundle sells as ONE order line (price = the bundle's price). This table
-- holds, per such line, one row per component: which component it was, how
-- many units per bundle and in total, its descriptive text AS SOLD (sku, name,
-- variant name) and the share of the line total it carries
-- (`allocated_value`, numeric(14,2); the shares sum to the line total exactly,
-- split by component list value with largest-remainder cents).
--
-- It is what the cancel/expiry restock and a return's restock read, so editing
-- or deleting a bundle definition afterwards can never change what an old
-- order's stock movement undoes. Rows are append-only: a trigger refuses an
-- UPDATE, and the application role holds no DELETE (the retention engine,
-- `awcms_worker`, may, and a purged order item cascades its rows away).
--
-- ADR-0037 D2: depends on commerce <= 953 only. The (tenant_id, id) key on
-- order items that sql/994 also creates is created here first under the same
-- name, so 994 is a no-op.

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_order_items_tenant_id_id_key
  ON awcms_commerce_order_items (tenant_id, id);

CREATE TABLE IF NOT EXISTS awcms_commerce_order_item_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_item_id uuid NOT NULL,
  position smallint NOT NULL,
  component_product_id uuid NOT NULL,
  component_variant_id uuid,
  sku text,
  name text NOT NULL,
  variant_name text,
  quantity_per_bundle integer NOT NULL,
  quantity_total integer NOT NULL,
  allocated_value numeric(14, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_order_item_components_item_fk
    FOREIGN KEY (tenant_id, order_item_id)
    REFERENCES awcms_commerce_order_items (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_order_item_components_product_fk
    FOREIGN KEY (tenant_id, component_product_id)
    REFERENCES awcms_commerce_products (tenant_id, id),
  CONSTRAINT awcms_commerce_order_item_components_variant_fk
    FOREIGN KEY (component_variant_id, component_product_id)
    REFERENCES awcms_commerce_product_variants (id, product_id),
  CONSTRAINT awcms_commerce_order_item_components_position_check
    CHECK (position BETWEEN 1 AND 20),
  CONSTRAINT awcms_commerce_order_item_components_quantity_check
    CHECK (
      quantity_per_bundle > 0
      AND quantity_total >= quantity_per_bundle
      AND quantity_total % quantity_per_bundle = 0
    ),
  CONSTRAINT awcms_commerce_order_item_components_value_check
    CHECK (allocated_value >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_order_item_components_position_key
  ON awcms_commerce_order_item_components (tenant_id, order_item_id, position);

CREATE INDEX IF NOT EXISTS awcms_commerce_order_item_components_product_idx
  ON awcms_commerce_order_item_components (tenant_id, component_product_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_order_item_components_variant_idx
  ON awcms_commerce_order_item_components (component_variant_id, component_product_id);
-- The retention engine's (tenant, cursor) read.
CREATE INDEX IF NOT EXISTS awcms_commerce_order_item_components_tenant_created_idx
  ON awcms_commerce_order_item_components (tenant_id, created_at);

ALTER TABLE awcms_commerce_order_item_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_order_item_components FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_order_item_components_tenant_isolation
  ON awcms_commerce_order_item_components
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE UPDATE, DELETE ON awcms_commerce_order_item_components FROM awcms_app;

CREATE OR REPLACE FUNCTION awcms_commerce_order_item_components_immutable()
RETURNS trigger AS $awcms_commerce_order_item_components_immutable$
BEGIN
  RAISE EXCEPTION '% rows are append-only (an order''s bundle snapshot never changes)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$awcms_commerce_order_item_components_immutable$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_order_item_components_immutable
  ON awcms_commerce_order_item_components;
CREATE TRIGGER awcms_commerce_order_item_components_immutable
  BEFORE UPDATE ON awcms_commerce_order_item_components
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_order_item_components_immutable();

COMMENT ON TABLE awcms_commerce_order_item_components IS
  'Issue #290 (ADR-0036) — immutable snapshot of a bundle order line''s components (units, text as sold, allocated value). Append-only.';
