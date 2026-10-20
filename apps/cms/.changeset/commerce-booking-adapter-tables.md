---
"awcms": minor
---

feat(commerce): booking-commerce adapter tables, offering links, deposit policy and the service-account setting (Issue #378, ADR-0045)

New tables `awcms_commerce_booking_offering_links`, `awcms_commerce_booking_reservation_links`, `awcms_commerce_product_deposit_policies`, `awcms_commerce_cancellation_policies`, `awcms_commerce_cancellation_policy_windows` and `awcms_commerce_booking_refund_decisions` (`sql/1035`-`1038`; FORCE RLS, composite tenant FKs including to Booking's `awcms_booking_service_offerings` and `awcms_booking_reservations`, frozen-column triggers with a pinned `search_path`, no `DELETE` for `awcms_app`); `sql/1039` seeds five permission keys; `sql/1040` adds `awcms_commerce_store_settings.booking_service_tenant_user_id`, the retention-worker grants and a `search_path` pin on `sql/1025`'s guard. The customer of a reservation is derived through the linked order and stored on no adapter table.

New endpoints (all behind the `booking` feature flag, default OFF → `409 FEATURE_DISABLED`): `GET`/`POST /api/v1/commerce/booking/offering-links`, `GET`/`PATCH .../{id}`, `GET`/`PUT /api/v1/commerce/products/{id}/deposit-policy`. `PUT /api/v1/commerce/store-settings` carries `bookingServiceTenantUserId`. `allow_dp` follows the deposit policy while `booking` is on (`409 ALLOW_DP_MANAGED_BY_POLICY`). Descriptors in `domain/booking-adapter-lifecycle.ts`; `module.ts` spreads four part files (`booking-adapter-permissions`, `-lifecycle`, `-navigation`, `-consumers`) that later adapter issues extend. No screen, no domain event, no consumer yet.
