-- Issue #23 — indexes backing `GET /api/v1/commerce/products`'s new
-- `?categoryId=&status=&q=&sort=&featured=&recommended=` filters.
--
-- ## `pg_trgm`, scoped exactly like `site_search`'s own precedent (`sql/064`)
--
-- `q` matches `name`/`sku` with `ILIKE '%term%'`, which a plain B-tree cannot
-- accelerate. Same tool, same narrow scope `sql/064`'s header already
-- justified for `site_search`'s title-prefix search: one GIN trigram index
-- per searched column, unscoped by tenant (a trigram index cannot usefully
-- be, and the query's own `tenant_id = $1` predicate is a separate, cheap
-- filter the planner combines with the trigram scan via a bitmap AND).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS awcms_commerce_products_name_trgm_idx
  ON awcms_commerce_products USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS awcms_commerce_products_sku_trgm_idx
  ON awcms_commerce_products USING GIN (sku gin_trgm_ops);

-- `?status=` — one live row's status per tenant, the common case ("show me
-- active/draft/... products").
CREATE INDEX IF NOT EXISTS awcms_commerce_products_tenant_status_idx
  ON awcms_commerce_products (tenant_id, status)
  WHERE deleted_at IS NULL;

-- `?featured=true` / `?recommended=true` — both flags default `false` and are
-- expected to be a SMALL slice of a tenant's catalog (a merchandising pick,
-- not the common case), so a PARTIAL index on the `true` value only is the
-- right shape: cheap to maintain (most rows never enter it) and small to scan.
CREATE INDEX IF NOT EXISTS awcms_commerce_products_tenant_featured_idx
  ON awcms_commerce_products (tenant_id)
  WHERE deleted_at IS NULL AND is_featured = true;

CREATE INDEX IF NOT EXISTS awcms_commerce_products_tenant_recommended_idx
  ON awcms_commerce_products (tenant_id)
  WHERE deleted_at IS NULL AND is_recommended = true;

-- `?sort=price_asc|price_desc` and `?sort=name` — see
-- `domain/product-sort.ts`'s header and `application/product-directory.ts`'s
-- `listProducts`: keyset pagination (`nextCursor`) stays scoped to the
-- default `sort=newest` in this increment, so these back a single bounded
-- page (`PRODUCT_LIST_LIMIT`) ordered by the chosen column, not a keyset walk.
CREATE INDEX IF NOT EXISTS awcms_commerce_products_tenant_price_idx
  ON awcms_commerce_products (tenant_id, price)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_products_tenant_name_idx
  ON awcms_commerce_products (tenant_id, name)
  WHERE deleted_at IS NULL;

-- `?parentId=` on `GET /api/v1/commerce/categories` — filters live categories
-- by their parent within a tenant (the FK index `awcms_commerce_categories_
-- parent_idx` already exists from `sql/901`, but it is not tenant-scoped nor
-- deleted-filtered, so a dedicated composite serves the actual query shape).
CREATE INDEX IF NOT EXISTS awcms_commerce_categories_tenant_parent_idx
  ON awcms_commerce_categories (tenant_id, parent_id)
  WHERE deleted_at IS NULL;
