/**
 * The anonymous booking reads and the shopper's own reservation list through
 * the REAL route handlers (Issue #386, ADR-0045 implementation notes). World 2
 * of `harness.ts`: handlers use `getDatabaseClient()`; the tenant is the one
 * `PUBLIC_DEFAULT_TENANT_ID` names, or - for the isolation test - the one a
 * cross-origin `Origin` host resolves to through `awcms_tenant_domains`.
 *
 *   - every read is the neutral `404` until the tenant opts into `booking`;
 *   - the offerings list shows only what is SOLD (active link, active service
 *     product, active hold-then-confirm offering, an active resource of the
 *     right mode) and carries ids, never a resource name or an offering code;
 *   - availability carries no PII and no resource name: before and after a
 *     real guest's booking, the serialised body names neither the guest, the
 *     phone, the order, the reservation nor the room; a full range is
 *     `available: false` with the neutral `UTC` zone;
 *   - tenant isolation by host: tenant A's offering through tenant B's origin
 *     is the same `404` as an unknown id, and B's list never contains A's;
 *   - bounds and validation are `400`s, an unlinked/unknown offering one `404`,
 *     the limiter answers `429`;
 *   - the quote's nights, total and deposit come from the server;
 *   - the own list needs a live bearer (`401` otherwise), shows only the
 *     caller's reservations, pages by cursor and carries no staff field.
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
import { resetRateLimitForTests } from "../../src/lib/security/rate-limit";
import {
  generateCustomerSessionToken,
  hashCustomerSessionToken
} from "../../src/modules/commerce/domain/customer-session-token";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import { PUT as putStoreSettings } from "../../src/pages/api/v1/commerce/store-settings/index";
import { GET as availabilityGet } from "../../src/pages/api/v1/commerce/storefront/booking/availability";
import { GET as offeringsGet } from "../../src/pages/api/v1/commerce/storefront/booking/offerings";
import { GET as quoteGet } from "../../src/pages/api/v1/commerce/storefront/booking/quote";
import {
  GET as ownListGet,
  POST as storefrontCreate
} from "../../src/pages/api/v1/commerce/storefront/booking/reservations/index";

const OWNER_PASSWORD = "integration-test-owner-password";
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000aa";
const HOST_A = "stay-a.example.test";
const HOST_B = "stay-b.example.test";
const TENANT_B = "38600000-0386-4000-8000-00000000000b";

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

const ownerHeaders = (who: Principal) => ({
  "content-type": "application/json",
  "x-awcms-tenant-id": who.tenantId,
  authorization: `Bearer ${who.token}`
});

function setBookingFeature(who: Principal, booking: boolean) {
  return invoke<Envelope>(patchModuleSettings, {
    method: "PATCH",
    path: "/api/v1/tenant/modules/commerce/settings",
    headers: ownerHeaders(who),
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
    headers: ownerHeaders(who),
    body: {
      storeName: "Villa",
      shipping: { selfPickup: true },
      payment: { manualQris: { active: true, mediaObjectId: null } },
      ...extra
    }
  });

type Stay = {
  productId: string;
  offeringId: string;
  resourceId: string;
  resourceName: string;
};
let seq = 0;

/** One sold stay (product, resource of 3 units, offering, ACTIVE link) written straight to the tables. */
async function seedStay(
  tenantId: string,
  options: {
    link?: boolean;
    confirmationMode?: "hold_then_confirm" | "immediate";
    productStatus?: "active" | "draft";
    resourceMode?: "stay" | "slot";
    price?: string;
  } = {}
): Promise<Stay> {
  seq += 1;
  const code = `s${seq}`;
  const admin = getHandlerAdminSql();
  const resourceName = `Room Rahasia ${code}`;
  const product = (await admin`
    INSERT INTO awcms_commerce_products
      (tenant_id, type, sku, name, slug, price, stock, status)
    VALUES (${tenantId}, 'service', ${`SKU-${code}`}, ${`Kamar ${code}`},
            ${`kamar-${code}`}, ${options.price ?? "500000.00"}, 0,
            ${options.productStatus ?? "active"})
    RETURNING id
  `) as { id: string }[];
  const mode = options.resourceMode ?? "stay";
  const resource = (await admin`
    INSERT INTO awcms_booking_resources
      (tenant_id, code, name, kind, capacity, timezone, booking_mode,
       stay_check_in_time, stay_check_out_time)
    VALUES (${tenantId}, ${code}, ${resourceName}, 'room', 3,
            'Asia/Pontianak', ${mode},
            ${mode === "stay" ? "14:00" : null}::time,
            ${mode === "stay" ? "12:00" : null}::time)
    RETURNING id
  `) as { id: string }[];
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    await admin`
      INSERT INTO awcms_booking_resource_units (tenant_id, resource_id, ordinal, label)
      VALUES (${tenantId}, ${resource[0]!.id}, ${ordinal}, ${`Unit ${ordinal}`})
    `;
  }
  const offering = (await admin`
    INSERT INTO awcms_booking_service_offerings
      (tenant_id, code, name, granularity, min_nights, max_nights, max_party, confirmation_mode)
    VALUES (${tenantId}, ${`night-${code}`}, ${`Kode Internal ${code}`}, 'stay', 1, 30, 4,
            ${options.confirmationMode ?? "hold_then_confirm"})
    RETURNING id
  `) as { id: string }[];
  if (options.link !== false) {
    await admin`
      INSERT INTO awcms_commerce_booking_offering_links
        (tenant_id, offering_id, product_id, quantity_basis)
      VALUES (${tenantId}, ${offering[0]!.id}, ${product[0]!.id}, 'nights')
    `;
  }
  return {
    productId: product[0]!.id,
    offeringId: offering[0]!.id,
    resourceId: resource[0]!.id,
    resourceName
  };
}

const day = (offset: number): string =>
  new Date(Date.now() + (60 + offset) * 86_400_000).toISOString().slice(0, 10);

const get = <T = Record<string, unknown>>(
  handler: Parameters<typeof invoke>[0],
  path: string,
  headers: Record<string, string> = {}
) => invoke<Envelope<T>>(handler, { path, headers });

const availabilityPath = (fx: Stay, extra = "") =>
  `/api/v1/commerce/storefront/booking/availability?offeringId=${fx.offeringId}&resourceId=${fx.resourceId}&checkInDate=${day(1)}&checkOutDate=${day(3)}${extra}`;

let keySeq = 0;
const nextKey = () => `bk386-${Date.now()}-${(keySeq += 1)}`;

const book = (
  fx: Stay,
  extra: Record<string, string> = {},
  overrides: Record<string, unknown> = {}
) =>
  invoke<Envelope<{ orderCode: string; reservation: { id: string } }>>(
    storefrontCreate,
    {
      method: "POST",
      path: "/api/v1/commerce/storefront/booking/reservations",
      headers: {
        "content-type": "application/json",
        "idempotency-key": nextKey(),
        ...extra
      },
      body: {
        offeringId: fx.offeringId,
        resourceId: fx.resourceId,
        stay: { checkInDate: day(1), checkOutDate: day(3) },
        partySize: 2,
        guest: { name: "Budi Rahasia", phone: "081311112222" },
        payment: { method: "manual_qris" },
        ...overrides
      }
    }
  );

async function bearerFor(tenantId: string, name: string, phone: string) {
  const admin = getHandlerAdminSql();
  const customer = (await admin`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
    VALUES (${tenantId}, ${name}, ${phone})
    RETURNING id
  `) as { id: string }[];
  const account = (await admin`
    INSERT INTO awcms_commerce_customer_accounts
      (tenant_id, customer_id, email_normalized, history_from)
    VALUES (${tenantId}, ${customer[0]!.id}, ${`${customer[0]!.id}@example.com`}, now() - interval '1 day')
    RETURNING id
  `) as { id: string }[];
  const token = generateCustomerSessionToken();
  await admin`
    INSERT INTO awcms_commerce_customer_sessions
      (tenant_id, account_id, token_hash, expires_at)
    VALUES (${tenantId}, ${account[0]!.id}, ${hashCustomerSessionToken(token)},
            ${new Date(Date.now() + 86_400_000)})
  `;
  return { customerId: customer[0]!.id, token };
}

async function seedTenantB(): Promise<Stay> {
  const admin = getHandlerAdminSql();
  await admin`
    INSERT INTO awcms_tenants (id, tenant_code, tenant_name, status)
    VALUES (${TENANT_B}, 'stay-b', 'Stay B', 'active')
  `;
  await admin`
    INSERT INTO awcms_modules (module_key, module_name)
    VALUES ('commerce', 'Commerce') ON CONFLICT (module_key) DO NOTHING
  `;
  await admin`
    INSERT INTO awcms_tenant_modules (tenant_id, module_key, enabled)
    VALUES (${TENANT_B}, 'commerce', true)
  `;
  await admin`
    INSERT INTO awcms_module_settings (tenant_id, module_key, settings)
    VALUES (${TENANT_B}, 'commerce', '{"features":{"booking":true}}'::jsonb)
  `;
  return seedStay(TENANT_B);
}

async function mapHost(tenantId: string, host: string) {
  await getHandlerAdminSql()`
    INSERT INTO awcms_tenant_domains
      (tenant_id, hostname, normalized_hostname, status, verified_at)
    VALUES (${tenantId}, ${host}, ${host}, 'active', now())
  `;
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

async function readyOwner(): Promise<{ owner: Principal; fx: Stay }> {
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
  return { owner, fx: await seedStay(owner.tenantId) };
}

suite("booking storefront reads (Issue #386)", () => {
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

  test("every read is the neutral 404 until the tenant opts into the booking feature", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    process.env.PUBLIC_DEFAULT_TENANT_ID = owner.tenantId;
    const fx = await seedStay(owner.tenantId);
    const { token } = await bearerFor(owner.tenantId, "Siti", "+6281322223333");

    const base = "/api/v1/commerce/storefront/booking";
    const responses = [
      await get(offeringsGet, `${base}/offerings`),
      await get(availabilityGet, availabilityPath(fx)),
      await get(
        quoteGet,
        `${base}/quote?offeringId=${fx.offeringId}&checkInDate=${day(1)}&checkOutDate=${day(3)}`
      ),
      await get(ownListGet, `${base}/reservations`, {
        authorization: `Bearer ${token}`
      })
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body.error?.code).toBe("NOT_FOUND");
    }
  });

  test("the offerings list shows what is sold, by id and public name only", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, fx } = await readyOwner();
    // None of these may be listed: unlinked, immediate, draft product, slot-mode resource only.
    await seedStay(owner.tenantId, { link: false });
    await seedStay(owner.tenantId, { confirmationMode: "immediate" });
    await seedStay(owner.tenantId, { productStatus: "draft" });

    const listed = await get<{
      items: Record<string, unknown>[];
    }>(offeringsGet, "/api/v1/commerce/storefront/booking/offerings");
    expect(listed.status).toBe(200);
    expect(listed.response.headers.get("cache-control")).toBe("no-store");
    const items = listed.body.data.items;
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.offeringId).toBe(fx.offeringId);
    expect(item.granularity).toBe("stay");
    expect(item.quantityBasis).toBe("nights");
    expect(item.unitPrice).toBe("500000.00");
    expect(item.name).toStartWith("Kamar ");
    expect(item.minNights).toBe(1);
    expect(item.maxNights).toBe(30);
    // The three seeded siblings share the tenant's stay-mode resources, so the
    // list offers every ACTIVE stay resource - ids only.
    expect((item.resourceIds as string[]).length).toBeGreaterThanOrEqual(1);
    expect(item.resourceIds as string[]).toContain(fx.resourceId);
    const serialised = JSON.stringify(listed.body);
    expect(serialised).not.toContain("Rahasia");
    expect(serialised).not.toContain("Kode Internal");
    expect(serialised).not.toContain("Unit 1");

    expect(
      (
        await get(
          offeringsGet,
          "/api/v1/commerce/storefront/booking/offerings?tenantId=" +
            owner.tenantId
        )
      ).status
    ).toBe(400);
  });

  test("availability carries no PII and no resource name, before and after a real booking", async () => {
    if (skipUnlessHandlerReady()) return;
    const { fx } = await readyOwner();

    const free = await get(availabilityGet, availabilityPath(fx));
    expect(free.status).toBe(200);
    expect(free.body.data).toMatchObject({
      mode: "stay",
      timezone: "Asia/Pontianak",
      nights: 2,
      available: true,
      freeUnits: 3
    });
    expect(free.response.headers.get("cache-control")).toBe("no-store");

    const booked = await book(fx);
    expect(booked.status).toBe(201);
    const orderCode = booked.body.data.orderCode;
    const reservationId = booked.body.data.reservation.id;

    const after = await get(availabilityGet, availabilityPath(fx));
    expect(after.status).toBe(200);
    expect(after.body.data).toMatchObject({ available: true, freeUnits: 2 });
    const serialised = JSON.stringify(after.body);
    for (const secret of [
      "Budi",
      "Rahasia",
      "0813",
      "81311112222",
      orderCode,
      reservationId,
      fx.resourceName,
      "Unit 1",
      "externalRef",
      "customer"
    ]) {
      expect(serialised, secret).not.toContain(secret);
    }
    // Only the documented keys.
    expect(Object.keys(after.body.data as object).sort()).toEqual([
      "available",
      "checkInDate",
      "checkOutDate",
      "freeUnits",
      "mode",
      "nights",
      "timezone"
    ]);

    // Fill the room: two more holds, then the range is full.
    expect(
      (await book(fx, {}, { guest: { name: "Ani", phone: "081311113333" } }))
        .status
    ).toBe(201);
    expect(
      (await book(fx, {}, { guest: { name: "Eka", phone: "081311114444" } }))
        .status
    ).toBe(201);
    const full = await get(availabilityGet, availabilityPath(fx));
    expect(full.status).toBe(200);
    expect(full.body.data).toMatchObject({
      available: false,
      freeUnits: 0,
      nights: null,
      timezone: "UTC",
      reason: "SLOT_UNAVAILABLE"
    });

    // An unknown resource id is the SAME answer as a full range (no oracle).
    const probe = await get(
      availabilityGet,
      `/api/v1/commerce/storefront/booking/availability?offeringId=${fx.offeringId}&resourceId=${UNKNOWN_ID}&checkInDate=${day(1)}&checkOutDate=${day(3)}`
    );
    expect(probe.status).toBe(200);
    expect(probe.body.data).toEqual(full.body.data);
  });

  test("bounds and validation are 400s; an unlinked, unknown or unsold offering is one 404", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, fx } = await readyOwner();
    const base = "/api/v1/commerce/storefront/booking/availability";
    const ids = `offeringId=${fx.offeringId}&resourceId=${fx.resourceId}`;

    const bad = [
      `${base}?${ids}`,
      `${base}?${ids}&checkInDate=${day(3)}&checkOutDate=${day(1)}`,
      `${base}?${ids}&checkInDate=${day(1)}&checkOutDate=${day(1)}`,
      `${base}?${ids}&checkInDate=${day(1)}&checkOutDate=${day(400)}`,
      `${base}?${ids}&checkInDate=2020-01-01&checkOutDate=2020-01-03`,
      `${base}?${ids}&checkInDate=${day(900)}&checkOutDate=${day(902)}`,
      `${base}?${ids}&checkInDate=2026-02-30&checkOutDate=2026-03-02`,
      `${base}?offeringId=nope&resourceId=${fx.resourceId}&checkInDate=${day(1)}&checkOutDate=${day(3)}`,
      `${base}?${ids}&checkInDate=${day(1)}&checkOutDate=${day(3)}&tenantId=${owner.tenantId}`,
      `${base}?${ids}&from=${day(1)}T00:00:00Z&to=${day(40)}T00:00:00Z`
    ];
    for (const path of bad) {
      const response = await get(availabilityGet, path);
      expect(response.status, path).toBe(400);
      expect(response.body.error?.code, path).toBe("VALIDATION_ERROR");
    }

    const unlinked = await seedStay(owner.tenantId, { link: false });
    const immediate = await seedStay(owner.tenantId, {
      confirmationMode: "immediate"
    });
    const draft = await seedStay(owner.tenantId, { productStatus: "draft" });
    const refused = [
      availabilityPath(unlinked),
      availabilityPath(immediate),
      availabilityPath(draft),
      `${base}?offeringId=${UNKNOWN_ID}&resourceId=${fx.resourceId}&checkInDate=${day(1)}&checkOutDate=${day(3)}`
    ];
    const bodies = [];
    for (const path of refused) {
      const response = await get(availabilityGet, path);
      expect(response.status, path).toBe(404);
      expect(response.body.error?.code, path).toBe("NOT_FOUND");
      bodies.push(JSON.stringify(response.body));
    }
    // One answer, whichever reason.
    expect(new Set(bodies).size).toBe(1);

    // A stay asked of a time offering is the caller's mistake, not an oracle.
    const slot = await get(
      availabilityGet,
      `${base}?${ids}&from=${day(1)}T00:00:00Z&to=${day(2)}T00:00:00Z`
    );
    expect(slot.status).toBe(400);
  });

  test("tenant isolation by host: another tenant's offering is the same 404, and each list holds only its own", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, fx } = await readyOwner();
    const fxB = await seedTenantB();
    await mapHost(owner.tenantId, HOST_A);
    await mapHost(TENANT_B, HOST_B);
    delete process.env.PUBLIC_DEFAULT_TENANT_ID;
    const asA = { origin: `https://${HOST_A}` };
    const asB = { origin: `https://${HOST_B}` };

    expect((await get(availabilityGet, availabilityPath(fx), asA)).status).toBe(
      200
    );
    expect(
      (await get(availabilityGet, availabilityPath(fxB), asB)).status
    ).toBe(200);

    const crossA = await get(availabilityGet, availabilityPath(fx), asB);
    const crossB = await get(availabilityGet, availabilityPath(fxB), asA);
    const unknown = await get(
      availabilityGet,
      availabilityPath({ ...fx, offeringId: UNKNOWN_ID }),
      asA
    );
    for (const response of [crossA, crossB, unknown]) {
      expect(response.status).toBe(404);
      expect(response.body.error?.code).toBe("NOT_FOUND");
    }
    expect(JSON.stringify(crossA.body)).toBe(JSON.stringify(unknown.body));

    const listA = await get<{
      items: { offeringId: string; resourceIds: string[] }[];
    }>(offeringsGet, "/api/v1/commerce/storefront/booking/offerings", asA);
    const listB = await get<{
      items: { offeringId: string; resourceIds: string[] }[];
    }>(offeringsGet, "/api/v1/commerce/storefront/booking/offerings", asB);
    expect(listA.body.data.items.map((i) => i.offeringId)).toEqual([
      fx.offeringId
    ]);
    expect(listB.body.data.items.map((i) => i.offeringId)).toEqual([
      fxB.offeringId
    ]);
    expect(listA.body.data.items[0]!.resourceIds).not.toContain(fxB.resourceId);
    expect(listB.body.data.items[0]!.resourceIds).not.toContain(fx.resourceId);

    // A quote and a probe of the other tenant's resource are no oracle either.
    const quoteCross = await get(
      quoteGet,
      `/api/v1/commerce/storefront/booking/quote?offeringId=${fxB.offeringId}&checkInDate=${day(1)}&checkOutDate=${day(3)}`,
      asA
    );
    expect(quoteCross.status).toBe(404);
    const resourceCross = await get(
      availabilityGet,
      `/api/v1/commerce/storefront/booking/availability?offeringId=${fx.offeringId}&resourceId=${fxB.resourceId}&checkInDate=${day(1)}&checkOutDate=${day(3)}`,
      asA
    );
    expect(resourceCross.status).toBe(200);
    expect(resourceCross.body.data).toMatchObject({
      available: false,
      freeUnits: 0,
      timezone: "UTC"
    });
  });

  test("the route is rate limited per client", async () => {
    if (skipUnlessHandlerReady()) return;
    const { fx } = await readyOwner();
    let limited = 0;
    for (let call = 0; call < 62; call += 1) {
      const response = await get(availabilityGet, availabilityPath(fx));
      if (response.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThanOrEqual(1);
  });

  test("the quote's nights, total and deposit come from the server", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, fx } = await readyOwner();
    const base = "/api/v1/commerce/storefront/booking/quote";
    const stay = `offeringId=${fx.offeringId}&checkInDate=${day(1)}&checkOutDate=${day(4)}`;

    const quoted = await get<Record<string, any>>(quoteGet, `${base}?${stay}`);
    expect(quoted.status).toBe(200);
    expect(quoted.body.data).toMatchObject({
      nights: 3,
      quantity: 3,
      unitPrice: "500000.00",
      total: "1500000.00",
      canCheckout: true
    });
    expect(quoted.body.data.deposit.available).toBe(false);
    expect(quoted.body.data.product.name).toStartWith("Kamar ");
    expect(JSON.stringify(quoted.body)).not.toContain("Rahasia");

    // A 30 percent deposit policy on the product: the server computes it.
    await getHandlerAdminSql()`
      INSERT INTO awcms_commerce_product_deposit_policies
        (tenant_id, product_id, kind, percent)
      VALUES (${owner.tenantId}, ${fx.productId}, 'percent', 30)
    `;
    const withDeposit = await get<Record<string, any>>(
      quoteGet,
      `${base}?${stay}`
    );
    expect(withDeposit.body.data.deposit).toEqual({
      available: true,
      amount: "450000.00",
      balanceDue: "1050000.00"
    });

    // The offering's own limits (max 30 nights) and a client-sent night count.
    expect(
      (
        await get(
          quoteGet,
          `${base}?offeringId=${fx.offeringId}&checkInDate=${day(1)}&checkOutDate=${day(45)}`
        )
      ).status
    ).toBe(400);
    expect(
      (await get(quoteGet, `${base}?offeringId=${fx.offeringId}`)).status
    ).toBe(400);
    expect(
      (await get(quoteGet, `${base}?${stay}&nights=1&total=1.00`)).status
    ).toBe(400);
    expect(
      (
        await get(
          quoteGet,
          `${base}?offeringId=${UNKNOWN_ID}&checkInDate=${day(1)}&checkOutDate=${day(2)}`
        )
      ).status
    ).toBe(404);
  });

  test("the own list needs a live bearer, shows only the caller's reservations, pages by cursor and carries no staff field", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, fx } = await readyOwner();
    const siti = await bearerFor(owner.tenantId, "Siti", "+6281322223333");
    const dewi = await bearerFor(owner.tenantId, "Dewi", "+6281322224444");
    const path = "/api/v1/commerce/storefront/booking/reservations";
    const as = (token: string) => ({ authorization: `Bearer ${token}` });

    expect((await get(ownListGet, path)).status).toBe(401);
    const dead = await get(
      ownListGet,
      path,
      as(generateCustomerSessionToken())
    );
    expect(dead.status).toBe(401);
    expect(dead.body.error?.code).toBe("UNAUTHENTICATED");

    // Two for Siti (the second on other nights), one guest, one for Dewi.
    expect((await book(fx, as(siti.token), { guest: undefined })).status).toBe(
      201
    );
    expect(
      (
        await book(fx, as(siti.token), {
          guest: undefined,
          stay: { checkInDate: day(10), checkOutDate: day(13) }
        })
      ).status
    ).toBe(201);
    expect((await book(fx)).status).toBe(201);
    expect(
      (
        await book(fx, as(dewi.token), {
          guest: undefined,
          stay: { checkInDate: day(20), checkOutDate: day(21) }
        })
      ).status
    ).toBe(201);

    const mine = await get<{
      items: Record<string, any>[];
      nextCursor: string | null;
    }>(ownListGet, path, as(siti.token));
    expect(mine.status).toBe(200);
    expect(mine.body.data.items).toHaveLength(2);
    expect(mine.body.data.nextCursor).toBeNull();
    const [newest, older] = mine.body.data.items;
    expect(newest).toMatchObject({
      status: "held",
      nights: 3,
      paymentMethod: "manual_qris"
    });
    expect(newest!.productName).toStartWith("Kamar ");
    expect(newest!.settlement.total).toBe("1500000.00");
    expect(newest!.settlement.balanceDue).toBe("1500000.00");
    expect(typeof newest!.holdExpiresAt).toBe("string");
    expect(older).toMatchObject({ nights: 2 });
    for (const item of mine.body.data.items) {
      expect(item).not.toHaveProperty("attentionReason");
      expect(item).not.toHaveProperty("customerId");
      expect(item).not.toHaveProperty("phone");
    }
    expect(JSON.stringify(mine.body)).not.toContain("Budi");

    const theirs = await get<{ items: Record<string, any>[] }>(
      ownListGet,
      path,
      as(dewi.token)
    );
    expect(theirs.body.data.items).toHaveLength(1);
    expect(theirs.body.data.items[0]!.orderCode).not.toBe(newest!.orderCode);

    // Cursor paging: one at a time, no overlap, no gap.
    const first = await get<{
      items: Record<string, any>[];
      nextCursor: string | null;
    }>(ownListGet, `${path}?limit=1`, as(siti.token));
    expect(first.body.data.items).toHaveLength(1);
    expect(first.body.data.nextCursor).not.toBeNull();
    const second = await get<{
      items: Record<string, any>[];
      nextCursor: string | null;
    }>(
      ownListGet,
      `${path}?limit=1&cursor=${encodeURIComponent(first.body.data.nextCursor!)}`,
      as(siti.token)
    );
    expect(second.body.data.items).toHaveLength(1);
    expect(second.body.data.items[0]!.orderCode).toBe(older!.orderCode);
    expect(first.body.data.items[0]!.orderCode).toBe(newest!.orderCode);
    expect(
      (await get(ownListGet, `${path}?cursor=garbage!`, as(siti.token))).status
    ).toBe(400);
  });
});
