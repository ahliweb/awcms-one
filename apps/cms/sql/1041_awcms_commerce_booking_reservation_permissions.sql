-- Issue #380 (ADR-0045, access matrix docs/booking-commerce-access-matrix.md
-- section 3) - permission catalog seed for the hold-to-order routes this issue
-- lands, mirroring `src/modules/commerce/domain/booking-adapter-permissions.ts`
-- exactly (see `sql/902`'s header for the reasoning this migration does not
-- repeat: global catalog, idempotent via `ON CONFLICT DO NOTHING`, existing
-- tenants do not retroactively gain these).
--
-- Only keys with an ENFORCING ROUTE are registered here
-- (`access:permissions:enforcement:check`); `update` and `cancel` of the
-- reservation links, the cancellation-policy keys, the refund-decision keys and
-- the refund-override key arrive with the issues that land their routes.
--
--   * `commerce.booking_reservation_links.create` - hold a slot or stay for a
--     guest and create the order from it (`POST /booking/reservations`, the
--     staff variant of the storefront call).
--   * `commerce.booking_reservation_links.read` - read a reservation's link,
--     order code and derived settlement (`GET /booking/reservations/{id}`) and
--     the paid-without-confirm / confirmed-without-deposit reconciliation
--     (`GET /booking/reconciliation`, threat control C-09).
--
-- Neither is high-risk: reads and `create` are not (access matrix section 2).
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'booking_reservation_links', 'read', 'Read a booking reservation''s link, order and settlement, and the booking reconciliation (Issue #380)'),
  ('commerce', 'booking_reservation_links', 'create', 'Hold a Booking slot or stay and create the commerce order from it (Issue #380)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
