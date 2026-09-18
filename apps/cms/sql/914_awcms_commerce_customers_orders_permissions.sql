-- Issue #29 — permission catalog seed for the `orders`/`customers`/`reviews`
-- activity codes, mirroring `src/modules/commerce/module.ts`'s `permissions`
-- array exactly (see `sql/902`'s header for the full reasoning this
-- migration does not repeat: global catalog, idempotent via `ON CONFLICT DO
-- NOTHING`, existing tenants do not retroactively gain these).
--
-- `orders`/`customers` get only `read`/`update` — no `create`/`delete`
-- action, deliberately: an order/customer is created only through the
-- anonymous storefront path (which checks no permission at all — see
-- `commerce-permissions.ts`'s header), and this increment ships no admin
-- route that creates one directly or hard-deletes one. Seeding a
-- `create`/`delete` permission with nothing to enforce it is exactly the
-- defect class `media-library/domain/media-permissions.ts`'s header warns
-- against (the since-revoked `attach`/`detach` keys).
--
-- `reviews` gets `read`/`update`/`delete` — a review is likewise created
-- anonymously, but an admin DOES get a real soft-delete route
-- (`DELETE /api/v1/commerce/reviews/{id}`) in this increment. No `restore`
-- action for any of the three: reviews are moderated, not restored, and
-- orders/customers are never soft-deleted in the traditional sense (see
-- `sql/913`'s header).
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'orders', 'read', 'Read order records, including payment confirmations and the status timeline'),
  ('commerce', 'orders', 'update', 'Update an order''s status (including an admin-initiated cancel), review a payment confirmation (accept/reject)'),
  ('commerce', 'customers', 'read', 'Read customer records and their saved addresses'),
  ('commerce', 'customers', 'update', 'Update a customer''s level/status'),
  ('commerce', 'reviews', 'read', 'Read review records, published and pending'),
  ('commerce', 'reviews', 'update', 'Moderate a review (publish/reject)'),
  ('commerce', 'reviews', 'delete', 'Soft-delete a review record')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
