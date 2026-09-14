-- Issue #4 (epic #1) — the catalog slice of the re-platformed storefront:
-- categories (hierarchical, self-referencing) and products, ported from the
-- legacy MySQL `commerce_bj_mart.{categories,products}` core catalog columns.
--
-- ## Money is `numeric(14,2)`, and crosses the wire as a STRING
--
-- `price` is never a float: binary floating point cannot represent `0.10`
-- exactly, and money arithmetic on it drifts — the classic `0.1 + 0.2 !==
-- 0.3` failure, except with a customer's invoice on the other end.
-- PostgreSQL `numeric(14,2)` is exact fixed-point (12 integer digits, 2
-- fractional — a Rupiah price into the hundreds of billions), `Bun.SQL` hands
-- a `numeric` column back as a STRING (never a JS `number`), and
-- `application/product-directory.ts` never parses it — the DTO keeps it a
-- string all the way to the storefront, which formats it with
-- `Intl.NumberFormat`. `discount_percent` and `stock` are plain `integer`:
-- neither is money, and both are exact in floating point anyway (0-100 and a
-- unit count), so `numeric` would only add ceremony.
--
-- ## Two independent axes: `status` and `deleted_at`
--
-- A product's lifecycle (`draft`/`active`/`inactive`/`archived`,
-- `product-status.ts`'s `LEGAL_TRANSITIONS`) and whether the row is
-- soft-deleted are deliberately separate. Pulling a product from sale
-- without losing it is `status = 'inactive'`; removing it from the tenant's
-- own catalog view is `deleted_at`. Conflating them would make "temporarily
-- unavailable" and "the merchant deleted this" the same state, which they
-- are not — a storefront or search index cares about the first, an admin
-- undo/audit trail cares about the second.
--
-- ## No `created_by`/`updated_by`/`deleted_by` columns
--
-- Unlike `awcms_offices` (`sql/002`), these tables carry no actor-stamp
-- columns at all. WHO created/changed/deleted a row lives only in the audit
-- log (`recordAuditEvent`'s `actorTenantUserId`) — this keeps the catalog
-- tables to exactly the columns Issue #4's table-convention list calls for,
-- and it is also what makes `commerce/module.ts`'s `subjectData` entries
-- honestly `unreachableBySubject`: there is no column here that could join a
-- row to a person even in principle.
--
-- ## No restore path (yet)
--
-- Issue #4 ships no `[id]/restore.ts` route (unlike `awcms_offices`'s), so
-- there is no `restored_at`/`restored_by` pair either — a soft-deleted row is
-- retained (for the FK integrity of anything that still references it) but
-- not exposed for recovery in this slice. Adding restore later is additive:
-- two nullable columns and an endpoint, no migration of existing rows.
--
-- ## Deliberately deferred (not in this schema at all)
--
-- `price_level_2/3/4` tiered pricing, `cost_price`, `affiliate_*`,
-- `size_chart_*`, `insurance_*`, `promo_banner_*`, `variant_attributes`, and
-- the related tables `product_images`, `product_variants`,
-- `flash_sale_products`, `product_affiliate_links`. None of this module's
-- code references them, so admitting them later is additive.
--
-- ## RLS, GRANTs, and everything else
--
-- Every table: `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, one
-- `USING (tenant_id = current_setting('app.current_tenant_id')::uuid)`
-- policy, no per-table `GRANT` — `awcms_app` already holds
-- `SELECT, INSERT, UPDATE, DELETE` on every table via `sql/019`'s
-- `ALTER DEFAULT PRIVILEGES`. `id uuid` PK `DEFAULT gen_random_uuid()`,
-- `created_at`/`updated_at timestamptz DEFAULT now()`, soft delete via
-- `deleted_at`, a partial unique index scoped `WHERE deleted_at IS NULL` so a
-- slug/sku frees up the instant its row is deleted, and a `CHECK` for every
-- enum-shaped column.

CREATE TABLE IF NOT EXISTS awcms_commerce_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  parent_id uuid REFERENCES awcms_commerce_categories (id),
  name text NOT NULL,
  slug text NOT NULL,
  icon text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_categories_tenant_slug_key
  ON awcms_commerce_categories (tenant_id, slug)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_categories_tenant_idx
  ON awcms_commerce_categories (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_categories_tenant_deleted_idx
  ON awcms_commerce_categories (tenant_id, deleted_at);

-- Covers both the hierarchy walk (list a category's children) and the FK
-- `db:fk-index:check` gate, which requires every FK column to have one.
CREATE INDEX IF NOT EXISTS awcms_commerce_categories_parent_idx
  ON awcms_commerce_categories (parent_id);

ALTER TABLE awcms_commerce_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_categories FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_categories_tenant_isolation
  ON awcms_commerce_categories
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  category_id uuid REFERENCES awcms_commerce_categories (id),
  type text NOT NULL DEFAULT 'physical',
  sku text NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  digital_note text,
  price numeric(14, 2) NOT NULL,
  discount_percent integer NOT NULL DEFAULT 0,
  stock integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  label text,
  label_color text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_products_type_check
    CHECK (type IN ('physical', 'digital', 'service', 'subscription')),
  CONSTRAINT awcms_commerce_products_status_check
    CHECK (status IN ('draft', 'active', 'inactive', 'archived')),
  CONSTRAINT awcms_commerce_products_price_check
    CHECK (price >= 0),
  CONSTRAINT awcms_commerce_products_discount_percent_check
    CHECK (discount_percent BETWEEN 0 AND 100),
  CONSTRAINT awcms_commerce_products_stock_check
    CHECK (stock >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_products_tenant_slug_key
  ON awcms_commerce_products (tenant_id, slug)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_products_tenant_sku_key
  ON awcms_commerce_products (tenant_id, sku)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_products_tenant_idx
  ON awcms_commerce_products (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_products_tenant_deleted_idx
  ON awcms_commerce_products (tenant_id, deleted_at);

-- FK index for `category_id` (`db:fk-index:check`), and the natural index for
-- "products in this category" once a category browse page needs it.
CREATE INDEX IF NOT EXISTS awcms_commerce_products_category_idx
  ON awcms_commerce_products (category_id);

ALTER TABLE awcms_commerce_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_products FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_products_tenant_isolation
  ON awcms_commerce_products
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
