/**
 * `GET /api/v1/commerce/inventory/items` and the `orphans` section of
 * `GET /api/v1/commerce/inventory/reconciliation` through the REAL route
 * handlers (Issue #283, ADR-0038 addendum): permission enforcement
 * (`commerce.inventory.read`), input validation, the SKU -> ledger-reference
 * answer, and tenant isolation. WORLD 2 (see `harness.ts`): runs against the
 * migrated `DATABASE_URL` database; skips cleanly when it is not migrated.
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
  getHandlerDatabaseClient,
  integrationEnabled,
  invoke,
  resetHandlerDatabase,
  teardownHandlerDatabase
} from "./harness";
import { hashSessionToken } from "../../src/lib/auth/session-token";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { POST as setupInitialize } from "../../src/pages/api/v1/setup/initialize";
import { POST as authLogin } from "../../src/pages/api/v1/auth/login";
import { GET as getItems } from "../../src/pages/api/v1/commerce/inventory/items";
import { GET as getReconciliation } from "../../src/pages/api/v1/commerce/inventory/reconciliation";
import { createProduct } from "../../src/modules/commerce/application/product-directory";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";

const OWNER_PASSWORD = "integration-test-owner-password";

type Principal = { tenantId: string; token: string; tenantUserId: string };
type Envelope<T = unknown> = {
  success: boolean;
  data: T;
  error?: { code: string };
};
type Item = {
  itemType: string;
  itemRef: string;
  sku: string | null;
  name: string;
  variantName: string | null;
  unitCode: string;
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

/** A tenant user holding ONLY the given permission keys, with a live session. */
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

const PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-RT283",
  name: "Teh Tarik",
  slug: "teh-tarik-rt283",
  description: null,
  digitalNote: null,
  price: "10000.00",
  discountPercent: 0,
  stock: 0,
  label: null,
  labelColor: null,
  priceLevel2: null,
  priceLevel3: null,
  priceLevel4: null,
  costPrice: null,
  minPurchase: 1,
  weightGrams: 250,
  manualRating: null,
  manualSoldCount: 0,
  withInsurance: false,
  insuranceRequired: false,
  insuranceFee: null,
  promoBannerShow: false,
  promoBannerTitle: null,
  promoBannerSubtitle: null,
  promoBannerBadge: null,
  promoBannerIcon: null,
  promoBannerColor: null,
  sizeChartType: "none",
  sizeChartMediaId: null,
  sizeChartDetails: null,
  serviceForm: null,
  subscriptionPeriod: null,
  downloadLink: null,
  allowDp: false,
  allowFreeShipping: true,
  variantAttributes: null,
  isFeatured: false,
  isRecommended: false
};

const suite = integrationEnabled ? describe : describe.skip;
let handlerReady = false;

function skipUnlessHandlerReady(): boolean {
  if (handlerReady) return false;
  console.warn(
    "[skip] handler database is not migrated - run 'bun run db:migrate' against DATABASE_URL."
  );
  return true;
}

suite("commerce inventory items lookup routes (Issue #283)", () => {
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

  async function world() {
    const owner = await bootstrapOwner();
    const product = await withTenantOrThrow(
      getHandlerDatabaseClient(),
      owner.tenantId,
      (tx) => createProduct(tx, owner.tenantId, owner.tenantUserId, PRODUCT)
    );
    await getHandlerAdminSql()`
      UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}
    `;
    const variants = (await getHandlerAdminSql()`
      INSERT INTO awcms_commerce_product_variants (tenant_id, product_id, name, value, stock, sku)
      VALUES (${owner.tenantId}, ${product.id}, 'Size', 'L', 0, 'SKU-RT283-L')
      RETURNING id
    `) as { id: string }[];
    return { owner, productId: product.id, variantId: variants[0]!.id };
  }

  const call = (who: Principal, query = "") =>
    invoke<Envelope<{ items: Item[]; nextCursor: string | null }>>(getItems, {
      method: "GET",
      path: `/api/v1/commerce/inventory/items${query}`,
      headers: headers(who)
    });

  test("returns the ledger reference for a SKU to a holder of commerce.inventory.read", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner, variantId } = await world();
    const clerk = await seedPrincipal(owner.tenantId, "clerk", [
      "commerce.inventory.read"
    ]);

    const res = await call(clerk, "?q=rt283-l");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([
      {
        itemType: "commerce.variant",
        itemRef: variantId,
        sku: "SKU-RT283-L",
        name: "Teh Tarik",
        variantName: "L",
        unitCode: "unit"
      }
    ]);
    expect(res.body.data.nextCursor).toBeNull();
  }, 60000);

  test("refuses a caller without the permission and without a session", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner } = await world();
    const outsider = await seedPrincipal(owner.tenantId, "no-inv", [
      "commerce.products.read"
    ]);

    expect((await call(outsider)).status).toBe(403);
    const anonymous = await invoke<Envelope>(getItems, {
      method: "GET",
      path: "/api/v1/commerce/inventory/items",
      headers: { "x-awcms-tenant-id": owner.tenantId }
    });
    expect(anonymous.status).toBe(401);

    const reconciliation = await invoke<Envelope>(getReconciliation, {
      method: "GET",
      path: "/api/v1/commerce/inventory/reconciliation",
      headers: headers(outsider)
    });
    expect(reconciliation.status).toBe(403);
  }, 60000);

  test("validates q, limit and cursor", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner } = await world();
    for (const query of [
      `?q=${"x".repeat(101)}`,
      "?limit=0",
      "?limit=51",
      "?limit=abc",
      "?cursor=garbage"
    ]) {
      const res = await call(owner, query);
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("VALIDATION_ERROR");
    }
    expect((await call(owner, "?limit=50")).status).toBe(200);
  }, 60000);

  test("another tenant's principal sees none of this tenant's catalogue", async () => {
    if (skipUnlessHandlerReady()) return;
    const { owner } = await world();
    const otherTenant = crypto.randomUUID();
    await getHandlerAdminSql()`
      INSERT INTO awcms_tenants (id, tenant_code, tenant_name)
      VALUES (${otherTenant}, 'other-283', 'Other 283')
    `;
    const spy = await seedPrincipal(otherTenant, "spy", [
      "commerce.inventory.read"
    ]);

    const res = await call(spy, "?q=rt283");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect((await call(owner, "?q=rt283")).body.data.items).toHaveLength(1);
  }, 60000);
});
