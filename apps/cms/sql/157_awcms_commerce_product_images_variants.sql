-- Issue #23 (part of #21) — the two related tables the storefront cannot
-- render a real product without: `product_images` and `product_variants`.
-- Both `sql/153`'s header named as deferred; this is the "additive, not a
-- rewrite" the header predicted.
--
-- ## `media_object_id` references `awcms_news_media_objects`, not a table
-- named `awcms_media_objects`
--
-- The issue's own column table writes "→ awcms_media_objects" as shorthand
-- for "the media registry" — the registry's REAL, historic table name is
-- `awcms_news_media_objects` (kept across the `news_portal` -> `blog_content`
-- merge, ADR-0036/ADR-0044), and that is what a FK must actually name. See
-- `_shared/ports/media-library-port.ts` and
-- `media-library/application/media-object-directory.ts`.
--
-- ## Images: `media_object_id NOT NULL` — a row IS the reference
--
-- Unlike a product's optional `size_chart_media_id`, a product-image row has
-- no reason to exist without pointing at a real media object; the row itself
-- is the join between a product and one of its pictures.
--
-- ## Variants: `sku` uniqueness is enforced HERE and in the application layer
--
-- The partial unique index below catches a same-table collision (two live
-- variants of the SAME OR DIFFERENT products sharing a SKU). It does NOT, and
-- cannot, catch a variant's SKU colliding with a PRODUCT's own
-- `awcms_commerce_products.sku` — that is a cross-table rule a single-table
-- index has no way to express, so `application/product-variant-directory.ts`
-- checks both tables before every INSERT/UPDATE (Issue #23's "shared with
-- products via a domain check"). This index is the same-table race-safety net
-- for exactly that check, not a substitute for it.
--
-- ## RLS, GRANTs, indexes — same conventions as `sql/153`
--
-- `ENABLE` + `FORCE ROW LEVEL SECURITY`, one tenant-isolation `USING` policy,
-- no per-table GRANT (`awcms_app` already holds table privileges via
-- `sql/019`'s `ALTER DEFAULT PRIVILEGES`), soft delete via `deleted_at`, an
-- FK index for every FK column (`db:fk-index:check`).

CREATE TABLE IF NOT EXISTS awcms_commerce_product_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  product_id uuid NOT NULL REFERENCES awcms_commerce_products (id),
  media_object_id uuid NOT NULL REFERENCES awcms_news_media_objects (id),
  sort_order integer NOT NULL DEFAULT 0,
  alt_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS awcms_commerce_product_images_tenant_idx
  ON awcms_commerce_product_images (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_product_images_tenant_deleted_idx
  ON awcms_commerce_product_images (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_product_images_product_idx
  ON awcms_commerce_product_images (product_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_product_images_media_object_idx
  ON awcms_commerce_product_images (media_object_id);

-- The list order a product detail page renders images in: live rows for one
-- product, by their own explicit `sort_order`.
CREATE INDEX IF NOT EXISTS awcms_commerce_product_images_product_sort_idx
  ON awcms_commerce_product_images (product_id, sort_order)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_commerce_product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_product_images FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_product_images_tenant_isolation
  ON awcms_commerce_product_images
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  product_id uuid NOT NULL REFERENCES awcms_commerce_products (id),
  name text NOT NULL,
  value text NOT NULL,
  color_hex text,
  image_media_object_id uuid REFERENCES awcms_news_media_objects (id),
  sku text,
  price numeric(14, 2),
  price_level_2 numeric(14, 2),
  price_level_3 numeric(14, 2),
  price_level_4 numeric(14, 2),
  stock integer NOT NULL DEFAULT 0,
  weight_grams integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_product_variants_price_check
    CHECK (price IS NULL OR price >= 0),
  CONSTRAINT awcms_commerce_product_variants_price_level_2_check
    CHECK (price_level_2 IS NULL OR price_level_2 >= 0),
  CONSTRAINT awcms_commerce_product_variants_price_level_3_check
    CHECK (price_level_3 IS NULL OR price_level_3 >= 0),
  CONSTRAINT awcms_commerce_product_variants_price_level_4_check
    CHECK (price_level_4 IS NULL OR price_level_4 >= 0),
  CONSTRAINT awcms_commerce_product_variants_stock_check
    CHECK (stock >= 0),
  CONSTRAINT awcms_commerce_product_variants_weight_grams_check
    CHECK (weight_grams >= 0)
);

-- Same-table half of the cross-table SKU rule — see header.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_product_variants_tenant_sku_key
  ON awcms_commerce_product_variants (tenant_id, sku)
  WHERE deleted_at IS NULL AND sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_product_variants_tenant_idx
  ON awcms_commerce_product_variants (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_product_variants_tenant_deleted_idx
  ON awcms_commerce_product_variants (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_product_variants_product_idx
  ON awcms_commerce_product_variants (product_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_product_variants_image_media_object_idx
  ON awcms_commerce_product_variants (image_media_object_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_product_variants_product_sort_idx
  ON awcms_commerce_product_variants (product_id, sort_order)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_commerce_product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_product_variants FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_product_variants_tenant_isolation
  ON awcms_commerce_product_variants
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
