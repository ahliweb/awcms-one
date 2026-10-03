-- Issue #291 — the three value indexes the attribute filters need, chosen from
-- MEASURED query plans (docs/adr/0027-catalog-custom-attributes-are-typed-and-
-- allowlisted.md, "Query plans"), not added by reflex.
--
-- ## Method
--
-- Seeded `awcms_commerce_products` / `..._attribute_values` with 3 tenants
-- (20k, 20k and 200k products; 5 attributes each: enum 8 values, decimal
-- 0..99.99, date over 3 years, boolean 50/50, text 200/2000 distinct) = 1.2M
-- value rows, ANALYZEd, and ran `EXPLAIN (ANALYZE, BUFFERS)` of the exact
-- statement `application/product-directory.ts` issues (the real
-- `attribute-filter-sql.ts` fragments), AS the `awcms_app` role under the real
-- RLS policy — not as a superuser, because RLS changes which plans are legal:
--
--   * Under FORCE RLS only LEAKPROOF operators may be pushed into an index
--     condition. `numeric`'s comparison operators are NOT leakproof
--     (`numeric_ge`/`_le`/`_eq`: proleakproof = f), so a b-tree on a `numeric`
--     column was never used for a range filter — the first reason numbers are
--     stored as a scaled `bigint` (`int8` operators are leakproof), see sql/960.
--   * `LIKE`/`ILIKE` are not leakproof either, so a pg_trgm GIN index on
--     `value_search` was NEVER chosen for `contains` or the free-text search,
--     even for a rare needle (`%rand 1777%`: 94 of 200k rows, still a bitmap
--     scan of the definition's btree range). It is therefore NOT created here —
--     it would cost every write and serve no read.
--
-- ## Results (execution time, ms; before = sql/960's indexes only)
--
--   filter                         20k products        200k products
--                                  before -> after     before -> after
--   decimal >= 99.5   (0.5% rows)    2.57 -> 0.42       32.7 -> 11.3
--   date    =         (0.1% rows)    2.40 -> 0.25       19.3 ->  2.1
--   text eq           (0.5%/0.05%)   3.47 -> 0.57       27.9 ->  1.2
--   decimal >= 90 / enum eq / date >= (10-12% of rows)  unchanged within
--   noise: the planner correctly keeps a hash semi-join + seq scan for
--   non-selective filters, so the index is neither used nor harmful there.
--   boolean eq (50% rows): unchanged and NOT indexed — a 2-value column has
--   no selectivity to exploit.
--   text `contains` (LIKE): ~6-10 ms at 20k, 60-95 ms at 200k products —
--   linear in the definition's rows with or without these indexes, because
--   LIKE is not leakproof; that cost is accepted and documented, not indexed.
--   free-text `q` over searchable attributes: ~25 ms at 20k, 170-220 ms at
--   200k products (the legacy name/sku-only `q` is already a seq scan there,
--   ~120 ms): the surcharge applies only to a tenant that marked an attribute
--   searchable.
--
-- ## Shape
--
-- Each index leads with (tenant_id, definition_id) — every filter binds both —
-- then the typed column, and is PARTIAL on that column being non-null so a
-- definition's rows live in exactly one index (a text attribute's rows are not
-- in the numeric index), and on the row being LIVE (`deleted_at IS NULL` — every
-- filter statement repeats that predicate so the planner may use the index; a
-- cleared value is in none of them). Enum values are matched on `value_search` (unique
-- case-insensitively per definition, domain/attribute-definition.ts), so ONE
-- btree serves both text and enum equality.

CREATE INDEX IF NOT EXISTS awcms_commerce_product_attribute_values_scaled_idx
  ON awcms_commerce_product_attribute_values (tenant_id, definition_id, value_scaled)
  WHERE value_scaled IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_product_attribute_values_date_idx
  ON awcms_commerce_product_attribute_values (tenant_id, definition_id, value_date)
  WHERE value_date IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_product_attribute_values_search_idx
  ON awcms_commerce_product_attribute_values (tenant_id, definition_id, value_search)
  WHERE value_search IS NOT NULL AND deleted_at IS NULL;
