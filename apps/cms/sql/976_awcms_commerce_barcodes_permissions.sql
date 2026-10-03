-- Issue #292 (ADR-0032) - permission catalog seed for barcode lookup, label
-- printing and barcode assignment, mirroring `src/modules/commerce/module.ts`'s
-- `permissions` array exactly (see `sql/902`'s header for the reasoning this
-- migration does not repeat: global catalog, idempotent via `ON CONFLICT DO
-- NOTHING`, existing tenants do not retroactively gain these).
--
-- Resource-split on purpose, and NOT a widening of `commerce.pos.create` or
-- `commerce.products.update`: ringing up a sale must not let a cashier relabel
-- the catalogue, and editing a product's name must not let anyone re-point a
-- code that is physically stuck to stock.
--   * `commerce.barcodes.read`   - resolve a scanned code, browse the barcode
--     catalogue, render a label sheet.
--   * `commerce.barcodes.update` - assign, change or clear a product's or
--     variant's barcode.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'barcodes', 'read', 'Resolve a scanned barcode, browse the barcode catalogue and print label sheets (Issue #292)'),
  ('commerce', 'barcodes', 'update', 'Assign, change or clear the barcode of a product or variant (Issue #292)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
