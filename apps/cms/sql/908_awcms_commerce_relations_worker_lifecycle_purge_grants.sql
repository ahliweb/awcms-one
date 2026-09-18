-- Same reasoning as `sql/903`'s header, extended to the two Issue #23 tables:
-- `commerce/module.ts`'s `dataLifecycle` descriptors for
-- `commerce.product_images`/`commerce.product_variants` declare
-- `cursorColumn: "deleted_at"` + `deletion.mode: "hard_delete"`
-- (`executionMode: "generic"`), so `data-lifecycle:archive-purge` needs
-- SELECT + DELETE on both as `awcms_worker` — never granted by default
-- (`sql/013`'s `ALTER DEFAULT PRIVILEGES` only ever covered `awcms_app`).
GRANT SELECT, DELETE ON awcms_commerce_product_images TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_product_variants TO awcms_worker;
