/**
 * The booking adapter's offering-link and deposit-policy routes through the REAL
 * route handlers (Issue #378, ADR-0045; access matrix section 9 evidence items
 * 1 and 2 for the keys this issue registers) - the HTTP half
 * `commerce-booking-adapter-schema.integration.test.ts` (tables, RLS, triggers)
 * cannot see: route wiring (`defineTenantRoute`, ABAC default-deny, the
 * `booking` feature toggle, `Idempotency-Key`, body validation, error -> status
 * mapping) and the read/write permission split.
 *
 * WORLD 2 (see `harness.ts`): handlers use `getDatabaseClient()`, so this file
 * runs against the migrated `DATABASE_URL` and seeds through
 * `getHandlerAdminSql()`. The owner comes from the real setup + login
 * endpoints; every other principal holds EXACTLY the keys under test.
 *
 * What this file proves:
 *   - every adapter route is `409 FEATURE_DISABLED` until the tenant opts in,
 *     and again once it opts back out;
 *   - read and write are separate powers: a reader cannot link, unlink or set a
 *     deposit policy (403, nothing written);
 *   - linking: a configured service-account user is required (G3), a service
 *     product only, a basis that agrees with the offering's granularity, an
 *     offering that is not `immediate` (G9), one active link per offering and per
 *     product; a body naming a price/amount/customer is 400; an unknown offering
 *     and another tenant's offering are the SAME 404; `Idempotency-Key` is
 *     required and a replay writes nothing; the response warns when no
 *     cancellation policy would apply (D6);
 *   - unlinking is the only transition; it is idempotent and audited;
 *   - the deposit policy: set, replace, no-op and remove (a retirement), the
 *     `allow_dp` mirror in the same write, the product form can no longer edit
 *     `allow_dp` by hand while `booking` is on (D5) and still can while it is off,
 *     and a body naming an amount is 400;
 *   - the service-account setting is validated against the tenant's active users.
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
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import {
  GET as listLinks,
  POST as createLink
} from "../../src/pages/api/v1/commerce/booking/offering-links/index";
import {
  GET as getLink,
  PATCH as patchLink
} from "../../src/pages/api/v1/commerce/booking/offering-links/[id]";
import {
  GET as getDeposit,
  PUT as putDeposit
} from "../../src/pages/api/v1/commerce/products/[id]/deposit-policy";
import { PATCH as patchProduct } from "../../src/pages/api/v1/commerce/products/[id]";
import {
  DELETE as resetStoreSettings,
  PUT as putStoreSettings
} from "../../src/pages/api/v1/commerce/store-settings/index";

const OWNER_PASSWORD = "integration-test-owner-password";
const OTHER_TENANT = "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b";
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

type LinkBody = {
  id: string;
  offeringId: string;
  productId: string;
  quantityBasis: string;
  status: string;
  unlinkedAt: string | null;
  warnings?: string[];
};

let keySeq = 0;
const nextKey = () => `bk378-${Date.now()}-${(keySeq += 1)}`;

const link = (who: Principal, body: unknown, key: string | null = nextKey()) =>
  invoke<Envelope<LinkBody>>(createLink, {
    method: "POST",
    path: "/api/v1/commerce/booking/offering-links",
    headers: headers(who, key === null ? {} : { "idempotency-key": key }),
    body
  });

const list = (who: Principal, query = "") =>
  invoke<Envelope<{ items: LinkBody[]; nextCursor: string | null }>>(
    listLinks,
    {
      path: `/api/v1/commerce/booking/offering-links${query}`,
      headers: headers(who)
    }
  );

const get = (who: Principal, id: string) =>
  invoke<Envelope<LinkBody>>(getLink, {
    path: `/api/v1/commerce/booking/offering-links/${id}`,
    headers: headers(who),
    params: { id }
  });

const unlink = (who: Principal, id: string, key: string | null = nextKey()) =>
  invoke<Envelope<LinkBody>>(patchLink, {
    method: "PATCH",
    path: `/api/v1/commerce/booking/offering-links/${id}`,
    headers: headers(who, key === null ? {} : { "idempotency-key": key }),
    params: { id },
    body: { status: "unlinked" }
  });

type DepositBody = {
  productId: string;
  policy: {
    kind: string;
    percent: string | null;
    fixedAmount: string | null;
  } | null;
  allowDp: boolean;
};

const getPolicy = (who: Principal, id: string) =>
  invoke<Envelope<DepositBody>>(getDeposit, {
    path: `/api/v1/commerce/products/${id}/deposit-policy`,
    headers: headers(who),
    params: { id }
  });

const putPolicy = (who: Principal, id: string, body: unknown) =>
  invoke<Envelope<DepositBody>>(putDeposit, {
    method: "PUT",
    path: `/api/v1/commerce/products/${id}/deposit-policy`,
    headers: headers(who),
    params: { id },
    body
  });

const patchAllowDp = (who: Principal, id: string, allowDp: boolean) =>
  invoke<Envelope>(patchProduct, {
    method: "PATCH",
    path: `/api/v1/commerce/products/${id}`,
    headers: headers(who),
    params: { id },
    body: { allowDp }
  });

const STORE_BASE = {
  storeName: "Toko Booking",
  shipping: { selfPickup: true },
  payment: { manualQris: { active: true, mediaObjectId: null } }
};

const putSettings = (who: Principal, extra: Record<string, unknown>) =>
  invoke<Envelope<{ bookingServiceTenantUserId: string | null }>>(
    putStoreSettings,
    {
      method: "PUT",
      path: "/api/v1/commerce/store-settings",
      headers: headers(who),
      body: { ...STORE_BASE, ...extra }
    }
  );

type Fixture = {
  svc: string;
  svc2: string;
  physical: string;
  stay: string;
  stay2: string;
  slot: string;
  immediate: string;
};

async function seedProduct(
  tenantId: string,
  sku: string,
  type: string
): Promise<string> {
  const rows = (await getHandlerAdminSql()`
    INSERT INTO awcms_commerce_products
      (tenant_id, type, sku, name, slug, price, stock, status)
    VALUES (${tenantId}, ${type}, ${sku}, ${sku}, ${sku.toLowerCase()}, '500000.00', 100, 'active')
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function seedOffering(
  tenantId: string,
  code: string,
  kind: "stay" | "time",
  confirmationMode = "hold_then_confirm"
): Promise<string> {
  const admin = getHandlerAdminSql();
  const rows =
    kind === "stay"
      ? ((await admin`
          INSERT INTO awcms_booking_service_offerings
            (tenant_id, code, name, granularity, min_nights, max_nights, confirmation_mode)
          VALUES (${tenantId}, ${code}, ${code}, 'stay', 1, 30, ${confirmationMode})
          RETURNING id
        `) as { id: string }[])
      : ((await admin`
          INSERT INTO awcms_booking_service_offerings
            (tenant_id, code, name, granularity, duration_seconds, setup_seconds,
             cleanup_seconds, slot_step_seconds, confirmation_mode)
          VALUES (${tenantId}, ${code}, ${code}, 'time', 3600, 0, 0, 900, ${confirmationMode})
          RETURNING id
        `) as { id: string }[]);
  return rows[0]!.id;
}

async function seedFixture(tenantId: string): Promise<Fixture> {
  return {
    svc: await seedProduct(tenantId, "SVC-1", "service"),
    svc2: await seedProduct(tenantId, "SVC-2", "service"),
    physical: await seedProduct(tenantId, "PHY-1", "physical"),
    stay: await seedOffering(tenantId, "stay-1", "stay"),
    stay2: await seedOffering(tenantId, "stay-2", "stay"),
    slot: await seedOffering(tenantId, "slot-1", "time"),
    immediate: await seedOffering(tenantId, "stay-imm", "stay", "immediate")
  };
}

async function auditActions(
  tenantId: string,
  resourceType: string
): Promise<string[]> {
  const rows = (await getHandlerAdminSql()`
    SELECT action FROM awcms_audit_events
    WHERE tenant_id = ${tenantId} AND resource_type = ${resourceType}
    ORDER BY created_at
  `) as { action: string }[];
  return rows.map((r) => r.action);
}

async function linkCount(tenantId: string): Promise<number> {
  const rows = (await getHandlerAdminSql()`
    SELECT count(*)::int AS n FROM awcms_commerce_booking_offering_links
    WHERE tenant_id = ${tenantId}
  `) as { n: number }[];
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

/** An owner with the feature ON, a configured service-account user and a fixture. */
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
  return { owner, fx: await seedFixture(owner.tenantId) };
}

suite(
  "booking adapter offering-link and deposit-policy routes (Issue #378)",
  () => {
    beforeAll(async () => {
      handlerReady = await ensureHandlerDatabaseReady();
    });
    afterAll(async () => {
      await teardownHandlerDatabase();
    });
    beforeEach(async () => {
      resetRateLimitForTests();
      if (!handlerReady) return;
      await resetHandlerDatabase();
    });

    test("every route is 409 FEATURE_DISABLED until the tenant opts in, and again after it opts out", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      const fx = await seedFixture(owner.tenantId);

      const everyRoute = async () => [
        await list(owner),
        await link(owner, {
          offeringId: fx.stay,
          productId: fx.svc,
          quantityBasis: "nights"
        }),
        await get(owner, UNKNOWN_ID),
        await unlink(owner, UNKNOWN_ID),
        await getPolicy(owner, fx.svc),
        await putPolicy(owner, fx.svc, { kind: "percent", percent: "30" })
      ];
      for (const response of await everyRoute()) {
        expect(response.status).toBe(409);
        expect(response.body.error?.code).toBe("FEATURE_DISABLED");
      }
      expect(await linkCount(owner.tenantId)).toBe(0);

      expect((await setBookingFeature(owner, true)).status).toBe(200);
      expect((await list(owner)).status).toBe(200);
      expect((await getPolicy(owner, fx.svc)).status).toBe(200);

      expect((await setBookingFeature(owner, false)).status).toBe(200);
      for (const response of await everyRoute()) {
        expect(response.status).toBe(409);
      }
    });

    test("read and write are separate powers: a reader cannot link, unlink or set a policy, and nothing is written", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const made = await link(owner, {
        offeringId: fx.stay,
        productId: fx.svc,
        quantityBasis: "nights"
      });
      expect(made.status).toBe(201);

      const reader = await seedPrincipal(owner.tenantId, "reader", [
        "commerce.booking_offering_links.read",
        "commerce.booking_deposit_policies.read"
      ]);
      const nobody = await seedPrincipal(owner.tenantId, "nobody", []);

      expect((await list(reader)).status).toBe(200);
      expect((await get(reader, made.body.data.id)).status).toBe(200);
      expect((await getPolicy(reader, fx.svc)).status).toBe(200);

      const denied = [
        await link(reader, {
          offeringId: fx.stay2,
          productId: fx.svc2,
          quantityBasis: "nights"
        }),
        await unlink(reader, made.body.data.id),
        await putPolicy(reader, fx.svc, { kind: "percent", percent: "30" }),
        await list(nobody),
        await get(nobody, made.body.data.id),
        await getPolicy(nobody, fx.svc)
      ];
      for (const response of denied) expect(response.status).toBe(403);

      const writer = await seedPrincipal(owner.tenantId, "writer", [
        "commerce.booking_offering_links.create"
      ]);
      // Create does not imply read or update.
      expect(
        (
          await link(writer, {
            offeringId: fx.stay2,
            productId: fx.svc2,
            quantityBasis: "nights"
          })
        ).status
      ).toBe(201);
      expect((await list(writer)).status).toBe(403);
      expect((await unlink(writer, made.body.data.id)).status).toBe(403);

      expect(await linkCount(owner.tenantId)).toBe(2);
      expect((await getPolicy(owner, fx.svc)).body.data.policy).toBeNull();
    });

    test("linking needs the service-account user (G3), a service product, a matching basis, a payable offering (G9), and one link per side (D1)", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      expect((await setBookingFeature(owner, true)).status).toBe(200);
      const fx = await seedFixture(owner.tenantId);
      const body = {
        offeringId: fx.stay,
        productId: fx.svc,
        quantityBasis: "nights"
      };

      // G3: no service-account user yet.
      const unconfigured = await link(owner, body);
      expect(unconfigured.status).toBe(409);
      expect(unconfigured.body.error?.code).toBe(
        "BOOKING_SERVICE_ACTOR_NOT_CONFIGURED"
      );
      expect(await linkCount(owner.tenantId)).toBe(0);

      expect(
        (
          await putSettings(owner, {
            bookingServiceTenantUserId: owner.tenantUserId
          })
        ).status
      ).toBe(200);

      const refusals: [unknown, number, string][] = [
        [{ ...body, productId: fx.physical }, 409, "PRODUCT_NOT_SERVICE"],
        [{ ...body, quantityBasis: "booking" }, 409, "QUANTITY_BASIS_MISMATCH"],
        [
          { offeringId: fx.slot, productId: fx.svc, quantityBasis: "nights" },
          409,
          "QUANTITY_BASIS_MISMATCH"
        ],
        [{ ...body, offeringId: fx.immediate }, 409, "OFFERING_NOT_LINKABLE"],
        [{ ...body, offeringId: UNKNOWN_ID }, 404, "RESOURCE_NOT_FOUND"],
        [{ ...body, productId: UNKNOWN_ID }, 404, "RESOURCE_NOT_FOUND"]
      ];
      for (const [payload, status, code] of refusals) {
        const response = await link(owner, payload);
        expect(response.status, code).toBe(status);
        expect(response.body.error?.code).toBe(code);
      }
      expect(await linkCount(owner.tenantId)).toBe(0);

      const ok = await link(owner, body);
      expect(ok.status).toBe(201);
      expect(ok.body.data).toMatchObject({
        offeringId: fx.stay,
        productId: fx.svc,
        quantityBasis: "nights",
        status: "active",
        unlinkedAt: null
      });
      // D6: no cancellation policy is active, so the link warns (non-blocking).
      expect(ok.body.data.warnings).toEqual(["NO_CANCELLATION_POLICY"]);

      // D1: one active link per offering and per product.
      const sameOffering = await link(owner, { ...body, productId: fx.svc2 });
      expect(sameOffering.status).toBe(409);
      expect(sameOffering.body.error?.code).toBe("OFFERING_ALREADY_LINKED");
      const sameProduct = await link(owner, { ...body, offeringId: fx.stay2 });
      expect(sameProduct.status).toBe(409);
      expect(sameProduct.body.error?.code).toBe("PRODUCT_ALREADY_LINKED");
      expect(await linkCount(owner.tenantId)).toBe(1);

      // A cancellation policy silences the warning.
      await getHandlerAdminSql()`
      INSERT INTO awcms_commerce_cancellation_policies
        (tenant_id, product_id, version, status, activated_at)
      VALUES (${owner.tenantId}, NULL, 1, 'draft', NULL)
    `;
      await getHandlerAdminSql()`
      UPDATE awcms_commerce_cancellation_policies
      SET status = 'active', activated_at = now() WHERE tenant_id = ${owner.tenantId}
    `;
      const silent = await link(owner, {
        offeringId: fx.stay2,
        productId: fx.svc2,
        quantityBasis: "nights"
      });
      expect(silent.status).toBe(201);
      expect(silent.body.data.warnings).toEqual([]);
    });

    test("validation: Idempotency-Key is required, a body naming a price, amount or customer is 400, and nothing is written", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const body = {
        offeringId: fx.stay,
        productId: fx.svc,
        quantityBasis: "nights"
      };

      const noKey = await link(owner, body, null);
      expect(noKey.status).toBe(400);
      expect(noKey.body.error?.code).toBe("IDEMPOTENCY_REQUIRED");

      for (const forbidden of ["price", "amount", "customerId", "tenantId"]) {
        const response = await link(owner, { ...body, [forbidden]: "1.00" });
        expect(response.status, forbidden).toBe(400);
        expect(response.body.error?.code).toBe("VALIDATION_ERROR");
        const fields = (
          response.body.error?.details as { field: string }[]
        ).map((d) => d.field);
        expect(fields).toContain(forbidden);
      }
      expect(
        (await link(owner, { ...body, quantityBasis: "weeks" })).status
      ).toBe(400);
      expect((await link(owner, { ...body, offeringId: "nope" })).status).toBe(
        400
      );
      expect((await link(owner, {})).status).toBe(400);
      expect(await linkCount(owner.tenantId)).toBe(0);

      // PATCH accepts one transition only.
      const made = await link(owner, body);
      const bad = await invoke<Envelope>(patchLink, {
        method: "PATCH",
        path: `/api/v1/commerce/booking/offering-links/${made.body.data.id}`,
        headers: headers(owner, { "idempotency-key": nextKey() }),
        params: { id: made.body.data.id },
        body: { status: "active" }
      });
      expect(bad.status).toBe(400);
      expect((await unlink(owner, made.body.data.id, null)).status).toBe(400);
    });

    test("an idempotent replay returns the same link and writes nothing; the same key with another request is a conflict; keys are per actor", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const body = {
        offeringId: fx.stay,
        productId: fx.svc,
        quantityBasis: "nights"
      };
      const key = nextKey();
      const first = await link(owner, body, key);
      expect(first.status).toBe(201);
      const replay = await link(owner, body, key);
      expect(replay.status).toBe(201);
      expect(replay.body.data.id).toBe(first.body.data.id);
      expect(await linkCount(owner.tenantId)).toBe(1);
      expect(
        await auditActions(owner.tenantId, "commerce_booking_offering_link")
      ).toEqual(["commerce.booking_offering_link.created"]);

      const conflict = await link(
        owner,
        { ...body, offeringId: fx.stay2, productId: fx.svc2 },
        key
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");

      // A colleague reusing the key is a different actor: it neither replays the
      // owner's response nor collides with it (awcms ADR-0145).
      const colleague = await seedPrincipal(owner.tenantId, "colleague", [
        "commerce.booking_offering_links.create"
      ]);
      const other = await link(
        colleague,
        { offeringId: fx.stay2, productId: fx.svc2, quantityBasis: "nights" },
        key
      );
      expect(other.status).toBe(201);
      expect(other.body.data.id).not.toBe(first.body.data.id);
    });

    test("list, get and unlink: newest first, filtered by status, an unlink is the only transition, idempotent and audited; another tenant's link is the same 404", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const one = await link(owner, {
        offeringId: fx.stay,
        productId: fx.svc,
        quantityBasis: "nights"
      });
      const two = await link(owner, {
        offeringId: fx.slot,
        productId: fx.svc2,
        quantityBasis: "booking"
      });
      expect(one.status).toBe(201);
      expect(two.status).toBe(201);

      const all = await list(owner);
      expect(all.body.data.items.map((i) => i.id)).toEqual([
        two.body.data.id,
        one.body.data.id
      ]);
      expect((await list(owner, "?status=bogus")).status).toBe(400);
      expect((await list(owner, "?cursor=%25%25")).status).toBe(400);

      const gone = await unlink(owner, one.body.data.id);
      expect(gone.status).toBe(200);
      expect(gone.body.data.status).toBe("unlinked");
      expect(gone.body.data.unlinkedAt).not.toBeNull();
      // Another key on an already unlinked link: the stored row, no second audit.
      const again = await unlink(owner, one.body.data.id);
      expect(again.status).toBe(200);
      expect(again.body.data.status).toBe("unlinked");
      expect(
        await auditActions(owner.tenantId, "commerce_booking_offering_link")
      ).toEqual([
        "commerce.booking_offering_link.created",
        "commerce.booking_offering_link.created",
        "commerce.booking_offering_link.unlinked"
      ]);

      expect(
        (await list(owner, "?status=active")).body.data.items.map((i) => i.id)
      ).toEqual([two.body.data.id]);
      expect(
        (await list(owner, "?status=unlinked")).body.data.items.map((i) => i.id)
      ).toEqual([one.body.data.id]);

      // The slot is free again for a new link of the same pair.
      expect(
        (
          await link(owner, {
            offeringId: fx.stay,
            productId: fx.svc,
            quantityBasis: "nights"
          })
        ).status
      ).toBe(201);

      // Another tenant's link: the same 404 as an unknown id, on read and on unlink.
      const admin = getHandlerAdminSql();
      await admin`
      INSERT INTO awcms_tenants
        (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${OTHER_TENANT}, 'other', 'Other', 'Other Legal', 'active', 'en', 'light')
    `;
      const otherProduct = await seedProduct(OTHER_TENANT, "SVC-O", "service");
      const otherOffering = await seedOffering(OTHER_TENANT, "stay-o", "stay");
      const foreign = (await admin`
      INSERT INTO awcms_commerce_booking_offering_links
        (tenant_id, offering_id, product_id, quantity_basis)
      VALUES (${OTHER_TENANT}, ${otherOffering}, ${otherProduct}, 'nights')
      RETURNING id
    `) as { id: string }[];
      const unknownGet = await get(owner, UNKNOWN_ID);
      const foreignGet = await get(owner, foreign[0]!.id);
      expect(unknownGet.status).toBe(404);
      expect(foreignGet.status).toBe(404);
      expect(foreignGet.body).toEqual(unknownGet.body);
      expect((await unlink(owner, foreign[0]!.id)).status).toBe(404);
      // ...and the foreign offering and product cannot be linked either.
      const crossLink = await link(owner, {
        offeringId: otherOffering,
        productId: otherProduct,
        quantityBasis: "nights"
      });
      expect(crossLink.status).toBe(404);
      const stillActive = (await admin`
      SELECT status FROM awcms_commerce_booking_offering_links WHERE id = ${foreign[0]!.id}
    `) as { status: string }[];
      expect(stillActive[0]!.status).toBe("active");
      expect((await get(owner, "not-a-uuid")).status).toBe(404);
    });

    test("deposit policy: set, replace, no-op, remove; allow_dp follows in the same write; the audit records changes only", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();

      const none = await getPolicy(owner, fx.svc);
      expect(none.body.data).toEqual({
        productId: fx.svc,
        policy: null,
        allowDp: false
      });

      const percent = await putPolicy(owner, fx.svc, {
        kind: "percent",
        percent: "30"
      });
      expect(percent.status).toBe(200);
      expect(percent.body.data.policy).toMatchObject({
        kind: "percent",
        percent: "30.00",
        fixedAmount: null
      });
      expect(percent.body.data.allowDp).toBe(true);

      // The same policy again changes nothing.
      expect(
        (await putPolicy(owner, fx.svc, { kind: "percent", percent: "30.00" }))
          .status
      ).toBe(200);

      const fixed = await putPolicy(owner, fx.svc, {
        kind: "fixed",
        fixedAmount: "150000"
      });
      expect(fixed.status).toBe(200);
      expect(fixed.body.data.policy).toMatchObject({
        kind: "fixed",
        percent: null,
        fixedAmount: "150000.00"
      });
      expect(fixed.body.data.allowDp).toBe(true);

      const removed = await putPolicy(owner, fx.svc, { kind: "full" });
      expect(removed.status).toBe(200);
      expect(removed.body.data).toEqual({
        productId: fx.svc,
        policy: null,
        allowDp: false
      });
      // Removing nothing is a no-op.
      expect((await putPolicy(owner, fx.svc, { kind: "full" })).status).toBe(
        200
      );

      const rows = (await getHandlerAdminSql()`
      SELECT kind, retired_at IS NOT NULL AS retired
      FROM awcms_commerce_product_deposit_policies
      WHERE tenant_id = ${owner.tenantId} ORDER BY created_at
    `) as { kind: string; retired: boolean }[];
      // One row, edited in place from percent to fixed, then retired - never deleted.
      expect(rows).toEqual([{ kind: "fixed", retired: true }]);

      // A new policy after a retirement is a new row.
      expect(
        (await putPolicy(owner, fx.svc, { kind: "percent", percent: "50" }))
          .status
      ).toBe(200);
      expect(
        (
          (await getHandlerAdminSql()`
          SELECT count(*)::int AS n FROM awcms_commerce_product_deposit_policies
          WHERE tenant_id = ${owner.tenantId}
        `) as { n: number }[]
        )[0]!.n
      ).toBe(2);

      expect(
        await auditActions(owner.tenantId, "commerce_product_deposit_policy")
      ).toEqual([
        "commerce.product_deposit_policy.set",
        "commerce.product_deposit_policy.set",
        "commerce.product_deposit_policy.removed",
        "commerce.product_deposit_policy.set"
      ]);
    });

    test("deposit policy validation: percent in (0, 100], a positive money string, an unknown kind and a named amount are 400; an unknown product is 404", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const bad: unknown[] = [
        {},
        { kind: "weekly" },
        { kind: "percent" },
        { kind: "percent", percent: "0" },
        { kind: "percent", percent: "100.5" },
        { kind: "percent", percent: "12.345" },
        { kind: "percent", percent: "30", fixedAmount: "1.00" },
        { kind: "fixed" },
        { kind: "fixed", fixedAmount: 150000 },
        { kind: "fixed", fixedAmount: "0.00" },
        { kind: "fixed", fixedAmount: "10.00", amount: "10.00" },
        { kind: "percent", percent: "30", price: "1.00" },
        { kind: "full", percent: "30" }
      ];
      for (const body of bad) {
        const response = await putPolicy(owner, fx.svc, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(response.body.error?.code).toBe("VALIDATION_ERROR");
      }
      expect((await getPolicy(owner, fx.svc)).body.data.policy).toBeNull();
      expect(
        (await putPolicy(owner, UNKNOWN_ID, { kind: "percent", percent: "30" }))
          .status
      ).toBe(404);
      expect((await getPolicy(owner, UNKNOWN_ID)).status).toBe(404);
      expect(
        (await putPolicy(owner, "not-a-uuid", { kind: "full" })).status
      ).toBe(404);
    });

    test("allow_dp is not editable by hand while booking is on (D5) and still is while it is off", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      const fx = await seedFixture(owner.tenantId);

      // Feature OFF (the default): exactly today's behaviour.
      expect((await patchAllowDp(owner, fx.svc, true)).status).toBe(200);
      expect((await patchAllowDp(owner, fx.svc, false)).status).toBe(200);

      expect((await setBookingFeature(owner, true)).status).toBe(200);
      const refused = await patchAllowDp(owner, fx.svc, true);
      expect(refused.status).toBe(409);
      expect(refused.body.error?.code).toBe("ALLOW_DP_MANAGED_BY_POLICY");
      // Writing the value it already has is not a change.
      expect((await patchAllowDp(owner, fx.svc, false)).status).toBe(200);

      // The policy write sets the flag; the product form then agrees with it.
      expect(
        (await putPolicy(owner, fx.svc, { kind: "percent", percent: "30" }))
          .status
      ).toBe(200);
      expect((await patchAllowDp(owner, fx.svc, true)).status).toBe(200);
      expect((await patchAllowDp(owner, fx.svc, false)).status).toBe(409);
      expect((await getPolicy(owner, fx.svc)).body.data.allowDp).toBe(true);
    });

    test("the service-account setting must name an ACTIVE user of the tenant; absent leaves it alone; null clears it", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      const admin = getHandlerAdminSql();

      // Another tenant's user, an unknown id and a non-uuid are refused; nothing is written.
      await admin`
      INSERT INTO awcms_tenants
        (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${OTHER_TENANT}, 'other', 'Other', 'Other Legal', 'active', 'en', 'light')
    `;
      const foreignProfile = (await admin`
      INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
      VALUES (${OTHER_TENANT}, 'person', 'Foreign')
      RETURNING id
    `) as { id: string }[];
      const foreignIdentity = (await admin`
      INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${OTHER_TENANT}, ${foreignProfile[0]!.id}, 'foreign@example.test', 'x')
      RETURNING id
    `) as { id: string }[];
      const foreignUser = (await admin`
      INSERT INTO awcms_tenant_users (tenant_id, identity_id)
      VALUES (${OTHER_TENANT}, ${foreignIdentity[0]!.id})
      RETURNING id
    `) as { id: string }[];
      for (const bad of [foreignUser[0]!.id, UNKNOWN_ID, "not-a-uuid", 12]) {
        const response = await putSettings(owner, {
          bookingServiceTenantUserId: bad
        });
        expect(response.status, String(bad)).toBe(400);
      }
      const stored = async () =>
        (
          (await admin`
          SELECT booking_service_tenant_user_id AS id FROM awcms_commerce_store_settings
          WHERE tenant_id = ${owner.tenantId}
        `) as { id: string | null }[]
        )[0]?.id ?? null;
      expect(await stored()).toBeNull();

      const set = await putSettings(owner, {
        bookingServiceTenantUserId: owner.tenantUserId
      });
      expect(set.status).toBe(200);
      expect(set.body.data.bookingServiceTenantUserId).toBe(owner.tenantUserId);
      expect(await stored()).toBe(owner.tenantUserId);

      // The other column that lives beside the blob is accepted in the same body
      // (the blob validator rejects any key it does not own, so both are taken out).
      const withRate = await putSettings(owner, {
        affiliateCommissionRate: "5.00",
        bookingServiceTenantUserId: owner.tenantUserId
      });
      expect(withRate.status).toBe(200);

      // A full-replace PUT from a screen that does not carry the field leaves it alone.
      const absent = await putSettings(owner, {});
      expect(absent.status).toBe(200);
      expect(absent.body.data.bookingServiceTenantUserId).toBe(
        owner.tenantUserId
      );

      // A deactivated user is no longer a usable actor (the adapter refuses to link).
      expect((await setBookingFeature(owner, true)).status).toBe(200);
      const fx = await seedFixture(owner.tenantId);
      await admin`UPDATE awcms_tenant_users SET status = 'inactive' WHERE id = ${owner.tenantUserId}`;
      const inactive = await link(
        await seedPrincipal(owner.tenantId, "linker", [
          "commerce.booking_offering_links.create"
        ]),
        { offeringId: fx.stay, productId: fx.svc, quantityBasis: "nights" }
      );
      expect(inactive.status).toBe(409);
      expect(inactive.body.error?.code).toBe(
        "BOOKING_SERVICE_ACTOR_NOT_CONFIGURED"
      );
      await admin`UPDATE awcms_tenant_users SET status = 'active' WHERE id = ${owner.tenantUserId}`;

      // A "reset to defaults" must not drop it: the row is kept (not stamped for
      // the retention engine) while the service-account user is set.
      const reset = await invoke<Envelope>(resetStoreSettings, {
        method: "DELETE",
        path: "/api/v1/commerce/store-settings",
        headers: headers(owner)
      });
      expect(reset.status).toBe(200);
      const afterReset = (await admin`
      SELECT booking_service_tenant_user_id AS id, deleted_at IS NULL AS live
      FROM awcms_commerce_store_settings WHERE tenant_id = ${owner.tenantId}
    `) as { id: string | null; live: boolean }[];
      expect(afterReset[0]).toEqual({ id: owner.tenantUserId, live: true });

      // null clears it.
      const cleared = await putSettings(owner, {
        bookingServiceTenantUserId: null
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.bookingServiceTenantUserId).toBeNull();
      expect(await stored()).toBeNull();

      // Each real change of the service account was audited (set, then clear);
      // re-saving the same value wrote nothing.
      expect(
        (await auditActions(owner.tenantId, "store_settings")).filter(
          (a) => a === "commerce.booking_service_account.changed"
        )
      ).toHaveLength(2);
    });
  }
);
