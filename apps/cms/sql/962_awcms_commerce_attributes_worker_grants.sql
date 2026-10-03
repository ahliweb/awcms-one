-- Issue #291 — the `dataLifecycle` descriptors of `commerce.attribute_definitions`
-- and `commerce.product_attribute_values` (`commerce/module.ts`) declare
-- `cursorColumn: "deleted_at"` + `deletion.mode: "hard_delete"`
-- (`executionMode: "generic"`), so `data-lifecycle:archive-purge` needs
-- SELECT + DELETE on both as `awcms_worker` — never granted by default
-- (`sql/013`'s `ALTER DEFAULT PRIVILEGES` only ever covered `awcms_app`).
-- Same shape as `sql/908`.
--
-- A LIVE definition/value has `deleted_at IS NULL`, so the purge predicate
-- (`deleted_at < $retention`) can never match one: only a soft-deleted
-- definition, or a value the operator cleared, ages out.
GRANT SELECT, DELETE ON awcms_commerce_attribute_definitions TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_product_attribute_values TO awcms_worker;
