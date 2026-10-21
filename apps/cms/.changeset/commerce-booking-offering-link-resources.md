---
"awcms": minor
---

feat(commerce): bind a booking offering link to its Booking resource(s) so the storefront shows each room type only under its own offering (Issue #437, ADR-0045)

New table `awcms_commerce_booking_offering_link_resources` (`sql/1050`; composite tenant FKs to the offering link and to `awcms_booking_resources`, FORCE RLS, no `UPDATE` or `DELETE` for `awcms_app`, worker `SELECT, DELETE`, a guard trigger with a pinned `search_path`). `POST /api/v1/commerce/booking/offering-links` accepts an optional `resourceIds` (at most ten; `404 RESOURCE_NOT_FOUND`, `409 RESOURCE_MODE_MISMATCH`, `409 RESOURCE_NOT_ACTIVE`) and the link body carries `resourceIds`. `GET commerce/storefront/booking/offerings` lists only a bound link's live resources, availability for another resource is the neutral `404`, and the hold on one is `404 RESOURCE_NOT_FOUND`. A link with no resource keeps the previous behaviour (every active resource of the matching booking mode), so existing tenants are unchanged.
