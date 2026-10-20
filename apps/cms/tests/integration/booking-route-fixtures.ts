/**
 * Shared helpers for the booking adapter's ROUTE integration suites that follow
 * issue #381 (the reschedule and no-show routes of issue #382). World 2 of
 * `harness.ts`: handlers use `getDatabaseClient()` and the public tenant is the
 * one `PUBLIC_DEFAULT_TENANT_ID` names. Copied from the #381 cancellation routes
 * suite (which keeps its own copies) so each suite stays standalone; not a test
 * file (no `.test.ts` suffix).
 */
import { expect } from "bun:test";

import {
  createCookieJar,
  getHandlerAdminSql,
  integrationEnabled,
  invoke
} from "./harness";
import { hashSessionToken } from "../../src/lib/auth/session-token";
import { getDatabaseClient } from "../../src/lib/database/client";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import { POST as createLink } from "../../src/pages/api/v1/commerce/booking/offering-links/index";
import { POST as staffCreate } from "../../src/pages/api/v1/commerce/booking/reservations/index";
import { POST as createPolicy } from "../../src/pages/api/v1/commerce/booking/cancellation-policies/index";
import { POST as approvePolicy } from "../../src/pages/api/v1/commerce/booking/cancellation-policies/[id]/approve";
import { POST as retirePolicy } from "../../src/pages/api/v1/commerce/booking/cancellation-policies/[id]/retire";
import { POST as recordPayment } from "../../src/pages/api/v1/commerce/orders/[id]/payments/index";
import { PUT as putStoreSettings } from "../../src/pages/api/v1/commerce/store-settings/index";

export { integrationEnabled };

export const OWNER_PASSWORD = "integration-test-owner-password";
export const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000aa";
export const GUEST_PHONE = "081311112222";

export type Principal = {
  tenantId: string;
  token: string;
  tenantUserId: string;
};
export type Envelope<T = unknown> = {
  success: boolean;
  data: T;
  error?: { code: string; message?: string; details?: unknown };
};

export async function bootstrapOwner(): Promise<Principal> {
  const loginIdentifier = "owner@example.com";
  const setup = await invoke<{ data: { tenantId: string } }>(setupInitialize, {
    method: "POST",
    path: "/api/v1/setup/initialize",
    headers: { "content-type": "application/json" },
    body: {
      tenantName: "Acme",
      tenantCode: "acme",
      officeCode: "hq",
      officeName: "HQ",
      ownerLoginIdentifier: loginIdentifier,
      ownerPassword: OWNER_PASSWORD,
      ownerDisplayName: "Owner"
    }
  });
  expect(setup.status).toBe(200);
  const tenantId = setup.body.data.tenantId;
  const login = await invoke<{ data: { token: string } }>(authLogin, {
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      "content-type": "application/json",
      "x-awcms-tenant-id": tenantId
    },
    body: { loginIdentifier, password: OWNER_PASSWORD },
    cookies: createCookieJar()
  });
  expect(login.status).toBe(200);
  const rows = (await getHandlerAdminSql()`
    SELECT tu.id FROM awcms_tenant_users tu
    JOIN awcms_identities i ON i.id = tu.identity_id
    WHERE tu.tenant_id = ${tenantId} AND i.login_identifier = ${loginIdentifier}
  `) as { id: string }[];
  return { tenantId, token: login.body.data.token, tenantUserId: rows[0]!.id };
}

export async function seedPrincipal(
  tenantId: string,
  label: string,
  perms: string[]
): Promise<Principal> {
  const admin = getHandlerAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', ${`Profile ${label}`})
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`${label}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  const tenantUser = (await admin`
    INSERT INTO awcms_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identity[0]!.id})
    RETURNING id
  `) as { id: string }[];
  const role = (await admin`
    INSERT INTO awcms_roles (tenant_id, role_code, role_name)
    VALUES (${tenantId}, ${label}, ${label})
    RETURNING id
  `) as { id: string }[];
  for (const key of perms) {
    const [moduleKey, activityCode, action] = key.split(".");
    const permission = (await admin`
      SELECT id FROM awcms_permissions
      WHERE module_key = ${moduleKey!} AND activity_code = ${activityCode!} AND action = ${action!}
    `) as { id: string }[];
    if (!permission[0]) throw new Error(`permission ${key} is not seeded`);
    await admin`
      INSERT INTO awcms_role_permissions (tenant_id, role_id, permission_id)
      VALUES (${tenantId}, ${role[0]!.id}, ${permission[0].id})
    `;
  }
  await admin`
    INSERT INTO awcms_access_policies (tenant_id, tenant_user_id, role_id, scope_type, scope_id)
    VALUES (${tenantId}, ${tenantUser[0]!.id}, ${role[0]!.id}, 'tenant', ${tenantId})
  `;
  const token = `it-token-${label}-${Date.now()}`;
  await admin`
    INSERT INTO awcms_sessions (tenant_id, identity_id, token_hash, expires_at)
    VALUES (${tenantId}, ${identity[0]!.id}, ${hashSessionToken(token)}, ${new Date(Date.now() + 3_600_000)})
  `;
  return { tenantId, token, tenantUserId: tenantUser[0]!.id };
}

/** Raises a principal's session to aal2 with a step-up `ageMs` old (the platform TTL is 300 s by default). */
export async function stepUp(who: Principal, ageMs = 0): Promise<void> {
  await getHandlerAdminSql()`
    UPDATE awcms_sessions
    SET assurance_level = 'aal2',
        stepped_up_at = ${new Date(Date.now() - ageMs)},
        last_authenticated_at = ${new Date(Date.now() - ageMs)}
    WHERE token_hash = ${hashSessionToken(who.token)}
  `;
}

export function headers(who: Principal, extra: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "x-awcms-tenant-id": who.tenantId,
    authorization: `Bearer ${who.token}`,
    ...extra
  };
}

export function setBookingFeature(who: Principal, booking: boolean) {
  return invoke<Envelope>(patchModuleSettings, {
    method: "PATCH",
    path: "/api/v1/tenant/modules/commerce/settings",
    headers: headers(who),
    params: { moduleKey: "commerce" },
    body: {
      features: {
        pos: true,
        inbox: true,
        campaigns: true,
        gateway: true,
        courier: true,
        register: false,
        documents: false,
        booking
      }
    }
  });
}

export const putSettings = (who: Principal, extra: Record<string, unknown>) =>
  invoke<Envelope>(putStoreSettings, {
    method: "PUT",
    path: "/api/v1/commerce/store-settings",
    headers: headers(who),
    body: {
      storeName: "Villa",
      shipping: { selfPickup: true },
      payment: { manualQris: { active: true, mediaObjectId: null } },
      ...extra
    }
  });

export type Fixture = {
  productId: string;
  offeringId: string;
  resourceId: string;
};
let fixtureSeq = 0;

export async function seedFixture(owner: Principal): Promise<Fixture> {
  fixtureSeq += 1;
  const code = `x${fixtureSeq}`;
  const admin = getHandlerAdminSql();
  const product = (await admin`
    INSERT INTO awcms_commerce_products
      (tenant_id, type, sku, name, slug, price, stock, status)
    VALUES (${owner.tenantId}, 'service', ${`SKU-${code}`}, ${`Kamar ${code}`}, ${`kamar-${code}`}, '500000.00', 0, 'active')
    RETURNING id
  `) as { id: string }[];
  const resource = (await admin`
    INSERT INTO awcms_booking_resources
      (tenant_id, code, name, kind, capacity, timezone, booking_mode,
       stay_check_in_time, stay_check_out_time)
    VALUES (${owner.tenantId}, ${code}, ${`Room ${code}`}, 'room', 6,
            'Asia/Pontianak', 'stay', '14:00'::time, '12:00'::time)
    RETURNING id
  `) as { id: string }[];
  for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
    await admin`
      INSERT INTO awcms_booking_resource_units (tenant_id, resource_id, ordinal)
      VALUES (${owner.tenantId}, ${resource[0]!.id}, ${ordinal})
    `;
  }
  const offering = (await admin`
    INSERT INTO awcms_booking_service_offerings
      (tenant_id, code, name, granularity, min_nights, max_nights, max_party, confirmation_mode)
    VALUES (${owner.tenantId}, ${`night-${code}`}, 'Night', 'stay', 1, 30, 4, 'hold_then_confirm')
    RETURNING id
  `) as { id: string }[];
  const linked = await invoke<Envelope>(createLink, {
    method: "POST",
    path: "/api/v1/commerce/booking/offering-links",
    headers: headers(owner, { "idempotency-key": `link-${code}` }),
    body: {
      offeringId: offering[0]!.id,
      productId: product[0]!.id,
      quantityBasis: "nights"
    }
  });
  expect(linked.status).toBe(201);
  return {
    productId: product[0]!.id,
    offeringId: offering[0]!.id,
    resourceId: resource[0]!.id
  };
}

export const day = (offset: number): string =>
  new Date(Date.now() + (60 + offset) * 86_400_000).toISOString().slice(0, 10);

export function body(fx: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    offeringId: fx.offeringId,
    resourceId: fx.resourceId,
    stay: { checkInDate: day(1), checkOutDate: day(3) },
    partySize: 2,
    guest: { name: "Budi", phone: GUEST_PHONE },
    payment: { method: "manual_qris" },
    ...overrides
  };
}

let keySeq = 0;
export const nextKey = () => `bk381-${Date.now()}-${(keySeq += 1)}`;

export type Created = {
  orderId: string;
  orderCode: string;
  reservation: { id: string; status: string };
};

/** Delivers the tenant's pending domain events through the real consumer registry (the payment confirms the reservation here). */
export async function dispatchEvents(tenantId: string): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await dispatchDomainEventsForTenant(getDatabaseClient(), tenantId, {
      limit: 200
    });
  }
}

/** A booking made by the owner, paid (1,000,000.00 by default) and confirmed by the real consumer. */
export async function paidBooking(
  owner: Principal,
  fx: Fixture,
  amount = "1000000.00",
  overrides: Record<string, unknown> = {}
): Promise<Created> {
  const made = await invoke<Envelope<Created>>(staffCreate, {
    method: "POST",
    path: "/api/v1/commerce/booking/reservations",
    headers: headers(owner, { "idempotency-key": nextKey() }),
    body: body(fx, overrides)
  });
  expect(made.status).toBe(201);
  if (Number(amount) > 0) {
    const paid = await invoke<Envelope>(recordPayment, {
      method: "POST",
      path: `/api/v1/commerce/orders/${made.body.data.orderId}/payments`,
      headers: headers(owner, { "idempotency-key": nextKey() }),
      params: { id: made.body.data.orderId },
      body: { tenderType: "manual_qris", amount }
    });
    expect(paid.status).toBe(201);
    await dispatchEvents(owner.tenantId);
  }
  return made.body.data;
}

export const policyPost = (
  who: Principal,
  payload: unknown,
  key: string | null = nextKey()
) =>
  invoke<Envelope<Record<string, any>>>(createPolicy, {
    method: "POST",
    path: "/api/v1/commerce/booking/cancellation-policies",
    headers: headers(who, key === null ? {} : { "idempotency-key": key }),
    body: payload
  });

export const policyAction = (
  who: Principal,
  action: "approve" | "retire",
  id: string,
  key: string | null = nextKey()
) =>
  invoke<Envelope<Record<string, any>>>(
    action === "approve" ? approvePolicy : retirePolicy,
    {
      method: "POST",
      path: `/api/v1/commerce/booking/cancellation-policies/${id}/${action}`,
      headers: headers(who, key === null ? {} : { "idempotency-key": key }),
      params: { id }
    }
  );

export const STANDARD = [
  { minHoursBeforeStart: 168, refundablePercent: "100" },
  { minHoursBeforeStart: 48, refundablePercent: "50" }
];

/** An active policy (the owner authors and approves with a fresh step-up). */
export async function activePolicy(
  owner: Principal,
  productId: string | null,
  windows = STANDARD
): Promise<string> {
  await stepUp(owner);
  const draft = await policyPost(owner, { productId, windows });
  expect(draft.status).toBe(201);
  const approved = await policyAction(owner, "approve", draft.body.data.id);
  expect(approved.status).toBe(200);
  return draft.body.data.id;
}

export async function readyOwner(): Promise<{ owner: Principal; fx: Fixture }> {
  const owner = await bootstrapOwner();
  expect((await setBookingFeature(owner, true)).status).toBe(200);
  expect(
    (
      await putSettings(owner, {
        bookingServiceTenantUserId: owner.tenantUserId
      })
    ).status
  ).toBe(200);
  process.env.PUBLIC_DEFAULT_TENANT_ID = owner.tenantId;
  return { owner, fx: await seedFixture(owner) };
}

/**
 * Edits Booking's reservation row the way no application path can (its update
 * guard refuses a column outside a transition's allowed set): the guard is
 * switched off for the one statement, as the table's owner, and switched back on.
 * `setClause` is test-authored SQL, never input.
 */
export async function tamperReservation(
  reservationId: string,
  setClause: string
): Promise<void> {
  const admin = getHandlerAdminSql();
  await admin.unsafe(
    "ALTER TABLE awcms_booking_reservations DISABLE TRIGGER awcms_booking_reservations_update_guard"
  );
  try {
    await admin.unsafe(
      `UPDATE awcms_booking_reservations SET ${setClause} WHERE id = '${reservationId}'`
    );
  } finally {
    await admin.unsafe(
      "ALTER TABLE awcms_booking_reservations ENABLE TRIGGER awcms_booking_reservations_update_guard"
    );
  }
}

/** Moves a reservation's arrival into the past so a no-show is allowed (Booking refuses to hold one there). */
export function arrivedHoursAgo(
  reservationId: string,
  hoursAgo: number
): Promise<void> {
  const hours = Math.trunc(hoursAgo);
  return tamperReservation(
    reservationId,
    `starts_at = now() - make_interval(hours => ${hours}),
     ends_at = now() - make_interval(hours => ${hours}) + interval '2 days'`
  );
}
