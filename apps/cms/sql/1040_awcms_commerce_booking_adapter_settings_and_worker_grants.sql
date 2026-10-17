-- Issue #378 (ADR-0045 G3) - the per-tenant setting that names the
-- service-account tenant user the adapter acts as, the retention-worker grants
-- for the adapter's tables, and one search_path pin owed by sql/1025.
--
-- ## The search_path pin on sql/1025's guard
--
-- Issue #379 (gateway deposit sessions) was written before the awcms#1046 gate
-- (`db:function-search-path:check`) arrived with the v10.8.0 subtree sync, so
-- its trigger function `awcms_commerce_payment_gateway_sessions_guard()` carries
-- no `SET search_path`. Like the sweep of sql/1032, the pin is added with
-- `ALTER FUNCTION ... SET` (the gate folds it in migration order) rather than by
-- editing an applied migration. Nothing in the body changes.
--
-- ## The service-account tenant user (G3)
--
-- The BookingPort REQUIRES `actorTenantUserId` on every write, for the stamps,
-- the audit row and the idempotency namespace (awcms ADR-0145), and says a
-- system job "must pass its own service-account tenant user, never an anonymous
-- placeholder". A guest checkout, a customer cancel and a domain-event consumer
-- have no staff user, so the tenant names one. It is a real COLUMN on the
-- one-row-per-tenant settings table (the `affiliate_commission_rate` precedent,
-- sql/921) with a composite tenant-safe FK, so the database refuses another
-- tenant's user. NULL means "not configured": the adapter refuses to link an
-- offering or hold a slot until it is set (the check is made in the application
-- when the `booking` feature is on - a module-settings PATCH has no per-module
-- validation hook, and `store-settings` is the commerce-owned write path).
--
-- ## Worker grants
--
-- `data-lifecycle:archive-purge` runs as `awcms_worker` and, for an
-- `executionMode: "generic"` descriptor, SELECTs candidates by
-- `(tenant_id, <cursor>)` and `hard_delete`s by `id`. The adapter's six tables
-- declare exactly that shape in `commerce/domain/booking-adapter-lifecycle.ts`,
-- so the grants must exist (`data-lifecycle:worker-grants:check`) - `sql/973`'s
-- reasoning. No UPDATE: the engine never rewrites these rows. `awcms_app` has no
-- DELETE on any of them (sql/1035-1038); the cursor of five of them is
-- `deleted_at`, which this module never sets, so only the refund decisions
-- (cursor `created_at`, ten-year ceiling) can ever be purged.

ALTER TABLE awcms_commerce_store_settings
  ADD COLUMN IF NOT EXISTS booking_service_tenant_user_id uuid;

ALTER TABLE awcms_commerce_store_settings
  ADD CONSTRAINT awcms_commerce_store_settings_booking_service_user_fk
    FOREIGN KEY (tenant_id, booking_service_tenant_user_id)
    REFERENCES awcms_tenant_users (tenant_id, id);

CREATE INDEX IF NOT EXISTS awcms_commerce_store_settings_booking_service_user_idx
  ON awcms_commerce_store_settings (tenant_id, booking_service_tenant_user_id)
  WHERE booking_service_tenant_user_id IS NOT NULL;

COMMENT ON COLUMN awcms_commerce_store_settings.booking_service_tenant_user_id IS
  'Issue #378 (ADR-0045 G3) - the service-account tenant user the booking adapter acts as for system, guest and consumer calls into the BookingPort. NULL = not configured.';

GRANT SELECT, DELETE ON awcms_commerce_booking_offering_links TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_booking_reservation_links TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_product_deposit_policies TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_cancellation_policies TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_cancellation_policy_windows TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_booking_refund_decisions TO awcms_worker;

ALTER FUNCTION awcms_commerce_payment_gateway_sessions_guard()
  SET search_path = pg_catalog, public, pg_temp;
