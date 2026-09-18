-- Same reasoning as `sql/903`'s and `sql/908`'s headers, extended to the six
-- Issue #26 marketing tables: `commerce/module.ts`'s `dataLifecycle`
-- descriptors for `commerce.flash_sales`, `commerce.flash_sale_products`,
-- `commerce.vouchers`, `commerce.sliders`, `commerce.testimonials` and
-- `commerce.popups` declare `cursorColumn: "deleted_at"` +
-- `deletion.mode: "hard_delete"` (`executionMode: "generic"`), so
-- `data-lifecycle:archive-purge` needs SELECT + DELETE on each as
-- `awcms_worker` — never granted by default (`sql/013`'s `ALTER DEFAULT
-- PRIVILEGES` only ever covered `awcms_app`), and caught by
-- `data-lifecycle:worker-grants:check` the moment a descriptor claims a
-- retention the worker role cannot enforce.
--
-- `awcms_commerce_store_settings` is here too, on the strength of its
-- `deleted_at` ("reset to defaults", `sql/910`'s header): a live settings
-- row is `deleted_at IS NULL` and unreachable by the engine's predicate; only
-- a row an owner reset and then left reset for the retention window is ever
-- selected.
GRANT SELECT, DELETE ON awcms_commerce_flash_sales TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_flash_sale_products TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_vouchers TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_sliders TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_testimonials TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_popups TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_store_settings TO awcms_worker;
