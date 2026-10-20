/**
 * The hold-to-order, reservation-read and reconciliation routes through the
 * REAL route handlers (Issue #380, ADR-0045; access matrix section 9 evidence
 * for `commerce.booking_reservation_links.{create,read}`). World 2 of
 * `harness.ts`: handlers use `getDatabaseClient()` and the public tenant is the
 * one `PUBLIC_DEFAULT_TENANT_ID` names. The domain behaviour (race table,
 * consumers, deposit maths) is proved at the application layer in
 * `commerce-booking-hold-to-order.integration.test.ts`; this file proves what
 * only the wiring can:
 *
 *   - every route is `409 FEATURE_DISABLED` (staff) or the neutral `404`
 *     (storefront) until the tenant opts in;
 *   - create and read are separate powers (403, nothing written);
 *   - the staff create needs `Idempotency-Key` and a guest, refuses a body
 *     that names a price/amount/customer (400), is `201` then `200 replayed`,
 *     and the same key with another body is `409 IDEMPOTENCY_CONFLICT`;
 *   - the storefront create works anonymously (guest) and with a bearer, a dead
 *     bearer is `401`, and an order is the signed-in account's own;
 *   - the storefront read is identified by the order's phone or a live bearer:
 *     another customer's bearer, a wrong phone and an unknown code are ONE 404,
 *     the owner's view has settlement and no staff attention field;
 *   - the staff read has the attention fields; an unknown id is 404;
 *   - the reconciliation route answers an empty report on a clean tenant.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  createCookieJar,
  ensureHandlerDatabaseReady,
  getHandlerAdminSql,
  integrationEnabled,
  invoke,
  resetHandlerDatabase,
  teardownHandlerDatabase
} from "./harness";
import { hashSessionToken } from "../../src/lib/auth/session-token";
import { resetRateLimitForTests } from "../../src/lib/security/rate-limit";
import {
  generateCustomerSessionToken,
  hashCustomerSessionToken
} from "../../src/modules/commerce/domain/customer-session-token";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import { POST as createLink } from "../../src/pages/api/v1/commerce/booking/offering-links/index";
import { POST as staffCreate } from "../../src/pages/api/v1/commerce/booking/reservations/index";
import { GET as staffGet } from "../../src/pages/api/v1/commerce/booking/reservations/[id]";
import { GET as reconciliation } from "../../src/pages/api/v1/commerce/booking/reconciliation";
import {
  POST as storefrontCreate,
  OPTIONS as storefrontCreatePreflight
} from "../../src/pages/api/v1/commerce/storefront/booking/reservations/index";
import { GET as storefrontGet } from "../../src/pages/api/v1/commerce/storefront/booking/reservations/[orderCode]";
import { PUT as putStoreSettings } from "../../src/pages/api/v1/commerce/store-settings/index";

const OWNER_PASSWORD = "integration-test-owner-password";
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000aa";

type Principal = { tenantId: string; token: string; tenantUserId: string };
type Envelope<T = unknown> = {
  success: boolean;
  data: T;
  error?: { code: string; message?: string; details?: unknown };
};

async function bootstrapOwner(): Promise<Principal> {
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

async function seedPrincipal(
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

function headers(who: Principal, extra: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "x-awcms-tenant-id": who.tenantId,
    authorization: `Bearer ${who.token}`,
    ...extra
  };
}

function setBookingFeature(who: Principal, booking: boolean) {
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

const putSettings = (who: Principal, extra: Record<string, unknown>) =>
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

type Fixture = { productId: string; offeringId: string; resourceId: string };
let fixtureSeq = 0;

async function seedFixture(owner: Principal): Promise<Fixture> {
  fixtureSeq += 1;
  const code = `r${fixtureSeq}`;
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
    VALUES (${owner.tenantId}, ${code}, ${`Room ${code}`}, 'room', 3,
            'Asia/Pontianak', 'stay', '14:00'::time, '12:00'::time)
    RETURNING id
  `) as { id: string }[];
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
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

const day = (offset: number): string =>
  new Date(Date.now() + (60 + offset) * 86_400_000).toISOString().slice(0, 10);

function body(fx: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    offeringId: fx.offeringId,
    resourceId: fx.resourceId,
    stay: { checkInDate: day(1), checkOutDate: day(3) },
    partySize: 2,
    guest: { name: "Budi", phone: "081311112222" },
    payment: { method: "manual_qris" },
    ...overrides
  };
}

let keySeq = 0;
const nextKey = () => `bk380-${Date.now()}-${(keySeq += 1)}`;

type Created = {
  replayed: boolean;
  orderId: string;
  orderCode: string;
  reservation: { id: string; status: string; holdExpiresAt: string | null };
  settlement: { total: string; balanceDue?: string };
};

const staffPost = (
  who: Principal,
  payload: unknown,
  key: string | null = nextKey()
) =>
  invoke<Envelope<Created>>(staffCreate, {
    method: "POST",
    path: "/api/v1/commerce/booking/reservations",
    headers: headers(who, key === null ? {} : { "idempotency-key": key }),
    body: payload
  });

const storefrontPost = (
  payload: unknown,
  extra: Record<string, string> = {},
  key: string | null = nextKey()
) =>
  invoke<Envelope<Created>>(storefrontCreate, {
    method: "POST",
    path: "/api/v1/commerce/storefront/booking/reservations",
    headers: {
      "content-type": "application/json",
      ...(key === null ? {} : { "idempotency-key": key }),
      ...extra
    },
    body: payload
  });

const storefrontRead = (
  orderCode: string,
  query = "",
  extra: Record<string, string> = {}
) =>
  invoke<Envelope<Record<string, unknown>>>(storefrontGet, {
    path: `/api/v1/commerce/storefront/booking/reservations/${orderCode}${query}`,
    headers: extra,
    params: { orderCode }
  });

async function bearerFor(
  tenantId: string,
  customerId: string
): Promise<string> {
  const admin = getHandlerAdminSql();
  const account = (await admin`
    INSERT INTO awcms_commerce_customer_accounts
      (tenant_id, customer_id, email_normalized, history_from)
    VALUES (${tenantId}, ${customerId}, ${`${customerId}@example.com`}, now())
    RETURNING id
  `) as { id: string }[];
  const token = generateCustomerSessionToken();
  await admin`
    INSERT INTO awcms_commerce_customer_sessions
      (tenant_id, account_id, token_hash, expires_at)
    VALUES (${tenantId}, ${account[0]!.id}, ${hashCustomerSessionToken(token)},
            ${new Date(Date.now() + 86_400_000)})
  `;
  return token;
}

async function newCustomer(
  tenantId: string,
  name: string,
  phone: string
): Promise<string> {
  const rows = (await getHandlerAdminSql()`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
    VALUES (${tenantId}, ${name}, ${phone})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function counts(tenantId: string) {
  const admin = getHandlerAdminSql();
  const rows = (await admin`
    SELECT
      (SELECT count(*)::int FROM awcms_commerce_orders WHERE tenant_id = ${tenantId}) AS orders,
      (SELECT count(*)::int FROM awcms_commerce_booking_reservation_links WHERE tenant_id = ${tenantId}) AS links,
      (SELECT count(*)::int FROM awcms_booking_reservations WHERE tenant_id = ${tenantId}) AS reservations
  `) as { orders: number; links: number; reservations: number }[];
  return rows[0]!;
}

const suite = integrationEnabled ? describe : describe.skip;
let handlerReady = false;

function skipUnlessHandlerReady(): boolean {
  if (handlerReady) return false;
  console.warn(
    "[skip] handler database is not migrated - run 'bun run db:migrate' against DATABASE_URL."
  );
  return true;
}

async function readyOwner(): Promise<{ owner: Principal; fx: Fixture }> {
  const owner = await bootstrapOwner();
  expect((await setBookingFeature(owner, true)).status).toBe(200);
  expect(
    (
      await putSettings(owner, {
        bookingServiceTenantUserId: owner.tenantUserId
      })
    ).status
  ).toBe(200);
  // The anonymous storefront resolves this tenant by the default id.
  process.env.PUBLIC_DEFAULT_TENANT_ID = owner.tenantId;
  return { owner, fx: await seedFixture(owner) };
}

suite("booking reservation routes (Issue #380)", () => {
  const previousDefaultTenant = process.env.PUBLIC_DEFAULT_TENANT_ID;

  beforeAll(async () => {
    handlerReady = await ensureHandlerDatabaseReady();
  });
  afterAll(async () => {
    if (previousDefaultTenant === undefined) {
      delete process.env.PUBLIC_DEFAULT_TENANT_ID;
    } else {
      process.env.PUBLIC_DEFAULT_TENANT_ID = previousDefaultTenant;
    }
    await teardownHandlerDatabase();
  });
  beforeEach(async () => {
    resetRateLimitForTests();
    if (!handlerReady) return;
    await resetHandlerDatabase();
  });

  test("every route is off until the tenant opts in: 409 for staff, the neutral 404 for the storefront", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    process.env.PUBLIC_DEFAULT_TENANT_ID = owner.tenantId;
    const fx = await seedFixtureWithoutLink(owner);

    const staff = [
      await staffPost(owner, body(fx)),
      await invoke<Envelope>(staffGet, {
        path: `/api/v1/commerce/booking/reservations/${UNKNOWN_ID}`,
        headers: headers(owner),
        params: { id: UNKNOWN_ID }
      }),
      await invoke<Envelope>(reconciliation, {
        path: "/api/v1/commerce/booking/reconciliation",
        headers: headers(owner)
      })
    ];
    for (const response of staff) {
      expect(response.status).toBe(409);
      expect(response.body.error?.code).toBe("FEATURE_DISABLED");
    }
    expect((await storefrontPost(body(fx))).status).toBe(404);
    expect(
      (await storefrontRead("ANY-CODE", "?phone=081311112222")).status
    ).toBe(404);
    expect(await counts(owner.tenantId)).toEqual({
      orders: 0,
      links: 0,
      reservations: 0
    });
  });

  test("create and read are separate powers: a reader cannot hold-to-order, a creator cannot read, nothing is written", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, fx } = await readyOwner();
    const reader = await seedPrincipal(owner.tenantId, "reader", [
      "commerce.booking_reservation_links.read"
    ]);
    const creator = await seedPrincipal(owner.tenantId, "creator", [
      "commerce.booking_reservation_links.create"
    ]);
    const nobody = await seedPrincipal(owner.tenantId, "nobody", []);

    for (const who of [reader, nobody]) {
      const denied = await staffPost(who, body(fx));
      expect(denied.status).toBe(403);
    }
    expect(await counts(owner.tenantId)).toEqual({
      orders: 0,
      links: 0,
      reservations: 0
    });

    const made = await staffPost(creator, body(fx));
    expect(made.status).toBe(201);
    const id = made.body.data.reservation.id;

    const asCreator = await invoke<Envelope>(staffGet, {
      path: `/api/v1/commerce/booking/reservations/${id}`,
      headers: headers(creator),
      params: { id }
    });
    expect(asCreator.status).toBe(403);
    const asReader = await invoke<Envelope<Record<string, unknown>>>(staffGet, {
      path: `/api/v1/commerce/booking/reservations/${id}`,
      headers: headers(reader),
      params: { id }
    });
    expect(asReader.status).toBe(200);
    expect(asReader.body.data.attentionReason).toBeNull();
    expect(asReader.body.data.attentionOpen).toBe(false);
    expect(asReader.body.data).not.toHaveProperty("customerId");
    expect(
      (
        await invoke<Envelope>(reconciliation, {
          path: "/api/v1/commerce/booking/reconciliation",
          headers: headers(creator)
        })
      ).status
    ).toBe(403);
  });

  test("the staff create: a key and a guest are required, a body naming a price is 400, 201 then a 200 replay, a changed body is a conflict", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, fx } = await readyOwner();

    expect((await staffPost(owner, body(fx), null)).status).toBe(400);
    expect(
      (await staffPost(owner, body(fx, { guest: undefined }))).status
    ).toBe(400);
    for (const field of ["price", "amount", "deposit", "customerId"]) {
      const refused = await staffPost(owner, body(fx, { [field]: "1.00" }));
      expect(refused.status, field).toBe(400);
    }
    expect(await counts(owner.tenantId)).toEqual({
      orders: 0,
      links: 0,
      reservations: 0
    });

    const key = nextKey();
    const first = await staffPost(owner, body(fx), key);
    expect(first.status).toBe(201);
    expect(first.body.data.replayed).toBe(false);
    expect(first.body.data.reservation.status).toBe("held");
    expect(first.body.data.settlement.total).toBe("1000000.00");

    const again = await staffPost(owner, body(fx), key);
    expect(again.status).toBe(200);
    expect(again.body.data.replayed).toBe(true);
    expect(again.body.data.orderId).toBe(first.body.data.orderId);
    expect(await counts(owner.tenantId)).toEqual({
      orders: 1,
      links: 1,
      reservations: 1
    });

    const conflict = await staffPost(
      owner,
      body(fx, { stay: { checkInDate: day(10), checkOutDate: day(11) } }),
      key
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");

    // A Booking refusal keeps Booking's code and writes nothing.
    await staffPost(owner, body(fx), nextKey());
    await staffPost(owner, body(fx), nextKey());
    const full = await staffPost(owner, body(fx), nextKey());
    expect(full.status).toBe(409);
    expect(full.body.error?.code).toBe("SLOT_UNAVAILABLE");
    expect((await counts(owner.tenantId)).orders).toBe(3);
  });

  test("the storefront create: a guest works, a live bearer makes the order the account's own, a dead bearer is 401, the CORS preflight allows the key", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, fx } = await readyOwner();

    const guest = await storefrontPost(body(fx));
    expect(guest.status).toBe(201);
    expect(guest.body.data.reservation.status).toBe("held");
    // The anonymous guest block is required.
    expect((await storefrontPost(body(fx, { guest: undefined }))).status).toBe(
      400
    );
    expect((await storefrontPost(body(fx), {}, null)).status).toBe(400);

    const customerId = await newCustomer(
      owner.tenantId,
      "Siti",
      "+6281322223333"
    );
    const token = await bearerFor(owner.tenantId, customerId);
    const signedIn = await storefrontPost(
      body(fx, {
        guest: undefined,
        stay: { checkInDate: day(5), checkOutDate: day(6) }
      }),
      { authorization: `Bearer ${token}` }
    );
    expect(signedIn.status).toBe(201);
    const owned = (await getHandlerAdminSql()`
      SELECT customer_id FROM awcms_commerce_orders WHERE id = ${signedIn.body.data.orderId}
    `) as { customer_id: string }[];
    expect(owned[0]!.customer_id).toBe(customerId);

    const dead = await storefrontPost(body(fx, { guest: undefined }), {
      authorization: `Bearer ${generateCustomerSessionToken()}`
    });
    expect(dead.status).toBe(401);
    expect(dead.body.error?.code).toBe("UNAUTHENTICATED");

    const preflight = await invoke(storefrontCreatePreflight, {
      method: "OPTIONS",
      path: "/api/v1/commerce/storefront/booking/reservations",
      headers: { "access-control-request-method": "POST" }
    });
    expect([200, 204]).toContain(preflight.status);
  });

  test("the storefront read: the order's phone or the owner's bearer; another customer, a wrong phone and an unknown code are one 404; no staff field", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, fx } = await readyOwner();
    const first = await storefrontPost(body(fx));
    expect(first.status).toBe(201);
    const code = first.body.data.orderCode;

    const byPhone = await storefrontRead(code, "?phone=081311112222");
    expect(byPhone.status).toBe(200);
    expect(byPhone.body.data.orderCode).toBe(code);
    expect(byPhone.body.data.status).toBe("held");
    expect(byPhone.body.data).not.toHaveProperty("attentionReason");
    expect(byPhone.body.data).not.toHaveProperty("customerId");
    expect(
      (byPhone.body.data.settlement as { balanceDue: string }).balanceDue
    ).toBe("1000000.00");

    expect((await storefrontRead(code, "?phone=081300000000")).status).toBe(
      404
    );
    expect((await storefrontRead(code)).status).toBe(404);
    expect(
      (await storefrontRead("NO-SUCH-CODE", "?phone=081311112222")).status
    ).toBe(404);

    const orderCustomer = (await getHandlerAdminSql()`
      SELECT customer_id FROM awcms_commerce_orders WHERE order_code = ${code}
    `) as { customer_id: string }[];
    const ownerToken = await bearerFor(
      owner.tenantId,
      orderCustomer[0]!.customer_id
    );
    const otherId = await newCustomer(owner.tenantId, "Lain", "+6281399990000");
    const otherToken = await bearerFor(owner.tenantId, otherId);

    expect(
      (
        await storefrontRead(code, "", {
          authorization: `Bearer ${ownerToken}`
        })
      ).status
    ).toBe(200);
    expect(
      (
        await storefrontRead(code, "", {
          authorization: `Bearer ${otherToken}`
        })
      ).status
    ).toBe(404);
    expect(
      (
        await storefrontRead(code, "", {
          authorization: `Bearer ${generateCustomerSessionToken()}`
        })
      ).status
    ).toBe(401);
  });

  test("the reconciliation route answers an empty report on a clean tenant", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, fx } = await readyOwner();
    await staffPost(owner, body(fx));
    const report = await invoke<
      Envelope<{ items: unknown[]; truncated: boolean }>
    >(reconciliation, {
      path: "/api/v1/commerce/booking/reconciliation",
      headers: headers(owner)
    });
    expect(report.status).toBe(200);
    expect(report.body.data).toEqual({ items: [], truncated: false });
  });
});

/** A fixture whose offering is NOT linked (the feature is still off, so the link route would refuse). */
async function seedFixtureWithoutLink(owner: Principal): Promise<Fixture> {
  fixtureSeq += 1;
  const code = `u${fixtureSeq}`;
  const admin = getHandlerAdminSql();
  const resource = (await admin`
    INSERT INTO awcms_booking_resources
      (tenant_id, code, name, kind, capacity, timezone, booking_mode,
       stay_check_in_time, stay_check_out_time)
    VALUES (${owner.tenantId}, ${code}, ${`Room ${code}`}, 'room', 1,
            'Asia/Pontianak', 'stay', '14:00'::time, '12:00'::time)
    RETURNING id
  `) as { id: string }[];
  const offering = (await admin`
    INSERT INTO awcms_booking_service_offerings
      (tenant_id, code, name, granularity, min_nights, max_nights, max_party, confirmation_mode)
    VALUES (${owner.tenantId}, ${`night-${code}`}, 'Night', 'stay', 1, 30, 4, 'hold_then_confirm')
    RETURNING id
  `) as { id: string }[];
  return {
    productId: UNKNOWN_ID,
    offeringId: offering[0]!.id,
    resourceId: resource[0]!.id
  };
}
