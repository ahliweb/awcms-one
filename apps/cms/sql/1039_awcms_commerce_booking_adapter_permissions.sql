-- Issue #378 (ADR-0045, access matrix docs/booking-commerce-access-matrix.md
-- section 3) - permission catalog seed for the booking-commerce adapter routes
-- this issue lands, mirroring `src/modules/commerce/domain/booking-adapter-permissions.ts`
-- exactly (see `sql/902`'s header for the reasoning this migration does not
-- repeat: global catalog, idempotent via `ON CONFLICT DO NOTHING`, existing
-- tenants do not retroactively gain these).
--
-- Only keys with an ENFORCING ROUTE are registered here (the "permission with no
-- enforcing code" defect class, `access:permissions:enforcement:check`); the
-- reservation-link, cancellation-policy, refund-decision and refund-override
-- keys arrive with the issues that land their routes.
--
--   * `commerce.booking_offering_links.{read,create,update}` - list and read the
--     offering-to-product links, link one offering to one service product, and
--     unlink (a status change; there is no `delete`).
--   * `commerce.booking_deposit_policies.{read,update}` - read a product's
--     deposit policy and write it (one key writes the product's single row;
--     removing the policy is `update` to full payment, there is no `delete`).
--
-- None is high-risk: reads and `create`/`update` are not (access matrix
-- section 2).
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'booking_offering_links', 'read', 'List and read the links between Booking offerings and service products (Issue #378)'),
  ('commerce', 'booking_offering_links', 'create', 'Link a Booking offering to a service product (Issue #378)'),
  ('commerce', 'booking_offering_links', 'update', 'Unlink a Booking offering from a service product (Issue #378)'),
  ('commerce', 'booking_deposit_policies', 'read', 'Read a product''s deposit policy (Issue #378)'),
  ('commerce', 'booking_deposit_policies', 'update', 'Set or remove a product''s deposit policy (Issue #378)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
