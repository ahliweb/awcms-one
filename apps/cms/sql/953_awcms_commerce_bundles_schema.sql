-- Issue #290 (epic #281, ADR-0036) — item kits / product bundles.
--
-- A bundle is a PRODUCT with `kind = 'bundle'`: it carries no variants and no
-- stock of its own, and is made of 1-20 component lines, each naming a
-- component product (and variant, when that product has live variants) and a
-- quantity per bundle. It is sold as ONE order line; the components are what
-- the stock movement touches (D6). Cycles are impossible by construction:
-- nesting is rejected, so a component is never itself a bundle.
--
-- Not to be confused with `awcms_commerce_products.type = 'bundle'` (sql/935,
-- issue #266): that is a descriptive product TYPE for entitlement-style
-- packages and has no stock semantics. `kind` is the inventory-bearing
-- discriminator; a product may be `type = 'bundle'` and `kind = 'standard'`.
--
-- ADR-0037 D2: this migration depends only on lower-numbered objects (commerce
-- <= 948 and upstream). In particular the two composite-FK target indexes that
-- sql/960 also creates are created here first, IF NOT EXISTS, under the same
-- names, so 960 is a no-op and this file never depends on it.
--
-- Tenant safety does not rest on application checks alone: FK checks bypass
-- RLS, so every reference below is composite and carries the tenant.

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_products_tenant_id_id_key
  ON awcms_commerce_products (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_product_variants_id_product_key
  ON awcms_commerce_product_variants (id, product_id);

ALTER TABLE awcms_commerce_products
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'standard';

ALTER TABLE awcms_commerce_products
  ADD COLUMN IF NOT EXISTS bundle_pricing text NOT NULL DEFAULT 'fixed';

ALTER TABLE awcms_commerce_products
  ADD COLUMN IF NOT EXISTS bundle_discount_percent numeric(5, 2);

ALTER TABLE awcms_commerce_products
  DROP CONSTRAINT IF EXISTS awcms_commerce_products_kind_check;
ALTER TABLE awcms_commerce_products
  ADD CONSTRAINT awcms_commerce_products_kind_check
  CHECK (kind IN ('standard', 'bundle'));

ALTER TABLE awcms_commerce_products
  DROP CONSTRAINT IF EXISTS awcms_commerce_products_bundle_pricing_check;
ALTER TABLE awcms_commerce_products
  ADD CONSTRAINT awcms_commerce_products_bundle_pricing_check
  CHECK (bundle_pricing IN ('fixed', 'derived'));

ALTER TABLE awcms_commerce_products
  DROP CONSTRAINT IF EXISTS awcms_commerce_products_bundle_discount_check;
ALTER TABLE awcms_commerce_products
  ADD CONSTRAINT awcms_commerce_products_bundle_discount_check
  CHECK (
    bundle_discount_percent IS NULL
    OR (
      bundle_pricing = 'derived'
      AND bundle_discount_percent >= 0
      AND bundle_discount_percent <= 100
    )
  );

-- A standard product carries the defaults; a bundle has no stock of its own
-- (the column is kept 0 and ignored: availability is computed from the
-- components) and is not a service product.
ALTER TABLE awcms_commerce_products
  DROP CONSTRAINT IF EXISTS awcms_commerce_products_bundle_shape_check;
ALTER TABLE awcms_commerce_products
  ADD CONSTRAINT awcms_commerce_products_bundle_shape_check
  CHECK (
    (kind = 'bundle' AND stock = 0 AND service_form IS NULL)
    OR (
      kind = 'standard'
      AND bundle_pricing = 'fixed'
      AND bundle_discount_percent IS NULL
    )
  );

COMMENT ON COLUMN awcms_commerce_products.kind IS
  'standard | bundle (Issue #290, ADR-0036). A bundle has no variants and no own stock; its components are in awcms_commerce_bundle_components.';
COMMENT ON COLUMN awcms_commerce_products.bundle_pricing IS
  'fixed (the bundle''s own price) | derived (sum of component list prices x quantity, less bundle_discount_percent). Meaningful for kind = bundle only.';

-- ---------------------------------------------------------------------------
-- components
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_bundle_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  bundle_product_id uuid NOT NULL,
  position smallint NOT NULL,
  component_product_id uuid NOT NULL,
  component_variant_id uuid,
  quantity integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The staff member who last saved the definition; informational, no FK (a
  -- tenant user may be anonymised) - the audit log is the evidence.
  actor_tenant_user_id uuid,
  -- An edit replaces the component list: the replaced lines are SOFT-deleted
  -- (the generic retention engine's cursor, like every catalog table), never
  -- read again, and aged out by the purge. A LIVE line is never a candidate.
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_bundle_components_bundle_fk
    FOREIGN KEY (tenant_id, bundle_product_id)
    REFERENCES awcms_commerce_products (tenant_id, id),
  CONSTRAINT awcms_commerce_bundle_components_product_fk
    FOREIGN KEY (tenant_id, component_product_id)
    REFERENCES awcms_commerce_products (tenant_id, id),
  -- A variant must belong to the component product (and, through that, to the
  -- tenant). MATCH SIMPLE: skipped while component_variant_id is NULL.
  CONSTRAINT awcms_commerce_bundle_components_variant_fk
    FOREIGN KEY (component_variant_id, component_product_id)
    REFERENCES awcms_commerce_product_variants (id, product_id),
  CONSTRAINT awcms_commerce_bundle_components_position_check
    CHECK (position BETWEEN 1 AND 20),
  CONSTRAINT awcms_commerce_bundle_components_quantity_check
    CHECK (quantity > 0 AND quantity <= 10000),
  CONSTRAINT awcms_commerce_bundle_components_not_self_check
    CHECK (bundle_product_id <> component_product_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_bundle_components_position_key
  ON awcms_commerce_bundle_components (tenant_id, bundle_product_id, position)
  WHERE deleted_at IS NULL;

-- One line per (component product, variant) in a bundle; NULL variants compare
-- equal through the COALESCE so "the product itself" is also unique.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_bundle_components_target_key
  ON awcms_commerce_bundle_components (
    tenant_id,
    bundle_product_id,
    component_product_id,
    COALESCE(component_variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE deleted_at IS NULL;

-- FK indexes (db:fk-index) and the "is this product a component anywhere?" read.
CREATE INDEX IF NOT EXISTS awcms_commerce_bundle_components_component_idx
  ON awcms_commerce_bundle_components (tenant_id, component_product_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_bundle_components_variant_idx
  ON awcms_commerce_bundle_components (component_variant_id, component_product_id);
-- The (tenant, cursor) composite the generic purge engine filters + orders by.
CREATE INDEX IF NOT EXISTS awcms_commerce_bundle_components_tenant_deleted_idx
  ON awcms_commerce_bundle_components (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_bundle_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_bundle_components FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_bundle_components_tenant_isolation
  ON awcms_commerce_bundle_components
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Component guard. Row locks make the nesting rule race-free: the bundle row is
-- locked FOR NO KEY UPDATE (one writer per bundle, so the 20-line cap cannot be
-- raced past), and the component product row FOR SHARE (a concurrent
-- "turn this product into a bundle" UPDATE of it waits, then its own guard
-- sees this row).
CREATE OR REPLACE FUNCTION awcms_commerce_bundle_components_guard()
RETURNS trigger AS $awcms_commerce_bundle_components_guard$
DECLARE
  bundle_kind text;
  component_kind text;
  component_deleted timestamptz;
  live_variants integer;
  existing_lines integer;
  variant_deleted timestamptz;
BEGIN
  -- A line being soft-deleted (replaced by an edit) is on its way out and is
  -- not re-checked: the component product may itself have been deleted since.
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT kind INTO bundle_kind
  FROM awcms_commerce_products
  WHERE tenant_id = NEW.tenant_id AND id = NEW.bundle_product_id
  FOR NO KEY UPDATE;
  IF NOT FOUND OR bundle_kind <> 'bundle' THEN
    RAISE EXCEPTION 'awcms_commerce_bundle_components: product % is not a bundle', NEW.bundle_product_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT kind, deleted_at INTO component_kind, component_deleted
  FROM awcms_commerce_products
  WHERE tenant_id = NEW.tenant_id AND id = NEW.component_product_id
  FOR SHARE;
  IF NOT FOUND OR component_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'awcms_commerce_bundle_components: component product % not found', NEW.component_product_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF component_kind = 'bundle' THEN
    RAISE EXCEPTION 'awcms_commerce_bundle_components: bundles cannot be nested (component % is a bundle)', NEW.component_product_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO live_variants
  FROM awcms_commerce_product_variants
  WHERE tenant_id = NEW.tenant_id
    AND product_id = NEW.component_product_id
    AND deleted_at IS NULL;
  IF NEW.component_variant_id IS NULL AND live_variants > 0 THEN
    RAISE EXCEPTION 'awcms_commerce_bundle_components: component product % has variants; name one', NEW.component_product_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.component_variant_id IS NOT NULL THEN
    SELECT deleted_at INTO variant_deleted
    FROM awcms_commerce_product_variants
    WHERE tenant_id = NEW.tenant_id AND id = NEW.component_variant_id;
    IF variant_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'awcms_commerce_bundle_components: component variant % is deleted', NEW.component_variant_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT count(*) INTO existing_lines
    FROM awcms_commerce_bundle_components
    WHERE tenant_id = NEW.tenant_id AND bundle_product_id = NEW.bundle_product_id
      AND deleted_at IS NULL;
    IF existing_lines >= 20 THEN
      RAISE EXCEPTION 'awcms_commerce_bundle_components: a bundle has at most 20 component lines'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$awcms_commerce_bundle_components_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_bundle_components_guard
  ON awcms_commerce_bundle_components;
CREATE TRIGGER awcms_commerce_bundle_components_guard
  BEFORE INSERT OR UPDATE ON awcms_commerce_bundle_components
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_bundle_components_guard();

-- Product-side guard: kind transitions. Turning a product INTO a bundle is
-- refused while it has live variants, is used as a component anywhere (no
-- nesting) or is in a flash sale (bundles are not flash-sale eligible); turning
-- a bundle back into a standard product is refused while it still has
-- components (clear them first).
CREATE OR REPLACE FUNCTION awcms_commerce_products_kind_guard()
RETURNS trigger AS $awcms_commerce_products_kind_guard$
BEGIN
  IF NEW.kind = 'bundle' AND OLD.kind = 'standard' THEN
    IF EXISTS (
      SELECT 1 FROM awcms_commerce_product_variants
      WHERE tenant_id = NEW.tenant_id AND product_id = NEW.id AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'awcms_commerce_products: product % has variants and cannot become a bundle', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM awcms_commerce_bundle_components
      WHERE tenant_id = NEW.tenant_id AND component_product_id = NEW.id
        AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'awcms_commerce_products: product % is a component of a bundle and cannot become one (no nesting)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM awcms_commerce_flash_sale_products
      WHERE tenant_id = NEW.tenant_id AND product_id = NEW.id AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'awcms_commerce_products: product % is in a flash sale and cannot become a bundle', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind = 'standard' AND OLD.kind = 'bundle' THEN
    IF EXISTS (
      SELECT 1 FROM awcms_commerce_bundle_components
      WHERE tenant_id = NEW.tenant_id AND bundle_product_id = NEW.id
        AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'awcms_commerce_products: bundle % still has components; remove them first', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$awcms_commerce_products_kind_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_products_kind_guard
  ON awcms_commerce_products;
CREATE TRIGGER awcms_commerce_products_kind_guard
  BEFORE UPDATE OF kind ON awcms_commerce_products
  FOR EACH ROW
  WHEN (OLD.kind IS DISTINCT FROM NEW.kind)
  EXECUTE FUNCTION awcms_commerce_products_kind_guard();

-- A bundle has no variants; a flash sale cannot name a bundle.
CREATE OR REPLACE FUNCTION awcms_commerce_bundle_no_variants_guard()
RETURNS trigger AS $awcms_commerce_bundle_no_variants_guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM awcms_commerce_products
    WHERE tenant_id = NEW.tenant_id AND id = NEW.product_id AND kind = 'bundle'
  ) THEN
    RAISE EXCEPTION 'awcms_commerce_product_variants: bundle % cannot have variants', NEW.product_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_bundle_no_variants_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_bundle_no_variants_guard
  ON awcms_commerce_product_variants;
CREATE TRIGGER awcms_commerce_bundle_no_variants_guard
  BEFORE INSERT ON awcms_commerce_product_variants
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_bundle_no_variants_guard();

CREATE OR REPLACE FUNCTION awcms_commerce_bundle_no_flash_sale_guard()
RETURNS trigger AS $awcms_commerce_bundle_no_flash_sale_guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM awcms_commerce_products
    WHERE tenant_id = NEW.tenant_id AND id = NEW.product_id AND kind = 'bundle'
  ) THEN
    RAISE EXCEPTION 'awcms_commerce_flash_sale_products: bundle % is not eligible for flash sales', NEW.product_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_bundle_no_flash_sale_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_bundle_no_flash_sale_guard
  ON awcms_commerce_flash_sale_products;
CREATE TRIGGER awcms_commerce_bundle_no_flash_sale_guard
  BEFORE INSERT OR UPDATE OF product_id ON awcms_commerce_flash_sale_products
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_bundle_no_flash_sale_guard();

COMMENT ON TABLE awcms_commerce_bundle_components IS
  'Issue #290 (ADR-0036) — the components of a bundle product: 1-20 lines of (component product, optional variant, quantity per bundle). No nesting (trigger).';
