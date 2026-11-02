/**
 * `GET|PUT /api/v1/commerce/commission/settings` through the REAL route handlers
 * (Issue #391, ADR-0046 D12). World 2 of `harness.ts`. Proves what only the
 * wiring can:
 *
 *   - the adapter is no longer dormant: `PUT enabled: true` answers 200, never
 *     `409 COMMISSION_ADAPTER_DORMANT`;
 *   - enabling while the tenant's intake is not usable is SAFE and VISIBLE: the
 *     answer carries `readiness.state` (`off`, `hr_commission_module_disabled`,
 *     `awaiting_first_submission`, `submitting`) built only from the module
 *     registry and commerce's own submission record - no commission table is
 *     read (`tests/commerce-commission-boundary.test.ts`);
 *   - a caller without `commerce.commission_settings.manage` is refused.
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
import {
  GET as getSettings,
  PUT as putSettings
} from "../../src/pages/api/v1/commerce/commission/settings";

const OWNER_PASSWORD = "integration-test-owner-password";

type Principal = { tenantId: string; token: string; tenantUserId: string };
type Envelope = {
  success: boolean;
  data?: {
    settings: { enabled: boolean; ruleKey: string | null };
    readiness: {
      state: string;
      hrCommissionModuleEnabled: boolean;
      lastSubmittedAt: string | null;
    };
  };
  error?: { code: string };
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

/** A user with NO role at all: authenticated, but holding no permission. */
async function seedBareUser(tenantId: string): Promise<Principal> {
  const admin = getHandlerAdminSql();
  const [profile] = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Bare') RETURNING id
  `) as { id: string }[];
  const [identity] = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile!.id}, 'bare@example.test', 'x') RETURNING id
  `) as { id: string }[];
  const [user] = (await admin`
    INSERT INTO awcms_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identity!.id}) RETURNING id
  `) as { id: string }[];
  const token = `it-token-bare-${Date.now()}`;
  await admin`
    INSERT INTO awcms_sessions (tenant_id, identity_id, token_hash, expires_at)
    VALUES (${tenantId}, ${identity!.id}, ${hashSessionToken(token)}, ${new Date(Date.now() + 3_600_000)})
  `;
  return { tenantId, token, tenantUserId: user!.id };
}

function headers(who: Principal) {
  return {
    "content-type": "application/json",
    "x-awcms-tenant-id": who.tenantId,
    authorization: `Bearer ${who.token}`
  };
}

const read = (who: Principal) =>
  invoke<Envelope>(getSettings, {
    method: "GET",
    path: "/api/v1/commerce/commission/settings",
    headers: headers(who)
  });

const write = (who: Principal, body: Record<string, unknown>) =>
  invoke<Envelope>(putSettings, {
    method: "PUT",
    path: "/api/v1/commerce/commission/settings",
    headers: headers(who),
    body
  });

const suite = integrationEnabled ? describe : describe.skip;
let handlerReady = false;

suite("commerce commission settings route (Issue #391, ADR-0046 D12)", () => {
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

  test("enabling is accepted (no COMMISSION_ADAPTER_DORMANT) and the readiness walks off -> awaiting_first_submission -> submitting, and shows a switched-off hr_commission module", async () => {
    if (!handlerReady) return;
    const owner = await bootstrapOwner();

    const initial = await read(owner);
    expect(initial.status).toBe(200);
    expect(initial.body.data!.settings.enabled).toBe(false);
    expect(initial.body.data!.readiness.state).toBe("off");

    const enabled = await write(owner, { enabled: true, ruleKey: "pos-sales" });
    expect(enabled.status).toBe(200);
    expect(enabled.body.error).toBeUndefined();
    expect(enabled.body.data!.settings.enabled).toBe(true);
    // Safe and visible: nothing has been submitted yet, and the answer says so.
    expect(enabled.body.data!.readiness).toMatchObject({
      state: "awaiting_first_submission",
      lastSubmittedAt: null
    });

    // A submission recorded by the consumer (written the way the consumer does).
    const admin = getHandlerAdminSql();
    const [customer] = (await admin`
      INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
      VALUES (${owner.tenantId}, 'Walk-in', '+628120000001') RETURNING id
    `) as { id: string }[];
    const [product] = (await admin`
      INSERT INTO awcms_commerce_products (tenant_id, sku, name, slug, price, stock)
      VALUES (${owner.tenantId}, 'SKU-391', 'Kopi', 'kopi-391', 10000.00, 10)
      RETURNING id
    `) as { id: string }[];
    const [order] = (await admin`
      INSERT INTO awcms_commerce_orders
        (tenant_id, order_code, customer_id, status, payment_method, payment_status,
         shipping_method, subtotal, total, paid_at, channel, pos_cashier_tenant_user_id)
      VALUES (${owner.tenantId}, 'COM-391', ${customer!.id}, 'paid', 'manual_qris', 'paid',
              'self_pickup', 10000.00, 10000.00, now(), 'pos', ${owner.tenantUserId})
      RETURNING id
    `) as { id: string }[];
    const [item] = (await admin`
      INSERT INTO awcms_commerce_order_items
        (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
      VALUES (${owner.tenantId}, ${order!.id}, ${product!.id}, 'Kopi', 10000.00, 1, 10000.00)
      RETURNING id
    `) as { id: string }[];
    await admin`
      INSERT INTO awcms_commerce_commission_submissions
        (tenant_id, order_id, order_item_id, employment_id, source_type, rule_key)
      VALUES (${owner.tenantId}, ${order!.id}, ${item!.id},
              '11111111-1111-4111-8111-111111111111', 'commerce_order_line', 'pos-sales')
    `;
    const submitting = await read(owner);
    expect(submitting.body.data!.readiness.state).toBe("submitting");
    expect(submitting.body.data!.readiness.lastSubmittedAt).not.toBeNull();

    // hr_commission switched off for the tenant: still saved, visibly not flowing.
    await admin`
      INSERT INTO awcms_modules (module_key, module_name)
      VALUES ('hr_commission', 'HR Commission') ON CONFLICT DO NOTHING
    `;
    await admin`
      INSERT INTO awcms_tenant_modules (tenant_id, module_key, enabled)
      VALUES (${owner.tenantId}, 'hr_commission', false)
      ON CONFLICT (tenant_id, module_key) DO UPDATE SET enabled = false
    `;
    const off = await read(owner);
    expect(off.body.data!.readiness).toMatchObject({
      state: "hr_commission_module_disabled",
      hrCommissionModuleEnabled: false
    });

    const disabled = await write(owner, { enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.data!.readiness.state).toBe("off");
  });

  test("a user with no permission can neither read nor change the settings", async () => {
    if (!handlerReady) return;
    const owner = await bootstrapOwner();
    const bare = await seedBareUser(owner.tenantId);
    expect((await read(bare)).status).toBe(403);
    expect(
      (await write(bare, { enabled: true, ruleKey: "pos-sales" })).status
    ).toBe(403);
    expect((await read(owner)).body.data!.settings.enabled).toBe(false);
  });
});
