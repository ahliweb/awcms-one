-- Issue #26 (part of epic #21) — the marketing surface BjekMart's home page
-- and promotions run on: flash sales, vouchers, sliders, testimonials, and a
-- promo popup. Five new tenant-scoped tables, all following `sql/901`'s
-- conventions exactly (see that file's header for the full reasoning this
-- migration does not repeat): `ENABLE` + `FORCE ROW LEVEL SECURITY`, one
-- tenant-isolation `USING` policy, `id uuid` PK `DEFAULT gen_random_uuid()`,
-- `created_at`/`updated_at timestamptz DEFAULT now()`, soft delete via
-- `deleted_at`, no per-table GRANT (`sql/019`'s `ALTER DEFAULT PRIVILEGES`
-- already covers it), an FK index for every FK column, and no
-- `created_by`/`updated_by`/`deleted_by` — same "WHO lives only in the audit
-- log" choice `sql/901`'s header made for this module, kept for every table
-- this module adds afterwards.
--
-- ## `awcms_commerce_flash_sales` / `awcms_commerce_flash_sale_products`
--
-- `status` is the EDITORIAL state only (`draft` or `scheduled` — the two
-- values a human may ever PATCH in) — `active`/`ended` are written ONLY by
-- the `commerce:flash-sales:tick` job, which derives them from
-- `now()`/`starts_at`/`ends_at` (`domain/flash-sale-status.ts`'s
-- `deriveFlashSaleStatus`) and never trusts a caller for them. The CHECK
-- below still allows all four values because the column legitimately holds
-- all four once the job has run — only the APPLICATION layer restricts what
-- a PATCH request may set.
--
-- `flash_sale_products` is a join/detail row (a `(flash_sale, product,
-- optional variant)` triple with its own `sale_price`/`quota`/`sold`) —
-- owned and edited through its flash sale, the same "sub-resource of editing
-- the parent" relationship `awcms_commerce_product_images`/`_variants` have
-- to their product (`sql/905`).
--
-- ## `awcms_commerce_vouchers`
--
-- `status` here is a plain admin on/off switch (`active`/`inactive`), never
-- time-derived like a flash sale's — a voucher's live-ness for
-- `POST .../validate` is `status = 'active' AND is_public-independent window/
-- quota checks` (`domain/voucher-arithmetic.ts`). A voucher that is
-- soft-deleted, inactive, or genuinely absent all resolve to the SAME
-- `not_found` outcome at that endpoint — the same
-- three-causes-one-answer shape `category-directory.ts`'s
-- `ParentCategoryNotFoundError` already uses in this module (GHSA-r7cx-c4jh-
-- cvvw's shape) — so `status` is deliberately NOT one of the `reason` values
-- the public contract enumerates.
--
-- ## `awcms_commerce_sliders` / `_testimonials` / `_popups`
--
-- `media_object_id` (sliders) is `NOT NULL` — same "the row IS the
-- reference" choice `sql/905` made for `product_images`, and for the same
-- reason: a slider with no image is not a slider. `avatar_media_object_id`
-- (testimonials) and `media_object_id` (popups) are nullable decorations —
-- same treatment `sql/905` gives a variant's optional
-- `image_media_object_id`. All three reference `awcms_news_media_objects`
-- (the media registry's real, historic table name — see `sql/905`'s header
-- for why the name does not match the module it belongs to).
--
-- `awcms_commerce_popups` additionally enforces "at most one ACTIVE popup per
-- tenant" with a partial unique index on `tenant_id` — cheaper and racier-safe
-- than an application-level check-then-insert, and it is what makes "the
-- popup" a well-defined singular thing for `GET .../popups/active` to answer.

CREATE TABLE IF NOT EXISTS awcms_commerce_flash_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  name text NOT NULL,
  slug text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_flash_sales_status_check
    CHECK (status IN ('draft', 'scheduled', 'active', 'ended')),
  CONSTRAINT awcms_commerce_flash_sales_window_check
    CHECK (ends_at > starts_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_flash_sales_tenant_slug_key
  ON awcms_commerce_flash_sales (tenant_id, slug)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_flash_sales_tenant_idx
  ON awcms_commerce_flash_sales (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_flash_sales_tenant_deleted_idx
  ON awcms_commerce_flash_sales (tenant_id, deleted_at);

-- The `commerce:flash-sales:tick` job's own scan: every non-draft, non-ended,
-- live row, tenant by tenant.
CREATE INDEX IF NOT EXISTS awcms_commerce_flash_sales_tick_idx
  ON awcms_commerce_flash_sales (tenant_id, status)
  WHERE deleted_at IS NULL AND status IN ('scheduled', 'active');

ALTER TABLE awcms_commerce_flash_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_flash_sales FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_flash_sales_tenant_isolation
  ON awcms_commerce_flash_sales
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_flash_sale_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  flash_sale_id uuid NOT NULL REFERENCES awcms_commerce_flash_sales (id),
  product_id uuid NOT NULL REFERENCES awcms_commerce_products (id),
  variant_id uuid REFERENCES awcms_commerce_product_variants (id),
  sale_price numeric(14, 2) NOT NULL,
  quota integer NOT NULL DEFAULT 0,
  sold integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_flash_sale_products_sale_price_check
    CHECK (sale_price >= 0),
  CONSTRAINT awcms_commerce_flash_sale_products_quota_check
    CHECK (quota >= 0),
  CONSTRAINT awcms_commerce_flash_sale_products_sold_check
    CHECK (sold >= 0)
);

-- One live row per (flash sale, product, variant) — a product may appear at
-- most once per sale (NULLS NOT DISTINCT so "no variant" collides with itself
-- too, matching a single-variant product's own uniqueness expectation).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_flash_sale_products_unique_key
  ON awcms_commerce_flash_sale_products (flash_sale_id, product_id, variant_id)
  NULLS NOT DISTINCT
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_flash_sale_products_tenant_idx
  ON awcms_commerce_flash_sale_products (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_flash_sale_products_tenant_deleted_idx
  ON awcms_commerce_flash_sale_products (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_flash_sale_products_flash_sale_idx
  ON awcms_commerce_flash_sale_products (flash_sale_id, sort_order)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_flash_sale_products_product_idx
  ON awcms_commerce_flash_sale_products (product_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_flash_sale_products_variant_idx
  ON awcms_commerce_flash_sale_products (variant_id);

ALTER TABLE awcms_commerce_flash_sale_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_flash_sale_products FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_flash_sale_products_tenant_isolation
  ON awcms_commerce_flash_sale_products
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  type text NOT NULL,
  value numeric(14, 2) NOT NULL,
  min_order numeric(14, 2) NOT NULL DEFAULT 0,
  max_discount numeric(14, 2),
  quota integer NOT NULL DEFAULT 0,
  used_count integer NOT NULL DEFAULT 0,
  is_public boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_vouchers_type_check
    CHECK (type IN ('percentage', 'nominal', 'free_shipping')),
  CONSTRAINT awcms_commerce_vouchers_status_check
    CHECK (status IN ('active', 'inactive')),
  CONSTRAINT awcms_commerce_vouchers_value_check
    CHECK (value >= 0),
  CONSTRAINT awcms_commerce_vouchers_min_order_check
    CHECK (min_order >= 0),
  CONSTRAINT awcms_commerce_vouchers_max_discount_check
    CHECK (max_discount IS NULL OR max_discount >= 0),
  CONSTRAINT awcms_commerce_vouchers_quota_check
    CHECK (quota >= 0),
  CONSTRAINT awcms_commerce_vouchers_used_count_check
    CHECK (used_count >= 0),
  CONSTRAINT awcms_commerce_vouchers_window_check
    CHECK (ends_at > starts_at)
);

-- `code` is matched case-sensitively as stored; `domain/voucher-validation.ts`
-- upper-cases it before every write/lookup, so this index is effectively
-- case-insensitive in practice without the storage/collation cost of a
-- functional index.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_vouchers_tenant_code_key
  ON awcms_commerce_vouchers (tenant_id, code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_vouchers_tenant_idx
  ON awcms_commerce_vouchers (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_vouchers_tenant_deleted_idx
  ON awcms_commerce_vouchers (tenant_id, deleted_at);

-- `GET /api/v1/commerce/vouchers/public`'s own scan: live, public, active,
-- in-window rows for one tenant.
CREATE INDEX IF NOT EXISTS awcms_commerce_vouchers_public_idx
  ON awcms_commerce_vouchers (tenant_id, is_public, status)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_commerce_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_vouchers FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_vouchers_tenant_isolation
  ON awcms_commerce_vouchers
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_sliders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  title text NOT NULL,
  subtitle text,
  media_object_id uuid NOT NULL REFERENCES awcms_news_media_objects (id),
  link_url text,
  button_text text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_sliders_window_check
    CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_sliders_tenant_idx
  ON awcms_commerce_sliders (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_sliders_tenant_deleted_idx
  ON awcms_commerce_sliders (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_sliders_media_object_idx
  ON awcms_commerce_sliders (media_object_id);

-- `GET /api/v1/commerce/sliders/active`'s own scan/order.
CREATE INDEX IF NOT EXISTS awcms_commerce_sliders_active_idx
  ON awcms_commerce_sliders (tenant_id, sort_order)
  WHERE deleted_at IS NULL AND is_active = true;

ALTER TABLE awcms_commerce_sliders ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_sliders FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_sliders_tenant_isolation
  ON awcms_commerce_sliders
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_testimonials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  author_name text NOT NULL,
  author_role text,
  body text NOT NULL,
  rating integer NOT NULL DEFAULT 5,
  avatar_media_object_id uuid REFERENCES awcms_news_media_objects (id),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_testimonials_rating_check
    CHECK (rating BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_testimonials_tenant_idx
  ON awcms_commerce_testimonials (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_testimonials_tenant_deleted_idx
  ON awcms_commerce_testimonials (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_testimonials_avatar_media_object_idx
  ON awcms_commerce_testimonials (avatar_media_object_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_testimonials_active_idx
  ON awcms_commerce_testimonials (tenant_id, sort_order)
  WHERE deleted_at IS NULL AND is_active = true;

ALTER TABLE awcms_commerce_testimonials ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_testimonials FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_testimonials_tenant_isolation
  ON awcms_commerce_testimonials
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_popups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  title text NOT NULL,
  body text,
  media_object_id uuid REFERENCES awcms_news_media_objects (id),
  link_url text,
  button_text text,
  frequency text NOT NULL DEFAULT 'once_per_day',
  is_active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_popups_frequency_check
    CHECK (frequency IN ('once_per_session', 'once_per_day', 'always')),
  CONSTRAINT awcms_commerce_popups_window_check
    CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_popups_tenant_idx
  ON awcms_commerce_popups (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_popups_tenant_deleted_idx
  ON awcms_commerce_popups (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_popups_media_object_idx
  ON awcms_commerce_popups (media_object_id);

-- "At most one ACTIVE popup per tenant" — the invariant `GET .../popups/active`
-- relies on to answer a single object rather than a list.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_popups_one_active_per_tenant
  ON awcms_commerce_popups (tenant_id)
  WHERE deleted_at IS NULL AND is_active = true;

ALTER TABLE awcms_commerce_popups ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_popups FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_popups_tenant_isolation
  ON awcms_commerce_popups
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
