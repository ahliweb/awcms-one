/**
 * An offering link bound to its Booking resource(s), through the REAL route
 * handlers (Issue #437, ADR-0045 implementation notes of #386). World 2 of
 * `harness.ts`: handlers use `getDatabaseClient()`; the storefront tenant is the
 * one `PUBLIC_DEFAULT_TENANT_ID` names.
 *
 * What this file proves, each against live data:
 *   - two room types sold under two offerings NEVER cross: each offering lists
 *     only its own resource, availability for the other room type's resource is
 *     the neutral `404`, and a hold on it is refused (`404 RESOURCE_NOT_FOUND`)
 *     with no order and no reservation written;
 *   - a link that names no resource keeps the #386 behaviour: every active
 *     resource of the matching mode is offered, and a hold on any of them works
 *     (M9: existing tenants unchanged) - whether made through the route or a
 *     row written before the migration existed;
 *   - a bound link whose resources have all gone inactive is NOT sold and does
 *     not fall back to the whole pool;
 *   - the link route proves the CLIENT's ids: an unknown id and another
 *     tenant's id are the same `404`, a resource of the wrong booking mode and
 *     an inactive one are `409`, more than ten / duplicates / non-uuids are
 *     `400`, a replay with the same key writes nothing more;
 *   - the bound ids are shown by create, get and list, in the order given, and
 *     survive an unlink.
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
  assertRejected,
  createCookieJar,
  ensureHandlerDatabaseReady,
  getHandlerAdminSql,
  integrationEnabled,
  invoke,
  resetHandlerDatabase,
  teardownHandlerDatabase
} from "./harness";
import { resetRateLimitForTests } from "../../src/lib/security/rate-limit";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import { PUT as putStoreSettings } from "../../src/pages/api/v1/commerce/store-settings/index";
import {
  GET as listLinks,
  POST as createLink
} from "../../src/pages/api/v1/commerce/booking/offering-links/index";
import {
  GET as getLink,
  PATCH as patchLink
} from "../../src/pages/api/v1/commerce/booking/offering-links/[id]";
import { GET as availabilityGet } from "../../src/pages/api/v1/commerce/storefront/booking/availability";
import { GET as offeringsGet } from "../../src/pages/api/v1/commerce/storefront/booking/offerings";
import { POST as storefrontCreate } from "../../src/pages/api/v1/commerce/storefront/booking/reservations/index";

const OWNER_PASSWORD = "integration-test-owner-password";
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000aa";
const TENANT_B = "43700000-0437-4000-8000-00000000000b";

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

const ownerHeaders = (who: Principal, extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-awcms-tenant-id": who.tenantId,
  authorization: `Bearer ${who.token}`,
  ...extra
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

type LinkBody = {
  id: string;
  offeringId: string;
  productId: string;
  quantityBasis: string;
  resourceIds: string[];
  status: string;
};

let keySeq = 0;
const nextKey = () => `bk437-${Date.now()}-${(keySeq += 1)}`;

const link = (who: Principal, body: unknown, key: string | null = nextKey()) =>
  invoke<Envelope<LinkBody>>(createLink, {
    method: "POST",
    path: "/api/v1/commerce/booking/offering-links",
    headers: ownerHeaders(who, key === null ? {} : { "idempotency-key": key }),
    body
  });

const getOne = (who: Principal, id: string) =>
  invoke<Envelope<LinkBody>>(getLink, {
    path: `/api/v1/commerce/booking/offering-links/${id}`,
    headers: ownerHeaders(who),
    params: { id }
  });

const listAll = (who: Principal) =>
  invoke<Envelope<{ items: LinkBody[] }>>(listLinks, {
    path: "/api/v1/commerce/booking/offering-links",
    headers: ownerHeaders(who)
  });

const unlink = (who: Principal, id: string) =>
  invoke<Envelope<LinkBody>>(patchLink, {
    method: "PATCH",
    path: `/api/v1/commerce/booking/offering-links/${id}`,
    headers: ownerHeaders(who, { "idempotency-key": nextKey() }),
    params: { id },
    body: { status: "unlinked" }
  });

type Room = {
  productId: string;
  offeringId: string;
  resourceId: string;
};

let seq = 0;

async function seedResource(
  tenantId: string,
  options: { mode?: "stay" | "slot"; status?: "active" | "inactive" } = {}
): Promise<string> {
  seq += 1;
  const code = `r${seq}`;
  const mode = options.mode ?? "stay";
  const admin = getHandlerAdminSql();
  const resource = (await admin`
    INSERT INTO awcms_booking_resources
      (tenant_id, code, name, kind, capacity, timezone, booking_mode, status,
       stay_check_in_time, stay_check_out_time)
    VALUES (${tenantId}, ${code}, ${`Kamar ${code}`}, 'room', 2,
            'Asia/Pontianak', ${mode}, ${options.status ?? "active"},
            ${mode === "stay" ? "14:00" : null}::time,
            ${mode === "stay" ? "12:00" : null}::time)
    RETURNING id
  `) as { id: string }[];
  for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
    await admin`
      INSERT INTO awcms_booking_resource_units (tenant_id, resource_id, ordinal, label)
      VALUES (${tenantId}, ${resource[0]!.id}, ${ordinal}, ${`Unit ${ordinal}`})
    `;
  }
  return resource[0]!.id;
}

/** A service product plus a hold-then-confirm STAY offering, NOT linked yet. */
async function seedOffering(
  tenantId: string,
  label: string
): Promise<{ productId: string; offeringId: string }> {
  seq += 1;
  const admin = getHandlerAdminSql();
  const product = (await admin`
    INSERT INTO awcms_commerce_products
      (tenant_id, type, sku, name, slug, price, stock, status)
    VALUES (${tenantId}, 'service', ${`SKU-${seq}`}, ${label}, ${`kamar-${seq}`},
            '500000.00', 0, 'active')
    RETURNING id
  `) as { id: string }[];
  const offering = (await admin`
    INSERT INTO awcms_booking_service_offerings
      (tenant_id, code, name, granularity, min_nights, max_nights, max_party,
       confirmation_mode)
    VALUES (${tenantId}, ${`night-${seq}`}, ${label}, 'stay', 1, 30, 4,
            'hold_then_confirm')
    RETURNING id
  `) as { id: string }[];
  return { productId: product[0]!.id, offeringId: offering[0]!.id };
}

/** One room TYPE: its own product, offering and resource, linked through the ROUTE with its resource. */
async function seedBoundRoom(owner: Principal, label: string): Promise<Room> {
  const resourceId = await seedResource(owner.tenantId);
  const base = await seedOffering(owner.tenantId, label);
  const created = await link(owner, {
    offeringId: base.offeringId,
    productId: base.productId,
    quantityBasis: "nights",
    resourceIds: [resourceId]
  });
  expect(created.status).toBe(201);
  return { ...base, resourceId };
}

const day = (offset: number): string =>
  new Date(Date.now() + (60 + offset) * 86_400_000).toISOString().slice(0, 10);

const get = <T = Record<string, unknown>>(
  handler: Parameters<typeof invoke>[0],
  path: string
) => invoke<Envelope<T>>(handler, { path, headers: {} });

const availabilityPath = (offeringId: string, resourceId: string) =>
  `/api/v1/commerce/storefront/booking/availability?offeringId=${offeringId}&resourceId=${resourceId}&checkInDate=${day(1)}&checkOutDate=${day(3)}`;

const book = (offeringId: string, resourceId: string) =>
  invoke<Envelope<{ orderCode: string }>>(storefrontCreate, {
    method: "POST",
    path: "/api/v1/commerce/storefront/booking/reservations",
    headers: {
      "content-type": "application/json",
      "idempotency-key": nextKey()
    },
    body: {
      offeringId,
      resourceId,
      stay: { checkInDate: day(1), checkOutDate: day(3) },
      partySize: 2,
      guest: { name: "Budi", phone: "081311112222" },
      payment: { method: "manual_qris" }
    }
  });

type Listed = { offeringId: string; resourceIds: string[] };
const offerings = async (): Promise<Listed[]> => {
  const listed = await get<{ items: Listed[] }>(
    offeringsGet,
    "/api/v1/commerce/storefront/booking/offerings"
  );
  expect(listed.status).toBe(200);
  return listed.body.data.items;
};

async function count(table: string, tenantId: string): Promise<number> {
  const rows = (await getHandlerAdminSql().unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
    [tenantId]
  )) as { n: number }[];
  return rows[0]!.n;
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

async function readyOwner(): Promise<Principal> {
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
  return owner;
}

suite("booking offering link resources (Issue #437)", () => {
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

  test("two room types under two offerings never cross: the list, availability and the hold", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await readyOwner();
    const standard = await seedBoundRoom(owner, "Standard");
    const deluxe = await seedBoundRoom(owner, "Deluxe");

    const listed = await offerings();
    expect(listed).toHaveLength(2);
    const byOffering = new Map(
      listed.map((i) => [i.offeringId, i.resourceIds])
    );
    expect(byOffering.get(standard.offeringId)).toEqual([standard.resourceId]);
    expect(byOffering.get(deluxe.offeringId)).toEqual([deluxe.resourceId]);

    // Each room type answers for its own resource ...
    for (const room of [standard, deluxe]) {
      const own = await get(
        availabilityGet,
        availabilityPath(room.offeringId, room.resourceId)
      );
      expect(own.status).toBe(200);
      expect(own.body.data).toMatchObject({ available: true, freeUnits: 2 });
    }
    // ... and for nobody else's: the other type's resource and an unknown id are ONE 404.
    const crossed = await get(
      availabilityGet,
      availabilityPath(standard.offeringId, deluxe.resourceId)
    );
    const unknown = await get(
      availabilityGet,
      availabilityPath(standard.offeringId, UNKNOWN_ID)
    );
    for (const response of [crossed, unknown]) {
      expect(response.status).toBe(404);
      expect(response.body.error?.code).toBe("NOT_FOUND");
    }
    expect(JSON.stringify(crossed.body)).toBe(JSON.stringify(unknown.body));

    // A shopper holding "Standard" against the "Deluxe" resource is refused, and
    // nothing is written: no order, no Booking reservation.
    const refused = await book(standard.offeringId, deluxe.resourceId);
    expect(refused.status).toBe(404);
    expect(refused.body.error?.code).toBe("RESOURCE_NOT_FOUND");
    expect(await count("awcms_commerce_orders", owner.tenantId)).toBe(0);
    expect(await count("awcms_booking_reservations", owner.tenantId)).toBe(0);

    // The right pairing works, and only its own room's capacity is used.
    const held = await book(deluxe.offeringId, deluxe.resourceId);
    expect(held.status).toBe(201);
    const after = await get(
      availabilityGet,
      availabilityPath(deluxe.offeringId, deluxe.resourceId)
    );
    expect(after.body.data).toMatchObject({ freeUnits: 1 });
    const untouched = await get(
      availabilityGet,
      availabilityPath(standard.offeringId, standard.resourceId)
    );
    expect(untouched.body.data).toMatchObject({ freeUnits: 2 });
  });

  test("a link that names no resource keeps the fallback: every active resource of the mode, and a hold on any of them", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await readyOwner();
    const first = await seedResource(owner.tenantId);
    const second = await seedResource(owner.tenantId);
    await seedResource(owner.tenantId, { status: "inactive" });
    await seedResource(owner.tenantId, { mode: "slot" });

    // One link through the route with no resourceIds ...
    const viaRoute = await seedOffering(owner.tenantId, "Via route");
    const created = await link(owner, {
      offeringId: viaRoute.offeringId,
      productId: viaRoute.productId,
      quantityBasis: "nights"
    });
    expect(created.status).toBe(201);
    expect(created.body.data.resourceIds).toEqual([]);
    // ... one written straight to the table, as every pre-#437 link was.
    const legacy = await seedOffering(owner.tenantId, "Legacy");
    await getHandlerAdminSql()`
      INSERT INTO awcms_commerce_booking_offering_links
        (tenant_id, offering_id, product_id, quantity_basis)
      VALUES (${owner.tenantId}, ${legacy.offeringId}, ${legacy.productId}, 'nights')
    `;
    expect(
      await count(
        "awcms_commerce_booking_offering_link_resources",
        owner.tenantId
      )
    ).toBe(0);

    for (const item of await offerings()) {
      expect([...item.resourceIds].sort()).toEqual([first, second].sort());
    }
    expect(await offerings()).toHaveLength(2);

    for (const room of [viaRoute, legacy]) {
      const probe = await get(
        availabilityGet,
        availabilityPath(room.offeringId, second)
      );
      expect(probe.status).toBe(200);
      expect(probe.body.data).toMatchObject({ available: true });
    }
    expect((await book(viaRoute.offeringId, second)).status).toBe(201);
    expect((await book(legacy.offeringId, first)).status).toBe(201);
  });

  test("a bound link whose resources are all inactive is not sold, and never falls back to the whole pool", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await readyOwner();
    const standard = await seedBoundRoom(owner, "Standard");
    const deluxe = await seedBoundRoom(owner, "Deluxe");
    await getHandlerAdminSql()`
      UPDATE awcms_booking_resources SET status = 'inactive'
      WHERE tenant_id = ${owner.tenantId} AND id = ${standard.resourceId}
    `;

    const listed = await offerings();
    expect(listed.map((i) => i.offeringId)).toEqual([deluxe.offeringId]);
    expect(listed[0]!.resourceIds).toEqual([deluxe.resourceId]);

    // A bound resource soft-deleted in Booking drops out the same way.
    await getHandlerAdminSql()`
      UPDATE awcms_booking_resources SET deleted_at = now()
      WHERE tenant_id = ${owner.tenantId} AND id = ${deluxe.resourceId}
    `;
    expect(await offerings()).toEqual([]);
  });

  test("the link route proves the client's ids: unknown and foreign are one 404, wrong mode and inactive are 409, bad shapes are 400", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await readyOwner();
    const admin = getHandlerAdminSql();
    await admin`
      INSERT INTO awcms_tenants (id, tenant_code, tenant_name, status)
      VALUES (${TENANT_B}, 'b437', 'B 437', 'active')
    `;
    const foreign = await seedResource(TENANT_B);
    const slotMode = await seedResource(owner.tenantId, { mode: "slot" });
    const inactive = await seedResource(owner.tenantId, {
      status: "inactive"
    });
    const good = await seedResource(owner.tenantId);
    const base = await seedOffering(owner.tenantId, "Probe");
    const body = (resourceIds: unknown) => ({
      offeringId: base.offeringId,
      productId: base.productId,
      quantityBasis: "nights",
      resourceIds
    });

    const unknownId = await link(owner, body([UNKNOWN_ID]));
    const foreignId = await link(owner, body([foreign]));
    for (const response of [unknownId, foreignId]) {
      expect(response.status).toBe(404);
      expect(response.body.error?.code).toBe("RESOURCE_NOT_FOUND");
    }
    // One good id next to a bad one is still refused, and nothing is written.
    expect((await link(owner, body([good, foreign]))).status).toBe(404);

    const mode = await link(owner, body([slotMode]));
    expect(mode.status).toBe(409);
    expect(mode.body.error?.code).toBe("RESOURCE_MODE_MISMATCH");
    const off = await link(owner, body([inactive]));
    expect(off.status).toBe(409);
    expect(off.body.error?.code).toBe("RESOURCE_NOT_ACTIVE");

    const eleven = Array.from(
      { length: 11 },
      (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
    );
    for (const bad of [
      eleven,
      [good, good],
      ["not-a-uuid"],
      "not-an-array",
      [7]
    ]) {
      const response = await link(owner, body(bad));
      expect(response.status).toBe(400);
      expect(response.body.error?.code).toBe("VALIDATION_ERROR");
    }
    expect(
      await count("awcms_commerce_booking_offering_links", owner.tenantId)
    ).toBe(0);
    expect(
      await count(
        "awcms_commerce_booking_offering_link_resources",
        owner.tenantId
      )
    ).toBe(0);

    // The accepted request: both resources, in the order given; a replay writes nothing more.
    const second = await seedResource(owner.tenantId);
    const key = nextKey();
    const created = await link(owner, body([second, good]), key);
    expect(created.status).toBe(201);
    expect(created.body.data.resourceIds).toEqual([second, good]);
    const replay = await link(owner, body([second, good]), key);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(created.body.data.id);
    expect(replay.body.data.resourceIds).toEqual([second, good]);
    expect(
      await count(
        "awcms_commerce_booking_offering_link_resources",
        owner.tenantId
      )
    ).toBe(2);
    // The same key with other resources is a conflict, not a second binding.
    const conflict = await link(owner, body([good]), key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");

    // Shown by get and list, in order, and kept after an unlink.
    const one = await getOne(owner, created.body.data.id);
    expect(one.body.data.resourceIds).toEqual([second, good]);
    const all = await listAll(owner);
    expect(all.body.data.items.map((i) => i.resourceIds)).toEqual([
      [second, good]
    ]);
    const unlinked = await unlink(owner, created.body.data.id);
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.data.status).toBe("unlinked");
    expect(unlinked.body.data.resourceIds).toEqual([second, good]);
    expect(await offerings()).toEqual([]);
  });

  test("the database refuses what the route would: a binding to a foreign tenant's resource and an edit; the app role has no UPDATE or DELETE", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await readyOwner();
    const admin = getHandlerAdminSql();
    await admin`
      INSERT INTO awcms_tenants (id, tenant_code, tenant_name, status)
      VALUES (${TENANT_B}, 'b437', 'B 437', 'active')
    `;
    const foreign = await seedResource(TENANT_B);
    const room = await seedBoundRoom(owner, "Standard");
    const created = (await listAll(owner)).body.data.items[0]!;

    await assertRejected(
      Promise.resolve(admin`
        INSERT INTO awcms_commerce_booking_offering_link_resources
          (tenant_id, offering_link_id, resource_id)
        VALUES (${owner.tenantId}, ${created.id}, ${foreign})
      `),
      "a binding to another tenant's resource"
    );
    await assertRejected(
      Promise.resolve(admin`
        UPDATE awcms_commerce_booking_offering_link_resources
        SET sort_order = 5 WHERE tenant_id = ${owner.tenantId}
      `),
      "an edit of a binding"
    );
    // The application role can neither update nor delete a binding.
    const privileges = (await admin`
      SELECT has_table_privilege('awcms_app', 'awcms_commerce_booking_offering_link_resources', 'UPDATE') AS can_update,
             has_table_privilege('awcms_app', 'awcms_commerce_booking_offering_link_resources', 'DELETE') AS can_delete,
             has_table_privilege('awcms_app', 'awcms_commerce_booking_offering_link_resources', 'INSERT') AS can_insert
    `) as { can_update: boolean; can_delete: boolean; can_insert: boolean }[];
    expect(privileges[0]).toEqual({
      can_update: false,
      can_delete: false,
      can_insert: true
    });
    expect(
      (
        await get(
          availabilityGet,
          availabilityPath(room.offeringId, room.resourceId)
        )
      ).status
    ).toBe(200);
  });
});
