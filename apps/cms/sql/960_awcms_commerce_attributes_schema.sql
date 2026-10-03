-- Issue #291 (epic #281) — typed custom catalog attributes.
--
-- Two tables, one contract (docs/adr/0027-catalog-custom-attributes-are-typed-
-- and-allowlisted.md):
--
--   awcms_commerce_attribute_definitions    the tenant-authored SCHEMA: a stable
--     slug `key`, a display label (+ per-locale labels), a value type, a closed
--     `constraints` document, the searchable/filterable/visibility flags, and
--     whether it applies to products, variants or both.
--   awcms_commerce_product_attribute_values the VALUES: one row per
--     (entity, definition), in the typed column that matches the definition's
--     type — never a stringly-typed blob.
--
-- ## Why typed columns instead of one jsonb document
--
-- A jsonb `attributes` column on products would be one column and zero
-- migrations, and it would make every filter a `->>`/cast expression built
-- from a caller-supplied key — which is exactly the dynamic-identifier
-- SQL-injection class OSPOS's custom-attribute search was patched for. Here a
-- filter binds a definition ID (a uuid the database issued) and compares a
-- fixed, typed column; there is no SQL text a request can influence. Typed
-- columns also give real range scans (scaled-integer/date b-tree) and a real
-- CHECK-able shape.
--
-- ## Locale-independent numerics
--
-- Integer and decimal values are stored in `value_scaled bigint` as
-- `value x 10^6` (12 integer digits, up to 6 fractional): an exact integer, not
-- a float and not a `numeric`. The application layer (domain/attribute-value.ts)
-- parses a strict digits-and-dot grammar and sends the scaled integer; Postgres
-- never parses a locale spelling.
--
-- Why `bigint` and not `numeric`: this table is under FORCE ROW LEVEL SECURITY,
-- and Postgres only pushes LEAKPROOF operators into an index condition (a
-- non-leakproof user qual must wait behind the policy qual). `numeric`'s
-- comparison operators are not leakproof (`pg_proc.proleakproof = f` for
-- numeric_ge/_le/_eq), `int8`'s are — measured with EXPLAIN on a seeded
-- dataset, see docs/adr/0027 and sql/963. With `numeric` a range filter could
-- never use a b-tree for the app role.
--
-- ## Tenant-safe references (composite FKs, not just application checks)
--
--   * (tenant_id, definition_id) -> definitions (tenant_id, id)
--   * (tenant_id, product_id)    -> products    (tenant_id, id)
--   * (variant_id, product_id)   -> variants    (id, product_id)
--
-- A value row therefore cannot name another tenant's definition or product,
-- and a variant value cannot name a variant of a DIFFERENT product, even if
-- application code regressed — RLS does not protect FK checks (they bypass
-- it), so the constraint itself must carry the tenant. The two unique indexes
-- the composite FKs need on the existing tables are added here; they add no
-- constraint a row could violate (`id` is already the primary key).
--
-- A variant's value row carries BOTH product_id and variant_id. That
-- denormalisation is what lets "products with attribute X = Y" be a single
-- indexed EXISTS on (definition_id, product_id) whether the value lives on the
-- product or on one of its variants.
--
-- ## Lifecycle
--
-- Definitions soft-delete (`deleted_at`, the purge engine's cursor), and so do
-- values: clearing one stamps `deleted_at`, the purge engine hard-deletes it
-- once it is older than the tenant's retention window, and it also cascades
-- away when its product, variant or (purged) definition goes. A soft-deleted
-- definition's values are simply never read (every read joins a LIVE
-- definition); its key is freed for reuse by the partial unique index. A
-- LIVE value is never a purge candidate (`deleted_at IS NULL`).

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_products_tenant_id_id_key
  ON awcms_commerce_products (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_product_variants_id_product_key
  ON awcms_commerce_product_variants (id, product_id);

CREATE TABLE IF NOT EXISTS awcms_commerce_attribute_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  key text NOT NULL,
  label text NOT NULL,
  labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  value_type text NOT NULL,
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  applies_to text NOT NULL DEFAULT 'product',
  is_searchable boolean NOT NULL DEFAULT false,
  is_filterable boolean NOT NULL DEFAULT false,
  visible_admin boolean NOT NULL DEFAULT true,
  visible_public boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_attribute_definitions_key_check
    CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT awcms_commerce_attribute_definitions_value_type_check
    CHECK (value_type IN ('text', 'integer', 'decimal', 'boolean', 'date', 'enum')),
  CONSTRAINT awcms_commerce_attribute_definitions_applies_to_check
    CHECK (applies_to IN ('product', 'variant', 'both')),
  CONSTRAINT awcms_commerce_attribute_definitions_labels_check
    CHECK (jsonb_typeof(labels) = 'object'),
  CONSTRAINT awcms_commerce_attribute_definitions_constraints_check
    CHECK (jsonb_typeof(constraints) = 'object'),
  CONSTRAINT awcms_commerce_attribute_definitions_searchable_check
    CHECK (NOT is_searchable OR value_type IN ('text', 'enum')),
  CONSTRAINT awcms_commerce_attribute_definitions_sort_order_check
    CHECK (sort_order BETWEEN 0 AND 10000)
);

-- A key is unique among LIVE definitions; deleting one frees the key.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_attribute_definitions_tenant_key_key
  ON awcms_commerce_attribute_definitions (tenant_id, key)
  WHERE deleted_at IS NULL;

-- The referenced side of the values table's composite FK.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_attribute_definitions_tenant_id_id_key
  ON awcms_commerce_attribute_definitions (tenant_id, id);

CREATE INDEX IF NOT EXISTS awcms_commerce_attribute_definitions_tenant_idx
  ON awcms_commerce_attribute_definitions (tenant_id);

-- The (tenant, cursor) composite the generic purge engine filters + orders by.
CREATE INDEX IF NOT EXISTS awcms_commerce_attribute_definitions_tenant_deleted_idx
  ON awcms_commerce_attribute_definitions (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_attribute_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_attribute_definitions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_attribute_definitions_tenant_isolation
  ON awcms_commerce_attribute_definitions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_product_attribute_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  definition_id uuid NOT NULL,
  product_id uuid NOT NULL,
  variant_id uuid,
  value_text text,
  value_scaled bigint,
  value_boolean boolean,
  value_date date,
  -- Deterministic normalised text (NFKC + lower) for text/enum values — what
  -- the searchable free-text match and the text `eq`/`contains` filters read.
  value_search text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Set when the operator CLEARS the value (soft delete): a live value has
  -- `deleted_at IS NULL`, so the purge engine, which only ever reaches rows
  -- whose cursor is past the retention window, can never reach one.
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_product_attribute_values_one_value_check
    CHECK (num_nonnulls(value_text, value_scaled, value_boolean, value_date) = 1),
  CONSTRAINT awcms_commerce_product_attribute_values_definition_fkey
    FOREIGN KEY (tenant_id, definition_id)
    REFERENCES awcms_commerce_attribute_definitions (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_product_attribute_values_product_fkey
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES awcms_commerce_products (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_product_attribute_values_variant_fkey
    FOREIGN KEY (variant_id, product_id)
    REFERENCES awcms_commerce_product_variants (id, product_id)
    ON DELETE CASCADE
);

-- One LIVE value per (entity, definition): one for the product itself, one per
-- variant. A cleared (soft-deleted) row is outside the index, so setting the
-- attribute again inserts a fresh live row beside it.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_product_attribute_values_product_key
  ON awcms_commerce_product_attribute_values (tenant_id, definition_id, product_id)
  WHERE variant_id IS NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_product_attribute_values_variant_key
  ON awcms_commerce_product_attribute_values (tenant_id, definition_id, variant_id)
  WHERE variant_id IS NOT NULL AND deleted_at IS NULL;

-- The (tenant, cursor) composite the generic purge engine filters + orders by.
CREATE INDEX IF NOT EXISTS awcms_commerce_product_attribute_values_tenant_deleted_idx
  ON awcms_commerce_product_attribute_values (tenant_id, deleted_at);

-- FK-column indexes (db:fk-index:check). The unique indexes above are partial;
-- these plain composites serve FK enforcement on parent delete/update and the
-- "all values of this product" read.
CREATE INDEX IF NOT EXISTS awcms_commerce_product_attribute_values_tenant_idx
  ON awcms_commerce_product_attribute_values (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_product_attribute_values_product_idx
  ON awcms_commerce_product_attribute_values (tenant_id, product_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_product_attribute_values_variant_idx
  ON awcms_commerce_product_attribute_values (variant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_product_attribute_values_definition_idx
  ON awcms_commerce_product_attribute_values (tenant_id, definition_id);

ALTER TABLE awcms_commerce_product_attribute_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_product_attribute_values FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_product_attribute_values_tenant_isolation
  ON awcms_commerce_product_attribute_values
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
