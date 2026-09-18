-- Issue #23 (part of #21) — brings `awcms_commerce_products` from Issue #4's
-- 13-column catalog slice to full BjekMart product-model parity: every
-- deferred column `sql/901`'s header named as "deliberately deferred" lands
-- here, plus two merchandising flags (`is_featured`/`is_recommended`) that
-- replace BjekMart's ad-hoc `featuredProducts`/`recommendedProducts` heuristics
-- with explicit columns, plus `restored_at` for the restore endpoint below.
--
-- ## Still `numeric(14,2)` as a STRING, still never a float
--
-- `price_level_2/3/4`, `cost_price`, `insurance_fee` are every bit as much
-- money as `price` — `sql/901`'s header's arithmetic-drift reasoning applies
-- unchanged. `manual_rating` is `numeric(2,1)` (0.0-5.0): not money, but the
-- same "PostgreSQL owns the exact value, `Bun.SQL` hands it back as a string"
-- reasoning holds for any fixed-point column read through this driver.
--
-- ## `cost_price` is admin-only — enforced in the application layer, not here
--
-- The column carries no different ACCESS control than any other product
-- field (RLS is per-ROW, not per-COLUMN); `application/product-directory.ts`'s
-- public `toRecord()` simply never puts it on the DTO the public API/storefront
-- read, while `toAdminRecord()` does. A column-level privacy promise a
-- migration cannot enforce on its own is exactly why that split exists.
--
-- ## `size_chart_type`/`size_chart_media_id`/`size_chart_details` — one CHECK,
-- and a second enforcement layer in the application code
--
-- The CHECK below is a coarse backstop (each type requires ITS OWN carrier
-- column to be non-null) — `domain/size-chart.ts`'s `reconcileSizeChart` is
-- the ACTUAL cross-field rule (also clearing the irrelevant column when the
-- type changes), because a CHECK constraint cannot tell the application layer
-- WHICH field is wrong or apply the "clear the other one" convenience.
--
-- ## `service_form`/`variant_attributes`/`size_chart_details` are validated
-- shape, stored as-is
--
-- All three are `jsonb`, validated by `domain/service-form-validation.ts`,
-- `domain/variant-attributes-validation.ts`, and (loosely — any JSON
-- object/array) `product-validation.ts` respectively, before they ever reach
-- this column. Written with `${value}::jsonb` — the RAW value, never
-- `${JSON.stringify(value)}::jsonb` (`bun run db:jsonb-binding:check`, Issue
-- #641 — that spelling stores the jsonb SCALAR STRING, not the value).
--
-- ## `restored_at` on categories too — not in Issue #23's column table
--
-- The issue's schema table lists `restored_at` only under
-- `awcms_commerce_products`, because the "columns added" table is scoped to
-- that table. But the Application/API section adds a restore ROUTE for
-- categories as well (`POST .../categories/{id}/restore`), and recording WHEN
-- a row was restored is the same fact for either table — so
-- `awcms_commerce_categories` gets the identical nullable column here, for
-- symmetry with products and consistency with the `awcms_offices` shape this
-- module's README already cites as the restore precedent. Recorded as a
-- deliberate, additive decision for Issue #31 to fold into the schema docs.
ALTER TABLE awcms_commerce_categories
  ADD COLUMN IF NOT EXISTS restored_at timestamptz;

ALTER TABLE awcms_commerce_products
  ADD COLUMN IF NOT EXISTS price_level_2 numeric(14, 2),
  ADD COLUMN IF NOT EXISTS price_level_3 numeric(14, 2),
  ADD COLUMN IF NOT EXISTS price_level_4 numeric(14, 2),
  ADD COLUMN IF NOT EXISTS cost_price numeric(14, 2),
  ADD COLUMN IF NOT EXISTS min_purchase integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS weight_grams integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manual_rating numeric(2, 1),
  ADD COLUMN IF NOT EXISTS manual_sold_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS with_insurance boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS insurance_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS insurance_fee numeric(14, 2),
  ADD COLUMN IF NOT EXISTS promo_banner_show boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS promo_banner_title text,
  ADD COLUMN IF NOT EXISTS promo_banner_subtitle text,
  ADD COLUMN IF NOT EXISTS promo_banner_badge text,
  ADD COLUMN IF NOT EXISTS promo_banner_icon text,
  ADD COLUMN IF NOT EXISTS promo_banner_color text,
  ADD COLUMN IF NOT EXISTS size_chart_type text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS size_chart_media_id uuid REFERENCES awcms_news_media_objects (id),
  ADD COLUMN IF NOT EXISTS size_chart_details jsonb,
  ADD COLUMN IF NOT EXISTS service_form jsonb,
  ADD COLUMN IF NOT EXISTS subscription_period text,
  ADD COLUMN IF NOT EXISTS download_link text,
  ADD COLUMN IF NOT EXISTS allow_dp boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_free_shipping boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS variant_attributes jsonb,
  ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_recommended boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS restored_at timestamptz;

ALTER TABLE awcms_commerce_products
  ADD CONSTRAINT awcms_commerce_products_price_level_2_check
    CHECK (price_level_2 IS NULL OR price_level_2 >= 0),
  ADD CONSTRAINT awcms_commerce_products_price_level_3_check
    CHECK (price_level_3 IS NULL OR price_level_3 >= 0),
  ADD CONSTRAINT awcms_commerce_products_price_level_4_check
    CHECK (price_level_4 IS NULL OR price_level_4 >= 0),
  ADD CONSTRAINT awcms_commerce_products_cost_price_check
    CHECK (cost_price IS NULL OR cost_price >= 0),
  ADD CONSTRAINT awcms_commerce_products_min_purchase_check
    CHECK (min_purchase >= 1),
  ADD CONSTRAINT awcms_commerce_products_weight_grams_check
    CHECK (weight_grams >= 0),
  ADD CONSTRAINT awcms_commerce_products_manual_rating_check
    CHECK (manual_rating IS NULL OR (manual_rating >= 0 AND manual_rating <= 5)),
  ADD CONSTRAINT awcms_commerce_products_manual_sold_count_check
    CHECK (manual_sold_count >= 0),
  ADD CONSTRAINT awcms_commerce_products_insurance_fee_check
    CHECK (insurance_fee IS NULL OR insurance_fee >= 0),
  ADD CONSTRAINT awcms_commerce_products_size_chart_type_check
    CHECK (size_chart_type IN ('none', 'image', 'table')),
  -- Coarse backstop (see header) — the real cross-field rule, including
  -- clearing the irrelevant column on a type change, lives in
  -- `domain/size-chart.ts`'s `reconcileSizeChart`.
  ADD CONSTRAINT awcms_commerce_products_size_chart_carrier_check
    CHECK (
      (size_chart_type = 'none' AND size_chart_media_id IS NULL AND size_chart_details IS NULL)
      OR (size_chart_type = 'image' AND size_chart_media_id IS NOT NULL)
      OR (size_chart_type = 'table' AND size_chart_details IS NOT NULL)
    ),
  ADD CONSTRAINT awcms_commerce_products_subscription_period_check
    CHECK (subscription_period IS NULL OR subscription_period IN ('day', 'week', 'month', 'year'));

-- FK index for the new `size_chart_media_id` reference (`db:fk-index:check`).
CREATE INDEX IF NOT EXISTS awcms_commerce_products_size_chart_media_idx
  ON awcms_commerce_products (size_chart_media_id);
