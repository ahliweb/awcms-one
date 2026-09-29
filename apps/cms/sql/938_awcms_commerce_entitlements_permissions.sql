-- Issue #267 (IRMbyDUS entitlement module) — permission catalog seed for
-- the `entitlements` activity code, mirroring
-- `src/modules/commerce/module.ts`'s `permissions` array exactly (see
-- `sql/902`'s header for the full reasoning this migration does not
-- repeat: global catalog, idempotent via `ON CONFLICT DO NOTHING`,
-- existing tenants do not retroactively gain these).
--
-- Only `read`/`update` — no `create`: an entitlement is granted only as a
-- side effect of an order reaching `paid` (the
-- `commerce.order_paid_entitlement_grantor` domain-event consumer), never
-- through a direct admin route, same "no permission with nothing to
-- enforce it" reasoning `COMMERCE_ORDER_PERMISSIONS`/
-- `COMMERCE_AFFILIATE_PERMISSIONS` already state (`commerce-permissions.ts`).
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'entitlements', 'read', 'List/look up commerce entitlement records (Issue #267, IRMbyDUS)'),
  ('commerce', 'entitlements', 'update', 'Revoke a commerce entitlement — the only admin mutation this module has; grants happen only via the order-paid consumer (Issue #267)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
