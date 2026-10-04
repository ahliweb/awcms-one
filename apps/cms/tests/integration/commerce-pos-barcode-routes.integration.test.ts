/**
 * Barcode lookup and assignment through the REAL route handlers (Issue #292,
 * epic #281, ADR-0032) - the HTTP half `commerce-pos-barcode.integration.test.ts`
 * (directory functions, RLS as the runtime role) cannot see: route wiring
 * (`defineTenantRoute`, ABAC default-deny, the `barcode` feature gate, body
 * validation, error -> status mapping).
 *
 * WORLD 2 (see `harness.ts`): handlers use `getDatabaseClient()`, so this file
 * runs against the migrated `DATABASE_URL` and seeds through
 * `getHandlerAdminSql()`. The owner comes from the real setup + login endpoints;
 * every other principal holds EXACTLY the keys under test, so a 403 means "that
 * key was missing":
 *
 *   - the feature gate answers 409 FEATURE_DISABLED until the tenant opts in;
 *   - a cashier holding only `commerce.pos.create` cannot look a code up
 *     (a barcode is an identifier, not a credential - default deny first);
 *   - `barcodes.read` cannot assign, `barcodes.update` alone cannot look up;
 *   - unknown, foreign-tenant and deleted codes are the SAME 404 body (no
 *     oracle), and a foreign product id cannot be assigned a code (BOLA);
 *   - duplicate and malformed codes are 409 BARCODE_DUPLICATE / 400.
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
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import {
  GET as listBarcodes,
  PUT as putBarcode
} from "../../src/pages/api/v1/commerce/barcodes/index";
import { GET as lookupBarcode } from "../../src/pages/api/v1/commerce/barcodes/lookup";

const OWNER_PASSWORD = "integration-test-owner-password";
const OTHER_TENANT = "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b";

type Principal = { tenantId: string; token: string; tenantUserId: string };
type Envelope<T = unknown> = {
  success: boolean;
  data: T;
  error?: { code: string; details?: unknown };
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

function headers(who: Principal): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-tenant-id": who.tenantId,
    authorization: `Bearer ${who.token}`
  };
}

function setBarcodeFeature(owner: Principal, barcode: boolean) {
  return invoke<Envelope>(patchModuleSettings, {
    method: "PATCH",
    path: "/api/v1/tenant/modules/commerce/settings",
    headers: headers(owner),
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
        barcode
      }
    }
  });
}

async function seedProduct(tenantId: string, sku: string): Promise<string> {
  const rows = (await getHandlerAdminSql()`
    INSERT INTO awcms_commerce_products (tenant_id, sku, name, slug, price, stock, status)
    VALUES (${tenantId}, ${sku}, ${`Name ${sku}`}, ${`slug-${sku.toLowerCase()}`}, 15000, 5, 'active')
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

const lookup = (who: Principal, code: string) =>
  invoke<Envelope<Record<string, unknown>>>(lookupBarcode, {
    path: `/api/v1/commerce/barcodes/lookup?code=${encodeURIComponent(code)}`,
    headers: headers(who)
  });

const assign = (who: Principal, body: unknown) =>
  invoke<Envelope<Record<string, unknown>>>(putBarcode, {
    method: "PUT",
    path: "/api/v1/commerce/barcodes",
    headers: headers(who),
    body
  });

const suite = integrationEnabled ? describe : describe.skip;
let handlerReady = false;

function skipUnlessHandlerReady(): boolean {
  if (handlerReady) return false;
  console.warn(
    "[skip] handler database is not migrated - run 'bun run db:migrate' against DATABASE_URL."
  );
  return true;
}

suite("barcode routes (Issue #292)", () => {
  beforeAll(async () => {
    handlerReady = await ensureHandlerDatabaseReady();
  });
  afterAll(async () => {
    await teardownHandlerDatabase();
  });
  beforeEach(async () => {
    if (!handlerReady) return;
    await resetHandlerDatabase();
  });

  test("every barcode route is 409 FEATURE_DISABLED until the tenant opts in", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    const productId = await seedProduct(owner.tenantId, "OFF-1");

    for (const response of [
      await lookup(owner, "ANY-1"),
      await invoke<Envelope>(listBarcodes, {
        path: "/api/v1/commerce/barcodes",
        headers: headers(owner)
      }),
      await assign(owner, { productId, barcode: "ANY-1" })
    ]) {
      expect(response.status).toBe(409);
      expect(response.body.error?.code).toBe("FEATURE_DISABLED");
    }

    expect((await setBarcodeFeature(owner, true)).status).toBe(200);
    expect((await assign(owner, { productId, barcode: "ANY-1" })).status).toBe(
      200
    );
    // Turning it back off closes the routes again.
    await setBarcodeFeature(owner, false);
    expect((await lookup(owner, "ANY-1")).status).toBe(409);
  });

  test("assign then look up, list, and clear", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setBarcodeFeature(owner, true);
    const productId = await seedProduct(owner.tenantId, "RT-1");

    const saved = await assign(owner, { productId, barcode: "4006381333931" });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({
      productId,
      barcode: "4006381333931",
      symbology: "ean13"
    });

    const found = await lookup(owner, "4006381333931");
    expect(found.status).toBe(200);
    expect(found.body.data).toMatchObject({
      productId,
      price: "15000.00",
      stock: 5,
      sellable: true,
      requiresVariant: false
    });

    const list = await invoke<Envelope<{ items: { productId: string }[] }>>(
      listBarcodes,
      {
        path: "/api/v1/commerce/barcodes?barcode=with",
        headers: headers(owner)
      }
    );
    expect(list.body.data.items.map((i) => i.productId)).toEqual([productId]);

    const cleared = await assign(owner, { productId, barcode: null });
    expect(cleared.status).toBe(200);
    expect((await lookup(owner, "4006381333931")).status).toBe(404);
  });

  test("validation: malformed bodies, bad check digit and bad query are 400", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setBarcodeFeature(owner, true);
    const productId = await seedProduct(owner.tenantId, "VAL-1");

    expect((await assign(owner, { productId })).status).toBe(400);
    expect(
      (await assign(owner, { productId: "nope", barcode: "X1" })).status
    ).toBe(400);
    const badDigit = await assign(owner, {
      productId,
      barcode: "4006381333932"
    });
    expect(badDigit.status).toBe(400);
    expect(badDigit.body.error?.code).toBe("VALIDATION_ERROR");
    expect(
      (await assign(owner, { productId, barcode: "has space" })).status
    ).toBe(400);
    expect((await assign(owner, { productId, barcode: "3*ABC" })).status).toBe(
      400
    );

    expect((await lookup(owner, "")).status).toBe(400);
    expect((await lookup(owner, "x".repeat(60))).status).toBe(400);
    expect((await lookup(owner, "a b")).status).toBe(400);
    const badFilter = await invoke<Envelope>(listBarcodes, {
      path: "/api/v1/commerce/barcodes?barcode=maybe",
      headers: headers(owner)
    });
    expect(badFilter.status).toBe(400);
  });

  test("a duplicate code is 409 BARCODE_DUPLICATE and leaves the first holder untouched", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setBarcodeFeature(owner, true);
    const a = await seedProduct(owner.tenantId, "DUP-A");
    const b = await seedProduct(owner.tenantId, "DUP-B");
    expect(
      (await assign(owner, { productId: a, barcode: "DUP-CODE" })).status
    ).toBe(200);
    const clash = await assign(owner, { productId: b, barcode: "DUP-CODE" });
    expect(clash.status).toBe(409);
    expect(clash.body.error?.code).toBe("BARCODE_DUPLICATE");
    expect((await lookup(owner, "DUP-CODE")).body.data.productId).toBe(a);
  });

  test("two simultaneous PUTs of one code: exactly one wins", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setBarcodeFeature(owner, true);
    const a = await seedProduct(owner.tenantId, "RACE-A");
    const b = await seedProduct(owner.tenantId, "RACE-B");
    const [first, second] = await Promise.all([
      assign(owner, { productId: a, barcode: "RACE-CODE" }),
      assign(owner, { productId: b, barcode: "RACE-CODE" })
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
  });

  test("permissions are resource-split and default deny", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setBarcodeFeature(owner, true);
    const productId = await seedProduct(owner.tenantId, "PERM-1");
    await assign(owner, { productId, barcode: "PERM-CODE" });

    const cashier = await seedPrincipal(owner.tenantId, "cashier", [
      "commerce.pos.create"
    ]);
    const reader = await seedPrincipal(owner.tenantId, "reader", [
      "commerce.barcodes.read"
    ]);
    const editor = await seedPrincipal(owner.tenantId, "editor", [
      "commerce.barcodes.update"
    ]);
    const products = await seedPrincipal(owner.tenantId, "products", [
      "commerce.products.read",
      "commerce.products.update"
    ]);

    // Ringing up sales or editing products does not open the lookup.
    expect((await lookup(cashier, "PERM-CODE")).status).toBe(403);
    expect((await lookup(products, "PERM-CODE")).status).toBe(403);
    expect(
      (await assign(products, { productId, barcode: "NEW-CODE" })).status
    ).toBe(403);
    expect(
      (await assign(cashier, { productId, barcode: "NEW-CODE" })).status
    ).toBe(403);

    expect((await lookup(reader, "PERM-CODE")).status).toBe(200);
    expect(
      (await assign(reader, { productId, barcode: "NEW-CODE" })).status
    ).toBe(403);
    expect((await lookup(editor, "PERM-CODE")).status).toBe(403);
    expect(
      (await assign(editor, { productId, barcode: "NEW-CODE" })).status
    ).toBe(200);
  });

  test("a foreign tenant's code and product id are the same 404 as an unknown one (BOLA)", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setBarcodeFeature(owner, true);
    const admin = getHandlerAdminSql();
    await admin`
      INSERT INTO awcms_tenants (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${OTHER_TENANT}, 'other-bc', 'Other', 'Other', 'active', 'en', 'light')
    `;
    const foreign = await seedProduct(OTHER_TENANT, "FOREIGN-1");
    await admin`UPDATE awcms_commerce_products SET barcode = 'FOREIGN-CODE' WHERE id = ${foreign}`;

    const foreignLookup = await lookup(owner, "FOREIGN-CODE");
    const unknownLookup = await lookup(owner, "NOBODY-HAS-THIS");
    expect(foreignLookup.status).toBe(404);
    expect(foreignLookup.body).toEqual(unknownLookup.body);

    const foreignAssign = await assign(owner, {
      productId: foreign,
      barcode: "TAKEOVER"
    });
    const unknownAssign = await assign(owner, {
      productId: "00000000-0000-4000-8000-000000000000",
      barcode: "TAKEOVER"
    });
    expect(foreignAssign.status).toBe(404);
    expect(foreignAssign.body).toEqual(unknownAssign.body);
    const row =
      (await admin`SELECT barcode FROM awcms_commerce_products WHERE id = ${foreign}`) as {
        barcode: string | null;
      }[];
    expect(row[0]!.barcode).toBe("FOREIGN-CODE");

    // The same code is free to use in the owner's own tenant.
    const mine = await seedProduct(owner.tenantId, "MINE-1");
    expect(
      (await assign(owner, { productId: mine, barcode: "FOREIGN-CODE" })).status
    ).toBe(200);
  });
});
