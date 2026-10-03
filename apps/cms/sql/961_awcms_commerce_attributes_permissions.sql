-- Issue #291 — permission catalog seed for typed catalog attributes and the
-- catalog CSV import/export, mirroring `src/modules/commerce/module.ts`'s
-- `permissions` array exactly (see `sql/902`'s header for the global-catalog,
-- idempotent `ON CONFLICT DO NOTHING` reasoning this does not repeat).
--
--   commerce.attributes.read      list attribute definitions
--   commerce.attributes.manage    create/update/delete a definition (high-risk
--                                 action: it changes how every product's
--                                 attributes validate and what the public
--                                 catalog API may expose)
--   commerce.products.export      download the catalog CSV (high-risk: bulk
--                                 read of the whole catalog)
--   commerce.products.import      dry-run/apply a catalog CSV import
--                                 (high-risk: bulk write)
--
-- Reading/writing one product's attribute VALUES reuses
-- `commerce.products.read`/`.update`: values are part of editing a product,
-- the same "one verb per sub-resource" reasoning images/variants follow.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'attributes', 'read', 'List catalog attribute definitions (Issue #291)'),
  ('commerce', 'attributes', 'manage', 'Create, update and delete catalog attribute definitions (Issue #291)'),
  ('commerce', 'products', 'export', 'Export the product catalog as CSV (Issue #291)'),
  ('commerce', 'products', 'import', 'Dry-run and apply a product catalog CSV import (Issue #291)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
