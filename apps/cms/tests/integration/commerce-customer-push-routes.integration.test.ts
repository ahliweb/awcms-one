/**
 * The customer Web Push HTTP surface through the REAL route handlers (Issue #430,
 * ADR-0048 sections 4 to 6). World 2 of `harness.ts`: handlers use
 * `getDatabaseClient()`; a storefront request names its tenant through the
 * `Origin` header and `awcms_tenant_domains`, exactly as a browser's does.
 * (World 2 runs as the connection's own role, so cross-tenant RLS itself is
 * proved in `commerce-customer-push.integration.test.ts`; here the application
 * predicates and the resolver carry the isolation.)
 *
 * Regression handles of the ADR's section 8:
 *
 *   TS-H1  a matrix of credentials (none, malformed, staff token, other-tenant
 *          token, revoked, blocked) over the routes
 *   TS-H2  the `cs_` token on a staff push route is a 401 (and the reverse)
 *   TS-H3  preflight and ACAO for tenant origins only, no credentials header,
 *          `Vary`, `no-store`
 *   TS-H4  a sentinel endpoint, key and secret never appear in a response, a
 *          log line or an audit row
 *   TS-H5  rate limits and `Retry-After`
 *   TS-H6  feature off, unresolvable tenant, foreign and absent device are
 *          indistinguishable
 *
 * Plus: the abuse case (a non-allowlisted endpoint is refused and nothing is
 * written), the flag-off path, idempotent subscribe, and logout revoking devices.
 */
import { generateKeyPairSync } from "node:crypto";

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
import { CUSTOMER_PUSH_CONSENT_TEXT_VERSION } from "../../src/modules/commerce/domain/customer-push";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import { GET as diagnosticsGet } from "../../src/pages/api/v1/commerce/customer-push/diagnostics";
import { POST as logoutPost } from "../../src/pages/api/v1/commerce/storefront/account/logout";
import {
  DELETE as subscriptionsDeleteAll,
  GET as subscriptionsGet,
  OPTIONS as subscriptionsOptions,
  POST as subscriptionsPost
} from "../../src/pages/api/v1/commerce/storefront/account/push/subscriptions/index";
import { DELETE as subscriptionDelete } from "../../src/pages/api/v1/commerce/storefront/account/push/subscriptions/[id]";
import {
  GET as preferencesGet,
  PUT as preferencesPut
} from "../../src/pages/api/v1/commerce/storefront/account/push/preferences";
import { GET as staffSubscriptionsGet } from "../../src/pages/api/v1/push/subscriptions/index";

const OWNER_PASSWORD = "integration-test-owner-password";
const HOST_A = "shop-a.example.test";
const HOST_B = "shop-b.example.test";
const CMS_HOST = "cms.example.test";
const ORIGIN_A = `https://${HOST_A}`;
const ORIGIN_B = `https://${HOST_B}`;
const CMS_ORIGIN = `https://${CMS_HOST}`;
const TENANT_B = "43000000-0430-4000-8000-00000000000b";
const BASE = "/api/v1/commerce/storefront/account/push";
const VERSION = CUSTOMER_PUSH_CONSENT_TEXT_VERSION;

const SENTINEL_TOKEN = "SENTINELPUSHTOKEN0430";
const SENTINEL_AUTH = Buffer.alloc(16, 0x5a).toString("base64url");
const P256DH = Buffer.concat([
  Buffer.from([4]),
  Buffer.alloc(64, 0x33)
]).toString("base64url");

type Envelope<T = unknown> = {
  success: boolean;
  data: T;
  error?: { code: string; message?: string; details?: unknown };
};

type Principal = { tenantId: string; token: string; tenantUserId: string };

// ---------------------------------------------------------------------------
// Environment: a VAPID pair, the key ring, push on (restored afterwards)
// ---------------------------------------------------------------------------

function makeVapid(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256"
  });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.concat([
      Buffer.from([4]),
      Buffer.from(pub.x!, "base64url"),
      Buffer.from(pub.y!, "base64url")
    ]).toString("base64url"),
    privateKey: priv.d!
  };
}

const VAPID = makeVapid();
const RING = `k1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`;

const PUSH_ENV: Record<string, string> = {
  PUSH_ENABLED: "true",
  PUSH_PROVIDER: "web_push",
  PUSH_VAPID_PUBLIC_KEY: VAPID.publicKey,
  PUSH_VAPID_PRIVATE_KEY: VAPID.privateKey,
  PUSH_VAPID_SUBJECT: "mailto:ops@example.test",
  PUSH_AUTH_SECRET_ENCRYPTION_KEYS: RING,
  APP_URL: CMS_ORIGIN
};

const savedEnv = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function setCustomerPushFeature(who: Principal, customerPush: boolean) {
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
        customerPush
      }
    }
  });
}

async function mapHost(tenantId: string, host: string) {
  await getHandlerAdminSql()`
    INSERT INTO awcms_tenant_domains
      (tenant_id, hostname, normalized_hostname, status, verified_at)
    VALUES (${tenantId}, ${host}, ${host}, 'active', now())
  `;
}

async function seedTenantB(customerPush: boolean) {
  const admin = getHandlerAdminSql();
  await admin`
    INSERT INTO awcms_tenants (id, tenant_code, tenant_name, status)
    VALUES (${TENANT_B}, 'shop-b', 'Shop B', 'active')
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
    VALUES (${TENANT_B}, 'commerce',
            ${{ features: { customerPush } }}::jsonb)
  `;
  await mapHost(TENANT_B, HOST_B);
}

type Shopper = { token: string; accountId: string; customerId: string };
let shopperSeq = 0;

async function seedShopper(
  tenantId: string,
  options: { blocked?: boolean; verified?: boolean } = {}
): Promise<Shopper> {
  shopperSeq += 1;
  const admin = getHandlerAdminSql();
  const customer = (await admin`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
    VALUES (${tenantId}, ${`Shopper ${shopperSeq}`}, ${`+62813000${String(shopperSeq).padStart(5, "0")}`})
    RETURNING id
  `) as { id: string }[];
  const account = (await admin`
    INSERT INTO awcms_commerce_customer_accounts
      (tenant_id, customer_id, email_normalized, status, email_verified_at, history_from)
    VALUES (${tenantId}, ${customer[0]!.id}, ${`routes${shopperSeq}@example.test`},
            ${options.blocked ? "blocked" : "active"},
            ${options.verified === false ? null : new Date()},
            now() - interval '1 day')
    RETURNING id
  `) as { id: string }[];
  const token = generateCustomerSessionToken();
  await admin`
    INSERT INTO awcms_commerce_customer_sessions
      (tenant_id, account_id, token_hash, expires_at)
    VALUES (${tenantId}, ${account[0]!.id}, ${hashCustomerSessionToken(token)},
            ${new Date(Date.now() + 86_400_000)})
  `;
  return { token, accountId: account[0]!.id, customerId: customer[0]!.id };
}

let endpointSeq = 0;
function newEndpoint(): string {
  endpointSeq += 1;
  return `https://fcm.googleapis.com/fcm/send/r${endpointSeq}:${SENTINEL_TOKEN}${endpointSeq}`;
}

function subscriptionBody(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: newEndpoint(),
    keys: { p256dh: P256DH, auth: SENTINEL_AUTH },
    expirationTime: null,
    consent: { purposes: ["order_updates"], textVersion: VERSION },
    ...overrides
  };
}

function headersFor(who: { token: string } | null, origin: string | null) {
  return {
    "content-type": "application/json",
    ...(origin ? { origin } : {}),
    ...(who ? { authorization: `Bearer ${who.token}` } : {})
  } as Record<string, string>;
}

const subscribe = (
  who: { token: string } | null,
  body: unknown,
  origin: string | null = ORIGIN_A,
  extraHeaders: Record<string, string> = {}
) =>
  invoke<Envelope<{ device: Record<string, unknown>; preferences: unknown[] }>>(
    subscriptionsPost,
    {
      method: "POST",
      path: `${BASE}/subscriptions`,
      headers: { ...headersFor(who, origin), ...extraHeaders },
      body
    }
  );

const state = (
  who: { token: string } | null,
  origin: string | null = ORIGIN_A
) =>
  invoke<
    Envelope<{
      capability: Record<string, unknown>;
      preferences: { purpose: string; enabled: boolean }[];
      devices: { id: string; current: boolean }[];
    }>
  >(subscriptionsGet, {
    path: `${BASE}/subscriptions`,
    headers: headersFor(who, origin)
  });

const revokeOne = (
  who: { token: string } | null,
  id: string,
  origin: string | null = ORIGIN_A
) =>
  invoke<Envelope>(subscriptionDelete, {
    method: "DELETE",
    path: `${BASE}/subscriptions/${id}`,
    headers: headersFor(who, origin),
    params: { id }
  });

const revokeAll = (
  who: { token: string } | null,
  origin: string | null = ORIGIN_A
) =>
  invoke<Envelope>(subscriptionsDeleteAll, {
    method: "DELETE",
    path: `${BASE}/subscriptions`,
    headers: headersFor(who, origin)
  });

async function deviceRows() {
  return (await getHandlerAdminSql()`
    SELECT * FROM awcms_commerce_push_devices ORDER BY created_at, id
  `) as Record<string, unknown>[];
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

/** A tenant with the feature ON, its storefront host mapped, and one verified shopper. */
async function readyTenant(customerPush = true) {
  const owner = await bootstrapOwner();
  expect((await setCustomerPushFeature(owner, customerPush)).status).toBe(200);
  await mapHost(owner.tenantId, HOST_A);
  await mapHost(owner.tenantId, CMS_HOST);
  return { owner, shopper: await seedShopper(owner.tenantId) };
}

suite("customer Web Push routes (Issue #430)", () => {
  const savedDefaultTenant = process.env.PUBLIC_DEFAULT_TENANT_ID;

  beforeAll(async () => {
    handlerReady = await ensureHandlerDatabaseReady();
    setEnv(PUSH_ENV);
  });
  afterAll(async () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (savedDefaultTenant === undefined)
      delete process.env.PUBLIC_DEFAULT_TENANT_ID;
    else process.env.PUBLIC_DEFAULT_TENANT_ID = savedDefaultTenant;
    await teardownHandlerDatabase();
  });
  beforeEach(async () => {
    resetRateLimitForTests();
    setEnv({
      ...PUSH_ENV,
      COMMERCE_CUSTOMER_PUSH_EXTRA_ENDPOINT_HOSTS: undefined
    });
    delete process.env.PUBLIC_DEFAULT_TENANT_ID;
    if (!handlerReady) return;
    await resetHandlerDatabase();
  });

  // -------------------------------------------------------------------------
  // The flag-off path (TS-H6)
  // -------------------------------------------------------------------------

  test("TS-H6: with the customerPush feature OFF (the default) every route is the same neutral 404, signed in or not", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(false);
    const body = subscriptionBody();

    const responses = [
      await state(shopper),
      await state(null),
      await subscribe(shopper, body),
      await subscribe(null, body),
      await revokeAll(shopper),
      await revokeOne(shopper, crypto.randomUUID()),
      await invoke<Envelope>(preferencesGet, {
        path: `${BASE}/preferences`,
        headers: headersFor(shopper, ORIGIN_A)
      }),
      await invoke<Envelope>(preferencesPut, {
        method: "PUT",
        path: `${BASE}/preferences`,
        headers: headersFor(shopper, ORIGIN_A),
        body: { purposes: { order_updates: false } }
      })
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body.error?.code).toBe("NOT_FOUND");
      expect(response.response.headers.get("cache-control")).toBe(
        "private, no-store"
      );
      expect(response.response.headers.get("vary")).toContain("Origin");
    }
    // Nothing was written.
    expect(await deviceRows()).toHaveLength(0);
  });

  test("TS-H6: feature off, an unknown host and a refused origin cannot be told apart", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(false);

    const off = await state(shopper, ORIGIN_A);
    const unknownHost = await state(shopper, "https://nobody.example.test");

    expect(off.status).toBe(404);
    expect(unknownHost.status).toBe(404);
    expect(JSON.stringify(unknownHost.body)).toBe(JSON.stringify(off.body));
  });

  test("TS-H6: another tenant that has the feature ON does not turn it on for this one", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(false);
    await seedTenantB(true);

    expect((await state(shopper, ORIGIN_A)).status).toBe(404);
    // Tenant B's own storefront is live (the token is B's, not A's: 401, not 404).
    expect((await state(shopper, ORIGIN_B)).status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Credentials (TS-H1, TS-H2)
  // -------------------------------------------------------------------------

  test("TS-H1: no credential, a malformed one, a staff token and an unknown cs_ token are all 401 on every route", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner } = await readyTenant(true);
    const fake = generateCustomerSessionToken();
    const credentials: ({ token: string } | null)[] = [
      null,
      { token: "not-a-token" },
      { token: owner.token }, // a STAFF session token
      { token: fake } // well-formed, never issued
    ];
    const id = crypto.randomUUID();

    for (const who of credentials) {
      const results = [
        await state(who),
        await subscribe(who, subscriptionBody()),
        await revokeAll(who),
        await revokeOne(who, id),
        await invoke<Envelope>(preferencesGet, {
          path: `${BASE}/preferences`,
          headers: headersFor(who, ORIGIN_A)
        }),
        await invoke<Envelope>(preferencesPut, {
          method: "PUT",
          path: `${BASE}/preferences`,
          headers: headersFor(who, ORIGIN_A),
          body: { purposes: { order_updates: false } }
        })
      ];
      for (const result of results) {
        expect(result.status).toBe(401);
        expect(result.body.error?.code).toBe("UNAUTHENTICATED");
      }
    }
    expect(await deviceRows()).toHaveLength(0);
  });

  test("TS-H1: a staff cookie is not a credential on a customer route", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner } = await readyTenant(true);
    const result = await invoke<Envelope>(subscriptionsGet, {
      path: `${BASE}/subscriptions`,
      headers: {
        origin: ORIGIN_A,
        cookie: `awcms_session=${owner.token}; session=${owner.token}`
      }
    });
    expect(result.status).toBe(401);
  });

  test("TS-H2: a cs_ token on the staff push route is refused", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, shopper } = await readyTenant(true);
    const result = await invoke<Envelope>(staffSubscriptionsGet, {
      path: "/api/v1/push/subscriptions",
      headers: {
        "x-awcms-tenant-id": owner.tenantId,
        authorization: `Bearer ${shopper.token}`
      }
    });
    expect(result.status).toBe(401);
  });

  test("TS-H1: a tenant A token presented with tenant B's origin is 401, and the reverse", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);
    await seedTenantB(true);
    const shopperB = await seedShopper(TENANT_B);

    expect((await state(shopper, ORIGIN_B)).status).toBe(401);
    expect((await state(shopperB, ORIGIN_A)).status).toBe(401);
    expect((await state(shopperB, ORIGIN_B)).status).toBe(200);
  });

  test("a blocked account is 403 on read and register but may still revoke its devices", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, shopper } = await readyTenant(true);
    expect((await subscribe(shopper, subscriptionBody())).status).toBe(201);
    const blocked = await seedShopper(owner.tenantId, { blocked: true });

    for (const result of [
      await state(blocked),
      await subscribe(blocked, subscriptionBody())
    ]) {
      expect(result.status).toBe(403);
      expect(result.body.error?.code).toBe("ACCOUNT_BLOCKED");
    }
    expect((await revokeAll(blocked)).status).toBe(204);
  });

  test("an account without a verified e-mail cannot register (403 ACCOUNT_NOT_VERIFIED)", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner } = await readyTenant(true);
    const unverified = await seedShopper(owner.tenantId, { verified: false });
    const result = await subscribe(unverified, subscriptionBody());
    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe("ACCOUNT_NOT_VERIFIED");
    expect(await deviceRows()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Subscribe, list, idempotency (TS-H3, TS-H4)
  // -------------------------------------------------------------------------

  test("GET answers the capability, the preferences and this account's devices, with the cache and CORS headers", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);

    const result = await state(shopper);
    expect(result.status).toBe(200);
    expect(result.body.data.capability).toEqual({
      enabled: true,
      reason: null,
      applicationServerKey: VAPID.publicKey,
      transports: ["web_push"],
      purposes: ["order_updates", "payment_updates", "support_replies"],
      consentTextVersion: VERSION,
      maxDevices: 5
    });
    expect(result.body.data.preferences.map((p) => p.purpose)).toEqual([
      "order_updates",
      "payment_updates",
      "support_replies"
    ]);
    expect(result.body.data.devices).toEqual([]);

    const headers = result.response.headers;
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.get("vary")).toContain("Origin");
    expect(headers.get("access-control-allow-origin")).toBe(ORIGIN_A);
    // The bearer is a capability script attaches deliberately: no credentialed CORS.
    expect(headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("POST registers (201), a repeat is a no-op (200) with the same device, and the answer never carries a credential", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);
    const body = subscriptionBody();

    const first = await subscribe(shopper, body, ORIGIN_A, {
      "user-agent":
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
    });
    expect(first.status).toBe(201);
    expect(first.body.data.device).toMatchObject({
      status: "active",
      current: true,
      userAgentSummary: "Chrome on Android (mobile)"
    });
    expect(String(first.body.data.device.endpointMasked)).toContain("…");

    const second = await subscribe(shopper, body);
    expect(second.status).toBe(200);
    expect(second.body.data.device.id).toBe(first.body.data.device.id);
    expect(await deviceRows()).toHaveLength(1);

    for (const response of [first, second]) {
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(SENTINEL_TOKEN);
      expect(text).not.toContain(SENTINEL_AUTH);
      expect(text).not.toContain(P256DH);
      expect(text).not.toContain("fcm.googleapis.com/fcm/send");
      expect(text).not.toContain("ciphertext");
      expect(response.response.headers.get("cache-control")).toBe(
        "private, no-store"
      );
    }

    const listed = await state(shopper);
    expect(listed.body.data.devices).toHaveLength(1);
    expect(listed.body.data.devices[0]!.current).toBe(true);
    expect(
      listed.body.data.preferences.find((p) => p.purpose === "order_updates")!
        .enabled
    ).toBe(true);
  });

  test("TS-H4: a sentinel endpoint, key and secret never reach the audit log or the stored columns in the clear", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);
    expect((await subscribe(shopper, subscriptionBody())).status).toBe(201);

    const audit = (await getHandlerAdminSql()`
      SELECT action, message, attributes::text AS attributes
      FROM awcms_audit_events WHERE action LIKE 'commerce.customer_push.%'
    `) as { action: string; message: string; attributes: string }[];
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit)).not.toContain(SENTINEL_TOKEN);
    expect(JSON.stringify(audit)).not.toContain(SENTINEL_AUTH);
    expect(JSON.stringify(audit)).not.toContain(P256DH);

    const rows = JSON.stringify(await deviceRows());
    expect(rows).not.toContain(SENTINEL_TOKEN);
    expect(rows).not.toContain(SENTINEL_AUTH);
  });

  // -------------------------------------------------------------------------
  // Abuse: hostile endpoints, strict schema, limits
  // -------------------------------------------------------------------------

  test("ABUSE: a non-allowlisted endpoint is refused with 422 ENDPOINT_NOT_ALLOWED and NOTHING is written", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);

    for (const endpoint of [
      "https://evil.example.com/steal",
      "https://fcm.googleapis.com.evil.example/fcm/send/x",
      "https://169.254.169.254/latest/meta-data",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://user:pw@fcm.googleapis.com/fcm/send/x"
    ]) {
      const result = await subscribe(shopper, subscriptionBody({ endpoint }));
      expect([422]).toContain(result.status);
      expect(["ENDPOINT_NOT_ALLOWED", "VALIDATION_ERROR"]).toContain(
        String(result.body.error?.code)
      );
    }

    const hostile = await subscribe(
      shopper,
      subscriptionBody({ endpoint: "https://evil.example.com/steal" })
    );
    expect(hostile.status).toBe(422);
    expect(hostile.body.error?.code).toBe("ENDPOINT_NOT_ALLOWED");
    expect(JSON.stringify(hostile.body)).not.toContain("evil");

    expect(await deviceRows()).toHaveLength(0);
    const preferences = (await getHandlerAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_push_preferences
    `) as { n: number }[];
    expect(preferences[0]!.n).toBe(0);
  });

  test("an operator-extended allowlist accepts a new push service, a tenant cannot", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);
    const endpoint = "https://push.vendor.example/send/abc";

    expect(
      (await subscribe(shopper, subscriptionBody({ endpoint }))).body.error
        ?.code
    ).toBe("ENDPOINT_NOT_ALLOWED");

    setEnv({
      COMMERCE_CUSTOMER_PUSH_EXTRA_ENDPOINT_HOSTS: "push.vendor.example"
    });
    expect(
      (await subscribe(shopper, subscriptionBody({ endpoint }))).status
    ).toBe(201);
  });

  test("TS-U5/T2: a client-chosen principal or content key is a 400 and nothing is written", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, shopper } = await readyTenant(true);

    for (const extra of [
      { accountId: crypto.randomUUID() },
      { customerId: crypto.randomUUID() },
      { tenantId: owner.tenantId },
      { sessionId: crypto.randomUUID() },
      { tenantUserId: owner.tenantUserId },
      { transport: "fcm" },
      { title: "Your account is locked", body: "Click here" },
      { navigate: "https://evil.example/phish" },
      { storefrontOrigin: "https://evil.example" }
    ]) {
      const result = await subscribe(shopper, subscriptionBody(extra));
      expect(result.status).toBe(400);
      expect(result.body.error?.code).toBe("VALIDATION_ERROR");
    }
    expect(await deviceRows()).toHaveLength(0);
  });

  test("semantic validation is a 422: an http endpoint, short keys, marketing, a stale consent text", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);

    for (const body of [
      subscriptionBody({ endpoint: "http://fcm.googleapis.com/fcm/send/x" }),
      subscriptionBody({ keys: { p256dh: "short", auth: SENTINEL_AUTH } }),
      subscriptionBody({ keys: { p256dh: P256DH, auth: "short" } }),
      subscriptionBody({
        consent: { purposes: ["marketing"], textVersion: VERSION }
      }),
      subscriptionBody({
        consent: { purposes: ["order_updates"], textVersion: "draft-1999-01" }
      }),
      subscriptionBody({ consent: { purposes: [], textVersion: VERSION } })
    ]) {
      const result = await subscribe(shopper, body);
      expect(result.status).toBe(422);
    }
    expect(await deviceRows()).toHaveLength(0);
  });

  test("body handling: not JSON is 400, the wrong content type is 415, over 8 KiB is 413", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);

    const raw = (body: string, contentType = "application/json") =>
      subscriptionsPost({
        request: new Request(`http://integration.test${BASE}/subscriptions`, {
          method: "POST",
          headers: {
            ...headersFor(shopper, ORIGIN_A),
            "content-type": contentType
          },
          body
        }),
        url: new URL(`http://integration.test${BASE}/subscriptions`),
        params: {},
        locals: {},
        cookies: createCookieJar(),
        clientAddress: "127.0.0.1"
      } as never);

    expect((await raw("{not json")).status).toBe(400);
    expect(
      (await raw("endpoint=x", "application/x-www-form-urlencoded")).status
    ).toBe(415);
    const big = await raw(JSON.stringify({ endpoint: "x".repeat(9000) }));
    expect(big.status).toBe(413);
    // The refusal still carries the cache and CORS headers the page can read.
    expect(big.headers.get("access-control-allow-origin")).toBe(ORIGIN_A);
    expect(await deviceRows()).toHaveLength(0);
  });

  test("T8/Q3: a same-origin request and the CMS origin are refused - no shopper device on the admin origin", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, shopper } = await readyTenant(true);
    process.env.PUBLIC_DEFAULT_TENANT_ID = owner.tenantId;

    // No Origin header: storefront and CMS on one origin is unsupported in v1.
    const sameOrigin = await subscribe(shopper, subscriptionBody(), null);
    expect(sameOrigin.status).toBe(422);
    expect(sameOrigin.body.error?.code).toBe("ORIGIN_NOT_ALLOWED");
    const capability = await state(shopper, null);
    expect(capability.body.data.capability).toMatchObject({
      enabled: false,
      reason: "origin_not_supported",
      applicationServerKey: null
    });

    // The CMS/admin origin is an active domain of the tenant, yet never a storefront.
    const cms = await subscribe(shopper, subscriptionBody(), CMS_ORIGIN);
    expect(cms.status).toBe(422);
    expect(cms.body.error?.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(await deviceRows()).toHaveLength(0);
  });

  test("an unconfigured deployment answers capability off and 409 PUSH_UNAVAILABLE on register (no plaintext fallback)", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);

    for (const missing of [
      { PUSH_AUTH_SECRET_ENCRYPTION_KEYS: undefined },
      { PUSH_ENABLED: "false" },
      { PUSH_VAPID_PRIVATE_KEY: undefined },
      { PUSH_PROVIDER: "log" }
    ]) {
      setEnv({ ...PUSH_ENV, ...missing });
      const capability = await state(shopper);
      expect(capability.status).toBe(200);
      expect(capability.body.data.capability).toMatchObject({
        enabled: false,
        reason: "push_not_configured",
        applicationServerKey: null
      });
      const result = await subscribe(shopper, subscriptionBody());
      expect(result.status).toBe(409);
      expect(result.body.error?.code).toBe("PUSH_UNAVAILABLE");
    }
    expect(await deviceRows()).toHaveLength(0);
  });

  test("the sixth device is 409 DEVICE_LIMIT; revoking one frees a slot", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);

    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await subscribe(shopper, subscriptionBody());
      expect(result.status).toBe(201);
      ids.push(String(result.body.data.device.id));
    }
    const sixth = await subscribe(shopper, subscriptionBody());
    expect(sixth.status).toBe(409);
    expect(sixth.body.error?.code).toBe("DEVICE_LIMIT");

    expect((await revokeOne(shopper, ids[0]!)).status).toBe(204);
    expect((await subscribe(shopper, subscriptionBody())).status).toBe(201);
  });

  test("TS-H5: the per-account register limit answers 429 with Retry-After", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);
    const body = subscriptionBody();

    for (let i = 0; i < 10; i += 1) {
      expect([200, 201]).toContain((await subscribe(shopper, body)).status);
    }
    const limited = await subscribe(shopper, body);
    expect(limited.status).toBe(429);
    expect(limited.body.error?.code).toBe("RATE_LIMITED");
    expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(
      0
    );
  });

  // -------------------------------------------------------------------------
  // Revoke and ownership (TS-H6)
  // -------------------------------------------------------------------------

  test("DELETE by id: 204 for the owner; a foreign, an absent, a malformed and an already-revoked id are the same 404", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, shopper } = await readyTenant(true);
    const other = await seedShopper(owner.tenantId);

    const mine = await subscribe(shopper, subscriptionBody());
    const theirs = await subscribe(other, subscriptionBody());
    const mineId = String(mine.body.data.device.id);
    const theirsId = String(theirs.body.data.device.id);

    const foreign = await revokeOne(shopper, theirsId);
    const absent = await revokeOne(shopper, crypto.randomUUID());
    const malformed = await revokeOne(shopper, "not-a-uuid");
    for (const result of [foreign, absent, malformed]) {
      expect(result.status).toBe(404);
      expect(result.body.error?.code).toBe("NOT_FOUND");
    }
    expect(JSON.stringify(foreign.body)).toBe(JSON.stringify(absent.body));
    expect(JSON.stringify(foreign.body)).toBe(JSON.stringify(malformed.body));

    // The foreign device is untouched.
    const stillActive = (await deviceRows()).find((r) => r.id === theirsId)!;
    expect(stillActive.status).toBe("active");

    const own = await revokeOne(shopper, mineId);
    expect(own.status).toBe(204);
    expect(own.response.headers.get("cache-control")).toBe("private, no-store");
    const again = await revokeOne(shopper, mineId);
    expect(again.status).toBe(404);
    expect(JSON.stringify(again.body)).toBe(JSON.stringify(absent.body));
  });

  test("DELETE all removes every device of the account and no other; repeating it is a 204", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, shopper } = await readyTenant(true);
    const other = await seedShopper(owner.tenantId);
    await subscribe(shopper, subscriptionBody());
    await subscribe(shopper, subscriptionBody());
    await subscribe(other, subscriptionBody());

    expect((await revokeAll(shopper)).status).toBe(204);
    expect((await revokeAll(shopper)).status).toBe(204);

    const rows = await deviceRows();
    expect(rows.filter((r) => r.status === "revoked")).toHaveLength(2);
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
    expect((await state(other)).body.data.devices).toHaveLength(1);
    expect((await state(shopper)).body.data.devices).toHaveLength(0);
  });

  test("a device registered through tenant A's storefront cannot be revoked from tenant B's, with tenant A's id in hand", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);
    await seedTenantB(true);
    const shopperB = await seedShopper(TENANT_B);
    const device = await subscribe(shopper, subscriptionBody());
    const id = String(device.body.data.device.id);

    const attempt = await revokeOne(shopperB, id, ORIGIN_B);
    expect(attempt.status).toBe(404);
    expect((await deviceRows())[0]!.status).toBe("active");
  });

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  test("PUT preferences: turning a purpose on records the wording version; off needs none; marketing and unknown keys are refused; every change is audited", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);
    const put = (body: unknown) =>
      invoke<
        Envelope<{
          preferences: {
            purpose: string;
            enabled: boolean;
            consentTextVersion: string | null;
          }[];
        }>
      >(preferencesPut, {
        method: "PUT",
        path: `${BASE}/preferences`,
        headers: headersFor(shopper, ORIGIN_A),
        body
      });

    const missingVersion = await put({ purposes: { payment_updates: true } });
    expect(missingVersion.status).toBe(422);

    const on = await put({
      purposes: { payment_updates: true, support_replies: true },
      textVersion: VERSION
    });
    expect(on.status).toBe(200);
    const enabled = on.body.data.preferences.filter((p) => p.enabled);
    expect(enabled.map((p) => p.purpose).sort()).toEqual([
      "payment_updates",
      "support_replies"
    ]);
    expect(enabled[0]!.consentTextVersion).toBe(VERSION);

    const off = await put({ purposes: { payment_updates: false } });
    expect(off.status).toBe(200);
    expect(
      off.body.data.preferences.find((p) => p.purpose === "payment_updates")!
        .enabled
    ).toBe(false);

    for (const bad of [
      { purposes: { marketing: true }, textVersion: VERSION },
      { purposes: { bogus: false } },
      { purposes: { order_updates: false }, accountId: "x" },
      { purposes: {} }
    ]) {
      expect((await put(bad)).status).toBe(422);
    }

    const read = await invoke<
      Envelope<{ preferences: { purpose: string; enabled: boolean }[] }>
    >(preferencesGet, {
      path: `${BASE}/preferences`,
      headers: headersFor(shopper, ORIGIN_A)
    });
    expect(read.status).toBe(200);
    expect(read.body.data.preferences).toHaveLength(3);

    const audit = (await getHandlerAdminSql()`
      SELECT count(*)::int AS n FROM awcms_audit_events
      WHERE action = 'commerce.customer_push.preferences_changed'
    `) as { n: number }[];
    expect(audit[0]!.n).toBe(2);
  });

  test.each([
    ["blocked", "ACCOUNT_BLOCKED"],
    ["unverified", "ACCOUNT_NOT_VERIFIED"]
  ] as const)(
    "PUT preferences: a %s account can always WITHDRAW a purpose (recorded) but cannot enable one (ADR-0048)",
    async (state, deniedCode) => {
      if (skipUnlessHandlerReady()) return;
      const { owner } = await readyTenant(true);
      const shopper = await seedShopper(owner.tenantId);
      const put = (body: unknown) =>
        invoke<
          Envelope<{ preferences: { purpose: string; enabled: boolean }[] }>
        >(preferencesPut, {
          method: "PUT",
          path: `${BASE}/preferences`,
          headers: headersFor(shopper, ORIGIN_A),
          body
        });

      // Enabled while the account is still in good standing ...
      const on = await put({
        purposes: { payment_updates: true },
        textVersion: VERSION
      });
      expect(on.status).toBe(200);

      // ... then it becomes blocked / loses its verified e-mail.
      const admin = getHandlerAdminSql();
      if (state === "blocked") {
        await admin`UPDATE awcms_commerce_customer_accounts SET status = 'blocked' WHERE id = ${shopper.accountId}`;
      } else {
        await admin`UPDATE awcms_commerce_customer_accounts SET email_verified_at = NULL WHERE id = ${shopper.accountId}`;
      }

      const enable = await put({
        purposes: { order_updates: true },
        textVersion: VERSION
      });
      expect(enable.status).toBe(403);
      expect(enable.body.error?.code).toBe(deniedCode);

      // A mixed body enables something, so it keeps the strict gate.
      const mixed = await put({
        purposes: { payment_updates: false, order_updates: true },
        textVersion: VERSION
      });
      expect(mixed.status).toBe(403);

      const off = await put({ purposes: { payment_updates: false } });
      expect(off.status).toBe(200);
      expect(
        off.body.data.preferences.find((p) => p.purpose === "payment_updates")!
          .enabled
      ).toBe(false);

      const stored = (await admin`
        SELECT enabled FROM awcms_commerce_push_preferences
        WHERE account_id = ${shopper.accountId} AND purpose = 'payment_updates'
      `) as { enabled: boolean }[];
      expect(stored[0]!.enabled).toBe(false);
      const audit = (await admin`
        SELECT count(*)::int AS n FROM awcms_audit_events
        WHERE action = 'commerce.customer_push.preferences_changed'
      `) as { n: number }[];
      expect(audit[0]!.n).toBe(2);
    }
  );

  // -------------------------------------------------------------------------
  // CORS and preflight (TS-H3)
  // -------------------------------------------------------------------------

  test("TS-H3: preflight grants a tenant origin with authorization and the DELETE/PUT methods, never credentials; an unknown origin gets no grant", async () => {
    if (skipUnlessHandlerReady()) return;
    await readyTenant(true);

    const preflight = (origin: string) =>
      invoke<unknown>(subscriptionsOptions, {
        method: "OPTIONS",
        path: `${BASE}/subscriptions`,
        headers: {
          origin,
          "access-control-request-method": "DELETE",
          "access-control-request-headers": "authorization"
        }
      });

    const granted = await preflight(ORIGIN_A);
    expect(granted.status).toBe(204);
    expect(granted.response.headers.get("access-control-allow-origin")).toBe(
      ORIGIN_A
    );
    expect(
      granted.response.headers.get("access-control-allow-headers")
    ).toContain("authorization");
    expect(
      granted.response.headers.get("access-control-allow-methods")
    ).toContain("DELETE");
    expect(
      granted.response.headers.get("access-control-allow-methods")
    ).toContain("PUT");
    expect(
      granted.response.headers.get("access-control-allow-credentials")
    ).toBeNull();
    expect(granted.response.headers.get("vary")).toContain("Origin");

    const refused = await preflight("https://attacker.example");
    expect(
      refused.response.headers.get("access-control-allow-origin")
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Logout (TS-I3 at the HTTP level)
  // -------------------------------------------------------------------------

  test("logout revokes the devices the session enrolled, in the same call, and the bearer is dead afterwards", async () => {
    if (skipUnlessHandlerReady()) return;
    const { shopper } = await readyTenant(true);
    expect((await subscribe(shopper, subscriptionBody())).status).toBe(201);
    expect((await subscribe(shopper, subscriptionBody())).status).toBe(201);

    const out = await invoke<Envelope>(logoutPost, {
      method: "POST",
      path: "/api/v1/commerce/storefront/account/logout",
      headers: headersFor(shopper, ORIGIN_A)
    });
    expect(out.status).toBe(204);

    const rows = await deviceRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("revoked");
      expect(row.status_reason).toBe("logout");
      expect(row.endpoint_ciphertext).toBeNull();
    }
    expect((await state(shopper)).status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Staff diagnostics (aggregate only)
  // -------------------------------------------------------------------------

  test("diagnostics: staff with the permission read aggregate counts only; a customer token is 401; feature off is 409", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, shopper } = await readyTenant(true);
    const device = await subscribe(shopper, subscriptionBody());
    expect(device.status).toBe(201);

    const read = (headers: Record<string, string>) =>
      invoke<Envelope<Record<string, unknown>>>(diagnosticsGet, {
        path: "/api/v1/commerce/customer-push/diagnostics",
        headers
      });

    const staff = await read(ownerHeaders(owner));
    expect(staff.status).toBe(200);
    expect(staff.body.data.devices).toEqual({
      active: 1,
      revoked: 0,
      gone: 0,
      disabled: 0
    });
    const text = JSON.stringify(staff.body);
    for (const leak of [
      shopper.accountId,
      shopper.customerId,
      String(device.body.data.device.id),
      SENTINEL_TOKEN,
      "fcm.googleapis.com",
      shopper.token
    ]) {
      expect(text).not.toContain(leak);
    }

    // A customer bearer is not a staff credential.
    const asCustomer = await read({
      "x-awcms-tenant-id": owner.tenantId,
      authorization: `Bearer ${shopper.token}`
    });
    expect(asCustomer.status).toBe(401);

    // Feature off: the owner convention is 409 FEATURE_DISABLED.
    expect((await setCustomerPushFeature(owner, false)).status).toBe(200);
    const off = await read(ownerHeaders(owner));
    expect(off.status).toBe(409);
    expect(off.body.error?.code).toBe("FEATURE_DISABLED");
  });
});
