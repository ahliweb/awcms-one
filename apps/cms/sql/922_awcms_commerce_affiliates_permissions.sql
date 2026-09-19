-- Issue #92 — permission catalog seed for the `affiliates`/
-- `affiliate_commissions` activity codes, mirroring
-- `src/modules/commerce/module.ts`'s `permissions` array exactly (see
-- `sql/902`'s header for the full reasoning this migration does not repeat:
-- global catalog, idempotent via `ON CONFLICT DO NOTHING`, existing tenants
-- do not retroactively gain these).
--
-- `read`/`update` only for both — no `create`/`delete` action, deliberately:
-- an affiliate row is created only through the shopper's own bearer-secured
-- `POST .../account/affiliate` enrolment, and a commission row is created
-- only as a side effect of an order reaching `completed`
-- (`application/order-directory.ts`'s `transitionOrderStatus`). Seeding a
-- `create`/`delete` permission with nothing to enforce it is exactly the
-- defect class `media-library/domain/media-permissions.ts`'s header warns
-- against (the since-revoked `attach`/`detach` keys) — see
-- `commerce-permissions.ts`'s own header for the identical reasoning already
-- applied to `orders`/`customers`.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'affiliates', 'read', 'Read affiliate records and their stats'),
  ('commerce', 'affiliates', 'update', 'Edit an affiliate''s status (active/suspended) or commission rate'),
  ('commerce', 'affiliate_commissions', 'read', 'Read affiliate commission records'),
  ('commerce', 'affiliate_commissions', 'update', 'Moderate a commission (approve/pay/void)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
