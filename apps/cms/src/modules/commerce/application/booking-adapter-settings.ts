/**
 * The booking adapter's one per-tenant setting: the SERVICE-ACCOUNT tenant user
 * it acts as (Issue #378, ADR-0045 G3).
 *
 * `BookingPort` requires `actorTenantUserId` on every write - for the stamps,
 * the audit row and the idempotency namespace (awcms ADR-0145) - and says a
 * system job "must pass its own service-account tenant user, never an anonymous
 * placeholder". A guest checkout, a customer cancel and a domain-event consumer
 * have no staff user, so the tenant names one here. It lives in a real column of
 * the one-row-per-tenant settings table (`sql/1040`, the
 * `affiliate_commission_rate` precedent) behind a composite tenant-safe FK; it
 * is written through `PUT /api/v1/commerce/store-settings` and checked when the
 * `booking` feature is used (a module-settings PATCH has no per-module
 * validation hook).
 *
 * A caller that needs the actor uses {@link fetchBookingServiceActor}: it
 * answers `null` when the setting is unset OR the user is no longer active, and
 * the caller refuses with `409 BOOKING_SERVICE_ACTOR_NOT_CONFIGURED`. The audit
 * entries of such a call carry `actor_kind = 'system'` and `initiated_by`, never
 * the service account posing as a person.
 */

import { DEFAULT_CHECK_IN_REQUIRES_SETTLEMENT } from "../domain/booking-pos";

/** The configured service-account tenant user, or `null` when unset or inactive. */
export async function fetchBookingServiceActor(
  tx: Bun.SQL,
  tenantId: string
): Promise<string | null> {
  const rows = (await tx`
    SELECT s.booking_service_tenant_user_id AS id
    FROM awcms_commerce_store_settings s
    JOIN awcms_tenant_users u
      ON u.tenant_id = s.tenant_id AND u.id = s.booking_service_tenant_user_id
    WHERE s.tenant_id = ${tenantId}
      AND s.deleted_at IS NULL
      AND u.status = 'active'
  `) as { id: string }[];
  return rows[0]?.id ?? null;
}

/** The raw stored value (even for an inactive user), for the settings screen and API. */
export async function fetchBookingServiceTenantUserId(
  tx: Bun.SQL,
  tenantId: string
): Promise<string | null> {
  const rows = (await tx`
    SELECT booking_service_tenant_user_id AS id
    FROM awcms_commerce_store_settings
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
  `) as { id: string | null }[];
  return rows[0]?.id ?? null;
}

/** Whether `tenantUserId` is an ACTIVE tenant user of this tenant (an unknown, foreign or inactive id are indistinguishable). */
export async function isActiveTenantUser(
  tx: Bun.SQL,
  tenantId: string,
  tenantUserId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT 1 AS ok
    FROM awcms_tenant_users
    WHERE tenant_id = ${tenantId} AND id = ${tenantUserId} AND status = 'active'
  `) as unknown[];
  return rows.length > 0;
}

/**
 * Writes (or clears, with `null`) the service-account tenant user. Called AFTER
 * `saveStoreSettings` in the same request, so the singleton row it updates
 * exists. The caller has already checked {@link isActiveTenantUser}.
 */
export async function saveBookingServiceTenantUserId(
  tx: Bun.SQL,
  tenantId: string,
  tenantUserId: string | null
): Promise<void> {
  await tx`
    UPDATE awcms_commerce_store_settings
    SET booking_service_tenant_user_id = ${tenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId}
  `;
}

/**
 * Whether a guest may NOT be checked in at the till while a balance is owed
 * (Issue #383, ADR-0045 D19). A real column of the one-row-per-tenant settings
 * table (`sql/1046`, default TRUE). A tenant with no live row - never saved, or
 * reset and not yet purged - reads the default, so the answer fails closed.
 */
export async function fetchCheckInRequiresSettlement(
  tx: Bun.SQL,
  tenantId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT checkin_requires_settlement AS value
    FROM awcms_commerce_store_settings
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
  `) as { value: boolean }[];
  return rows[0]?.value ?? DEFAULT_CHECK_IN_REQUIRES_SETTLEMENT;
}

/** Writes the policy. Called AFTER `saveStoreSettings` in the same request, so the singleton row exists. */
export async function saveCheckInRequiresSettlement(
  tx: Bun.SQL,
  tenantId: string,
  requiresSettlement: boolean
): Promise<void> {
  await tx`
    UPDATE awcms_commerce_store_settings
    SET checkin_requires_settlement = ${requiresSettlement}, updated_at = now()
    WHERE tenant_id = ${tenantId}
  `;
}
