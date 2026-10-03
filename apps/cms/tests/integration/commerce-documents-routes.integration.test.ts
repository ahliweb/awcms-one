/**
 * The commerce document lifecycle through the REAL route handlers (Issue #286,
 * epic #281 and #280, ADR-0029) - the HTTP half that
 * `commerce-documents.integration.test.ts` (which drives the directory
 * functions) cannot see: route wiring (`defineTenantRoute`, ABAC, the
 * `documents` feature gate, body validation, `Idempotency-Key`, the error ->
 * status mapping, the render headers) with real session/permission machinery.
 *
 * WORLD 2 (see `harness.ts`): handlers call `getDatabaseClient()` internally,
 * so this file runs against the migrated `DATABASE_URL` database and seeds
 * through `getHandlerAdminSql()`. The owner comes from the real setup + login
 * endpoints (every permission granted); the other principals are seeded with
 * EXACTLY the permission keys under test, so a 403 below means "that key was
 * missing", never "the actor had nothing":
 *
 *   - the feature gate answers 409 FEATURE_DISABLED until the tenant opts in;
 *   - a POS-only user holds none of the document keys (default deny);
 *   - held sales: ownership (a neutral 404 for another cashier's cart, the
 *     supervisor key as the only way through), `scope=all` needs the key;
 *   - conversion needs BOTH `quotation_conversions.create` and
 *     `pos_due.create`, and a retry returns the same order;
 *   - a foreign tenant's id is the same 404 as an unknown one (BOLA);
 *   - the render route: the print page is escaped and served under a locked-down
 *     CSP, the text rendering is plain, an unknown format is a 400.
 */
import type { APIContext, APIRoute } from "astro";
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
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import {
  GET as listHeld,
  POST as postHold
} from "../../src/pages/api/v1/commerce/held-sales/index";
import { POST as postResume } from "../../src/pages/api/v1/commerce/held-sales/[id]/resume";
import { POST as postDiscard } from "../../src/pages/api/v1/commerce/held-sales/[id]/discard";
import {
  GET as listQuotations,
  POST as postQuotation
} from "../../src/pages/api/v1/commerce/quotations/index";
import { GET as getQuotation } from "../../src/pages/api/v1/commerce/quotations/[id]/index";
import { POST as postRevision } from "../../src/pages/api/v1/commerce/quotations/[id]/versions";
import { POST as postAction } from "../../src/pages/api/v1/commerce/quotations/[id]/actions/[action]";
import { POST as postConvert } from "../../src/pages/api/v1/commerce/quotations/[id]/convert";
import {
  GET as listWorkOrders,
  POST as postWorkOrder
} from "../../src/pages/api/v1/commerce/work-orders/index";
import {
  GET as getWorkOrder,
  PATCH as patchWorkOrder
} from "../../src/pages/api/v1/commerce/work-orders/[id]";
import {
  GET as listDocuments,
  POST as postDocument
} from "../../src/pages/api/v1/commerce/documents/index";
import { GET as getDocument } from "../../src/pages/api/v1/commerce/documents/[id]/index";
import { GET as renderDocument } from "../../src/pages/api/v1/commerce/documents/[id]/render";
import { POST as postPosOrder } from "../../src/pages/api/v1/commerce/pos/orders/index";
import { createProduct } from "../../src/modules/commerce/application/product-directory";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";

const OWNER_PASSWORD = "integration-test-owner-password";
const PHONE = "081234567890";

type Principal = { tenantId: string; token: string; tenantUserId: string };

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

function headers(
  who: Principal,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-awcms-tenant-id": who.tenantId,
    authorization: `Bearer ${who.token}`,
    ...extra
  };
}

type Envelope<T = unknown> = {
  success: boolean;
  data: T;
  error?: { code: string; details?: unknown };
};

const key = () => ({ "idempotency-key": crypto.randomUUID() });

/** As `invoke`, but hands back the raw body text (the render route is not JSON). */
async function invokeText(
  handler: APIRoute,
  options: {
    path: string;
    headers: Record<string, string>;
    params: Record<string, string>;
  }
): Promise<{ status: number; text: string; response: Response }> {
  const url = new URL(`http://integration.test${options.path}`);
  const context = {
    request: new Request(url.toString(), { headers: options.headers }),
    url,
    params: options.params,
    locals: {},
    cookies: createCookieJar(),
    clientAddress: "127.0.0.1"
  } as unknown as APIContext;
  const response = await handler(context);
  return { status: response.status, text: await response.text(), response };
}

async function setFeatures(owner: Principal, documents: boolean) {
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
        documents
      }
    }
  });
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-DR",
  name: "Servis Rutin",
  slug: "servis-rutin-dr",
  description: null,
  digitalNote: null,
  price: "10000.00",
  discountPercent: 0,
  stock: 100,
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

async function seedProduct(owner: Principal): Promise<string> {
  const db = getHandlerDatabaseClient();
  const settings = validateStoreSettingsInput({
    storeName: "Toko <Rute>",
    shipping: { selfPickup: true },
    payment: { manualQris: { active: true, mediaObjectId: null } }
  });
  if (!settings.valid) throw new Error(JSON.stringify(settings.errors));
  await withTenantOrThrow(db, owner.tenantId, (tx) =>
    saveStoreSettings(tx, owner.tenantId, owner.tenantUserId, settings.value)
  );
  const product = await withTenantOrThrow(db, owner.tenantId, (tx) =>
    createProduct(tx, owner.tenantId, owner.tenantUserId, BASE_PRODUCT)
  );
  await withTenantOrThrow(
    db,
    owner.tenantId,
    (tx) =>
      tx`UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}`
  );
  return product.id;
}

const CASHIER_HOLD = [
  "commerce.held_sales.read",
  "commerce.held_sales.create",
  "commerce.held_sales.update"
];

const suite = integrationEnabled ? describe : describe.skip;

let handlerReady = false;

function skipUnlessHandlerReady(): boolean {
  if (handlerReady) return false;
  console.warn(
    "[skip] handler database is not migrated - run 'bun run db:migrate' against DATABASE_URL."
  );
  return true;
}

suite("commerce documents through the route handlers (Issue #286)", () => {
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

  async function hold(who: Principal, productId: string) {
    return invoke<Envelope<{ id: string; status: string }>>(postHold, {
      method: "POST",
      path: "/api/v1/commerce/held-sales",
      headers: headers(who, key()),
      body: {
        label: "Meja 4",
        lines: [{ productId, quantity: 2 }],
        customer: { name: "Budi", phone: PHONE }
      }
    });
  }

  function resume(who: Principal, id: string, idempotency = key()) {
    return invoke<
      Envelope<{
        status: string;
        cart: {
          lines: {
            productId: string;
            variantId: string | null;
            quantity: number;
          }[];
        };
      }>
    >(postResume, {
      method: "POST",
      path: `/api/v1/commerce/held-sales/${id}/resume`,
      headers: headers(who, idempotency),
      params: { id },
      body: {}
    });
  }

  function quote(who: Principal, productId: string, quantity = 2) {
    return invoke<
      Envelope<{ id: string; number: string; total: string; status: string }>
    >(postQuotation, {
      method: "POST",
      path: "/api/v1/commerce/quotations",
      headers: headers(who, key()),
      body: {
        customer: { name: "Pak Budi", phone: PHONE },
        lines: [{ productId, quantity }]
      }
    });
  }

  function quotationAction(who: Principal, id: string, action: string) {
    return invoke<Envelope<{ status: string; acceptedVersion: number | null }>>(
      postAction,
      {
        method: "POST",
        path: `/api/v1/commerce/quotations/${id}/actions/${action}`,
        headers: headers(who, key()),
        params: { id, action },
        body: {}
      }
    );
  }

  test("the documents feature gate: every route is 409 FEATURE_DISABLED until the tenant opts in", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    const productId = await seedProduct(owner);
    const someId = "00000000-0000-4000-8000-000000000000";

    const attempts = [
      await invoke<Envelope>(listHeld, {
        path: "/api/v1/commerce/held-sales",
        headers: headers(owner)
      }),
      await hold(owner, productId),
      await invoke<Envelope>(listQuotations, {
        path: "/api/v1/commerce/quotations",
        headers: headers(owner)
      }),
      await quote(owner, productId),
      await invoke<Envelope>(getQuotation, {
        path: `/api/v1/commerce/quotations/${someId}`,
        headers: headers(owner),
        params: { id: someId }
      }),
      await invoke<Envelope>(listWorkOrders, {
        path: "/api/v1/commerce/work-orders",
        headers: headers(owner)
      }),
      await invoke<Envelope>(postWorkOrder, {
        method: "POST",
        path: "/api/v1/commerce/work-orders",
        headers: headers(owner, key()),
        body: { title: "x" }
      }),
      await invoke<Envelope>(listDocuments, {
        path: "/api/v1/commerce/documents",
        headers: headers(owner)
      }),
      await invoke<Envelope>(postDocument, {
        method: "POST",
        path: "/api/v1/commerce/documents",
        headers: headers(owner, key()),
        body: { orderId: someId, docType: "invoice" }
      })
    ];
    for (const result of attempts) {
      expect(result.status).toBe(409);
      expect(result.body.error?.code).toBe("FEATURE_DISABLED");
    }

    // The settings route is the opt-in; afterwards the same call works.
    expect((await setFeatures(owner, true)).status).toBe(200);
    expect((await hold(owner, productId)).status).toBe(201);
    // ... and it can be turned off again.
    expect((await setFeatures(owner, false)).status).toBe(200);
    expect((await hold(owner, productId)).status).toBe(409);
  });

  test("default deny: a POS-only user holds none of the document keys", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    const productId = await seedProduct(owner);
    await setFeatures(owner, true);
    const posOnly = await seedPrincipal(owner.tenantId, "pos-only", [
      "commerce.pos.create"
    ]);
    const someId = "00000000-0000-4000-8000-000000000000";

    const denied = [
      await hold(posOnly, productId),
      await invoke<Envelope>(listHeld, {
        path: "/api/v1/commerce/held-sales",
        headers: headers(posOnly)
      }),
      await quote(posOnly, productId),
      await invoke<Envelope>(listQuotations, {
        path: "/api/v1/commerce/quotations",
        headers: headers(posOnly)
      }),
      await quotationAction(posOnly, someId, "send"),
      await invoke<Envelope>(postConvert, {
        method: "POST",
        path: `/api/v1/commerce/quotations/${someId}/convert`,
        headers: headers(posOnly, key()),
        params: { id: someId },
        body: {}
      }),
      await invoke<Envelope>(postWorkOrder, {
        method: "POST",
        path: "/api/v1/commerce/work-orders",
        headers: headers(posOnly, key()),
        body: { title: "x" }
      }),
      await invoke<Envelope>(listWorkOrders, {
        path: "/api/v1/commerce/work-orders",
        headers: headers(posOnly)
      }),
      await invoke<Envelope>(postDocument, {
        method: "POST",
        path: "/api/v1/commerce/documents",
        headers: headers(posOnly, key()),
        body: { orderId: someId, docType: "invoice" }
      }),
      await invoke<Envelope>(listDocuments, {
        path: "/api/v1/commerce/documents",
        headers: headers(posOnly)
      })
    ];
    for (const result of denied) {
      expect(result.status).toBe(403);
    }
  });

  test("each document key is its own authority: quoting does not convert, holding does not issue", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    const productId = await seedProduct(owner);
    await setFeatures(owner, true);
    const quoter = await seedPrincipal(owner.tenantId, "quoter", [
      "commerce.quotations.read",
      "commerce.quotations.create",
      "commerce.quotations.update"
    ]);
    const created = await quote(quoter, productId);
    expect(created.status).toBe(201);
    expect(created.body.data.number).toBe(
      "QUO-" + new Date().getUTCFullYear() + "-000001"
    );
    expect(created.body.data.total).toBe("20000.00");
    expect(
      (await quotationAction(quoter, created.body.data.id, "send")).status
    ).toBe(200);
    const accepted = await quotationAction(
      quoter,
      created.body.data.id,
      "accept"
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.acceptedVersion).toBe(1);

    const convert = await invoke<Envelope>(postConvert, {
      method: "POST",
      path: `/api/v1/commerce/quotations/${created.body.data.id}/convert`,
      headers: headers(quoter, key()),
      params: { id: created.body.data.id },
      body: {}
    });
    expect(convert.status).toBe(403);
    const issuer = await seedPrincipal(owner.tenantId, "holder", CASHIER_HOLD);
    const issue = await invoke<Envelope>(postDocument, {
      method: "POST",
      path: "/api/v1/commerce/documents",
      headers: headers(issuer, key()),
      body: {
        orderId: "00000000-0000-4000-8000-000000000000",
        docType: "invoice"
      }
    });
    expect(issue.status).toBe(403);
  });

  test("held sales: ownership is a neutral 404, the supervisor key is the only way through", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    const productId = await seedProduct(owner);
    await setFeatures(owner, true);
    const cashierA = await seedPrincipal(
      owner.tenantId,
      "cashier-a",
      CASHIER_HOLD
    );
    const cashierB = await seedPrincipal(
      owner.tenantId,
      "cashier-b",
      CASHIER_HOLD
    );
    const supervisor = await seedPrincipal(owner.tenantId, "supervisor", [
      ...CASHIER_HOLD,
      "commerce.held_sales.approve"
    ]);

    const held = await hold(cashierA, productId);
    expect(held.status).toBe(201);
    const id = held.body.data.id;
    // The body of a hold carries no cart back.
    expect(JSON.stringify(held.body)).not.toContain(PHONE);

    // A lists only their own; B sees nothing; B cannot ask for everyone's.
    const listA = await invoke<Envelope<{ items: { id: string }[] }>>(
      listHeld,
      {
        path: "/api/v1/commerce/held-sales",
        headers: headers(cashierA)
      }
    );
    expect(listA.body.data.items.map((item) => item.id)).toEqual([id]);
    const listB = await invoke<Envelope<{ items: unknown[] }>>(listHeld, {
      path: "/api/v1/commerce/held-sales",
      headers: headers(cashierB)
    });
    expect(listB.body.data.items).toHaveLength(0);
    const scopeAll = await invoke<Envelope>(listHeld, {
      path: "/api/v1/commerce/held-sales?scope=all",
      headers: headers(cashierB)
    });
    expect(scopeAll.status).toBe(403);
    const supervised = await invoke<Envelope<{ items: unknown[] }>>(listHeld, {
      path: "/api/v1/commerce/held-sales?scope=all",
      headers: headers(supervisor)
    });
    expect(supervised.status).toBe(200);
    expect(supervised.body.data.items).toHaveLength(1);

    // B resuming or discarding A's cart is the same 404 as an unknown id.
    const bResume = await resume(cashierB, id);
    expect(bResume.status).toBe(404);
    const unknown = await resume(
      cashierB,
      "00000000-0000-4000-8000-000000000000"
    );
    expect(unknown.status).toBe(404);
    expect(bResume.body.error?.code).toBe(unknown.body.error?.code);
    const bDiscard = await invoke<Envelope>(postDiscard, {
      method: "POST",
      path: `/api/v1/commerce/held-sales/${id}/discard`,
      headers: headers(cashierB, key()),
      params: { id },
      body: {}
    });
    expect(bDiscard.status).toBe(404);
    const malformed = await resume(cashierB, "not-a-uuid");
    expect(malformed.status).toBe(404);

    // A resumes their own: lines back, single-use, replayable on the same key.
    const idem = key();
    const mine = await resume(cashierA, id, idem);
    expect(mine.status).toBe(200);
    expect(mine.body.data.cart.lines).toEqual([
      { productId, variantId: null, quantity: 2 }
    ]);
    expect((await resume(cashierA, id, idem)).status).toBe(200);
    const second = await resume(cashierA, id);
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe("HELD_SALE_NOT_HELD");

    // The supervisor may resume another cashier's cart.
    const another = await hold(cashierB, productId);
    const overridden = await resume(supervisor, another.body.data.id);
    expect(overridden.status).toBe(200);
  });

  test("a held sale of ANOTHER tenant is the same 404 as an unknown one (BOLA)", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setFeatures(owner, true);
    const admin = getHandlerAdminSql();
    const otherTenant = "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b";
    await admin`
      INSERT INTO awcms_tenants (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${otherTenant}, 'other-doc', 'Other', 'Other', 'active', 'en', 'light')
    `;
    const rows = (await admin`
      INSERT INTO awcms_commerce_held_sales (tenant_id, owner_tenant_user_id, cart, line_count, expires_at)
      VALUES (${otherTenant}, ${owner.tenantUserId}, '{"lines":[{"productId":"x"}]}'::jsonb, 1, now() + interval '1 day')
      RETURNING id
    `) as { id: string }[];
    const foreignId = rows[0]!.id;

    const resumed = await resume(owner, foreignId);
    const unknown = await resume(owner, "00000000-0000-4000-8000-000000000000");
    expect(resumed.status).toBe(404);
    expect(resumed.status).toBe(unknown.status);
    expect(resumed.body.error?.code).toBe(unknown.body.error?.code);
    const discarded = await invoke<Envelope>(postDiscard, {
      method: "POST",
      path: `/api/v1/commerce/held-sales/${foreignId}/discard`,
      headers: headers(owner, key()),
      params: { id: foreignId },
      body: {}
    });
    expect(discarded.status).toBe(404);
    // Untouched.
    const still =
      (await admin`SELECT status FROM awcms_commerce_held_sales WHERE id = ${foreignId}`) as {
        status: string;
      }[];
    expect(still[0]!.status).toBe("held");
  });

  test("conversion needs both keys; a retry and a second caller get the same order", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    const productId = await seedProduct(owner);
    await setFeatures(owner, true);
    const created = await quote(owner, productId);
    const id = created.body.data.id;
    await quotationAction(owner, id, "send");

    // Not accepted yet.
    const early = await invoke<Envelope>(postConvert, {
      method: "POST",
      path: `/api/v1/commerce/quotations/${id}/convert`,
      headers: headers(owner, key()),
      params: { id },
      body: {}
    });
    expect(early.status).toBe(409);
    expect(early.body.error?.code).toBe("QUOTATION_NOT_ACCEPTED");
    expect((await quotationAction(owner, id, "accept")).status).toBe(200);

    const withoutDue = await seedPrincipal(owner.tenantId, "convert-only", [
      "commerce.quotation_conversions.create"
    ]);
    const refused = await invoke<Envelope>(postConvert, {
      method: "POST",
      path: `/api/v1/commerce/quotations/${id}/convert`,
      headers: headers(withoutDue, key()),
      params: { id },
      body: {}
    });
    expect(refused.status).toBe(403);

    const converter = await seedPrincipal(owner.tenantId, "converter", [
      "commerce.quotation_conversions.create",
      "commerce.pos_due.create"
    ]);
    const idem = key();
    const first = await invoke<
      Envelope<{
        order: {
          id: string;
          total: string;
          status: string;
          paymentStatus: string;
        };
        quotation: { status: string; convertedOrderId: string };
        alreadyConverted: boolean;
      }>
    >(postConvert, {
      method: "POST",
      path: `/api/v1/commerce/quotations/${id}/convert`,
      headers: headers(converter, idem),
      params: { id },
      body: {}
    });
    expect(first.status).toBe(201);
    expect(first.body.data.order.total).toBe("20000.00");
    expect(first.body.data.order.paymentStatus).toBe("unpaid");
    expect(first.body.data.quotation.status).toBe("converted");
    expect(first.body.data.quotation.convertedOrderId).toBe(
      first.body.data.order.id
    );

    const retry = await invoke<Envelope<{ order: { id: string } }>>(
      postConvert,
      {
        method: "POST",
        path: `/api/v1/commerce/quotations/${id}/convert`,
        headers: headers(converter, idem),
        params: { id },
        body: {}
      }
    );
    expect(retry.status).toBe(200);
    expect(retry.body.data.order.id).toBe(first.body.data.order.id);
    const other = await invoke<
      Envelope<{ order: { id: string }; alreadyConverted: boolean }>
    >(postConvert, {
      method: "POST",
      path: `/api/v1/commerce/quotations/${id}/convert`,
      headers: headers(owner, key()),
      params: { id },
      body: {}
    });
    expect(other.status).toBe(200);
    expect(other.body.data.alreadyConverted).toBe(true);
    expect(other.body.data.order.id).toBe(first.body.data.order.id);

    const orders =
      (await getHandlerAdminSql()`SELECT count(*)::int AS n FROM awcms_commerce_orders`) as {
        n: number;
      }[];
    expect(orders[0]!.n).toBe(1);

    // The reverse lookup: a work order can name the converted quotation.
    const wo = await invoke<
      Envelope<{ quotationVersion: number | null; orderId: string | null }>
    >(postWorkOrder, {
      method: "POST",
      path: "/api/v1/commerce/work-orders",
      headers: headers(owner, key()),
      body: {
        title: "Servis lanjutan",
        quotationId: id,
        orderId: first.body.data.order.id
      }
    });
    expect(wo.status).toBe(201);
    expect(wo.body.data.quotationVersion).toBe(1);
    expect(wo.body.data.orderId).toBe(first.body.data.order.id);
  });

  test("quotation routes: revise adds a version, an unknown action and id are 404, an expired accept is 409", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    const productId = await seedProduct(owner);
    await setFeatures(owner, true);
    const created = await quote(owner, productId);
    const id = created.body.data.id;

    const revised = await invoke<
      Envelope<{ currentVersion: number; total: string; versions: unknown[] }>
    >(postRevision, {
      method: "POST",
      path: `/api/v1/commerce/quotations/${id}/versions`,
      headers: headers(owner, key()),
      params: { id },
      body: { lines: [{ productId, quantity: 4 }] }
    });
    expect(revised.status).toBe(201);
    expect(revised.body.data.currentVersion).toBe(2);
    expect(revised.body.data.total).toBe("40000.00");
    expect(revised.body.data.versions).toHaveLength(2);

    const read = await invoke<Envelope<{ versions: unknown[] }>>(getQuotation, {
      path: `/api/v1/commerce/quotations/${id}`,
      headers: headers(owner),
      params: { id }
    });
    expect(read.body.data.versions).toHaveLength(2);

    expect((await quotationAction(owner, id, "explode")).status).toBe(404);
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await quotationAction(owner, missing, "send")).status).toBe(404);
    // An illegal move is a conflict, not a 500.
    const illegal = await quotationAction(owner, id, "accept");
    expect(illegal.status).toBe(409);
    expect(illegal.body.error?.code).toBe("QUOTATION_STATUS_CONFLICT");

    // A lapsed offer cannot be accepted: age the version, then accept.
    await quotationAction(owner, id, "send");
    await getHandlerAdminSql()`
      ALTER TABLE awcms_commerce_quotation_versions DISABLE TRIGGER awcms_commerce_quotation_versions_append_only
    `;
    try {
      await getHandlerAdminSql()`
        UPDATE awcms_commerce_quotation_versions
        SET valid_until = now() - interval '1 hour', created_at = now() - interval '2 hours'
        WHERE quotation_id = ${id}
      `;
    } finally {
      await getHandlerAdminSql()`
        ALTER TABLE awcms_commerce_quotation_versions ENABLE TRIGGER awcms_commerce_quotation_versions_append_only
      `;
    }
    const expired = await quotationAction(owner, id, "accept");
    expect(expired.status).toBe(409);
    expect(expired.body.error?.code).toBe("QUOTATION_EXPIRED");
  });

  test("work orders through the routes: create, list, get, legal and illegal moves, closed", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    await setFeatures(owner, true);
    const created = await invoke<
      Envelope<{ id: string; number: string; status: string }>
    >(postWorkOrder, {
      method: "POST",
      path: "/api/v1/commerce/work-orders",
      headers: headers(owner, key()),
      body: { title: "Servis AC", priority: "urgent" }
    });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe("received");
    const id = created.body.data.id;
    const patch = (body: Record<string, unknown>) =>
      invoke<Envelope<{ status: string; events: unknown[] }>>(patchWorkOrder, {
        method: "PATCH",
        path: `/api/v1/commerce/work-orders/${id}`,
        headers: headers(owner, key()),
        params: { id },
        body
      });

    const illegal = await patch({ status: "completed" });
    expect(illegal.status).toBe(409);
    expect(illegal.body.error?.code).toBe("WORK_ORDER_TRANSITION_ILLEGAL");
    expect((await patch({})).status).toBe(400);
    expect((await patch({ status: "in_progress" })).body.data.status).toBe(
      "in_progress"
    );
    expect((await patch({ status: "ready" })).status).toBe(200);
    const done = await patch({ status: "completed", note: "selesai" });
    expect(done.body.data.events).toHaveLength(4);
    const closed = await patch({ status: "in_progress" });
    expect(closed.status).toBe(409);
    expect(closed.body.error?.code).toBe("WORK_ORDER_CLOSED");

    const read = await invoke<Envelope<{ status: string }>>(getWorkOrder, {
      path: `/api/v1/commerce/work-orders/${id}`,
      headers: headers(owner),
      params: { id }
    });
    expect(read.body.data.status).toBe("completed");
    const list = await invoke<Envelope<{ items: unknown[] }>>(listWorkOrders, {
      path: "/api/v1/commerce/work-orders?status=completed",
      headers: headers(owner)
    });
    expect(list.body.data.items).toHaveLength(1);
    expect(
      (
        await invoke<Envelope>(listWorkOrders, {
          path: "/api/v1/commerce/work-orders?status=bogus",
          headers: headers(owner)
        })
      ).status
    ).toBe(400);
    // A foreign reference is a validation error naming only the field sent.
    const badRef = await invoke<Envelope>(postWorkOrder, {
      method: "POST",
      path: "/api/v1/commerce/work-orders",
      headers: headers(owner, key()),
      body: { title: "x", orderId: "00000000-0000-4000-8000-000000000000" }
    });
    expect(badRef.status).toBe(400);
  });

  test("documents: issue, idempotent re-issue, eligibility, and the render contract", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    const productId = await seedProduct(owner);
    await setFeatures(owner, true);
    const sale = await invoke<
      Envelope<{ id: string; orderCode: string; total: string }>
    >(postPosOrder, {
      method: "POST",
      path: "/api/v1/commerce/pos/orders",
      headers: headers(owner, key()),
      body: {
        customer: { name: "Siti <img src=x>", phone: PHONE },
        lines: [{ productId, quantity: 2 }],
        payment: { method: "cash", amountTendered: "50000.00" }
      }
    });
    expect(sale.status).toBe(201);
    const orderId = sale.body.data.id;

    const issueBody = { orderId, docType: "invoice" };
    const issued = await invoke<
      Envelope<{
        id: string;
        number: string;
        total: string;
        contentHash: string;
      }>
    >(postDocument, {
      method: "POST",
      path: "/api/v1/commerce/documents",
      headers: headers(owner, key()),
      body: issueBody
    });
    expect(issued.status).toBe(201);
    const year = new Date().getUTCFullYear();
    expect(issued.body.data.number).toBe(`INV-${year}-000001`);
    expect(issued.body.data.total).toBe(sale.body.data.total);
    expect(issued.body.data.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const again = await invoke<
      Envelope<{ id: string; alreadyIssued: boolean }>
    >(postDocument, {
      method: "POST",
      path: "/api/v1/commerce/documents",
      headers: headers(owner, key()),
      body: issueBody
    });
    expect(again.status).toBe(200);
    expect(again.body.data.alreadyIssued).toBe(true);
    expect(again.body.data.id).toBe(issued.body.data.id);

    const receipt = await invoke<Envelope<{ number: string }>>(postDocument, {
      method: "POST",
      path: "/api/v1/commerce/documents",
      headers: headers(owner, key()),
      body: { orderId, docType: "receipt" }
    });
    expect(receipt.status).toBe(201);
    expect(receipt.body.data.number).toBe(`RCP-${year}-000001`);

    expect(
      (
        await invoke<Envelope>(postDocument, {
          method: "POST",
          path: "/api/v1/commerce/documents",
          headers: headers(owner, key()),
          body: {
            orderId: "00000000-0000-4000-8000-000000000000",
            docType: "invoice"
          }
        })
      ).status
    ).toBe(404);
    expect(
      (
        await invoke<Envelope>(postDocument, {
          method: "POST",
          path: "/api/v1/commerce/documents",
          headers: headers(owner, key()),
          body: { orderId, docType: "quotation" }
        })
      ).status
    ).toBe(400);
    const noKey = await invoke<Envelope>(postDocument, {
      method: "POST",
      path: "/api/v1/commerce/documents",
      headers: headers(owner),
      body: issueBody
    });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error?.code).toBe("IDEMPOTENCY_REQUIRED");

    const id = issued.body.data.id;
    const list = await invoke<Envelope<{ items: { id: string }[] }>>(
      listDocuments,
      {
        path: `/api/v1/commerce/documents?docType=invoice&orderId=${orderId}`,
        headers: headers(owner)
      }
    );
    expect(list.body.data.items.map((item) => item.id)).toEqual([id]);

    const detail = await invoke<
      Envelope<{ snapshot: { customer: { name: string } } }>
    >(getDocument, {
      path: `/api/v1/commerce/documents/${id}`,
      headers: headers(owner),
      params: { id }
    });
    expect(detail.status).toBe(200);

    const html = await invokeText(renderDocument, {
      path: `/api/v1/commerce/documents/${id}/render?format=html&locale=en`,
      headers: headers(owner),
      params: { id }
    });
    expect(html.status).toBe(200);
    expect(html.response.headers.get("content-type")).toContain("text/html");
    expect(html.response.headers.get("content-security-policy")).toContain(
      "default-src 'none'"
    );
    expect(html.response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html.response.headers.get("cache-control")).toContain("no-store");
    expect(html.text).toContain("Sales invoice");
    // The customer name carried markup: escaped, never raw.
    expect(html.text).toContain("Siti &lt;img src=x&gt;");
    expect(html.text).not.toContain("<img src=x>");
    expect(html.text).toContain("Toko &lt;Rute&gt;");

    const text = await invokeText(renderDocument, {
      path: `/api/v1/commerce/documents/${id}/render?format=text`,
      headers: headers(owner),
      params: { id }
    });
    expect(text.response.headers.get("content-type")).toContain("text/plain");
    expect(text.text).toContain("FAKTUR PENJUALAN");
    expect(text.text).toContain(issued.body.data.number);

    const json = await invoke<Envelope<{ id: string }>>(renderDocument, {
      path: `/api/v1/commerce/documents/${id}/render`,
      headers: headers(owner),
      params: { id }
    });
    expect(json.body.data.id).toBe(id);

    const bad = await invokeText(renderDocument, {
      path: `/api/v1/commerce/documents/${id}/render?format=pdf`,
      headers: headers(owner),
      params: { id }
    });
    expect(bad.status).toBe(400);
    const missing = await invokeText(renderDocument, {
      path: "/api/v1/commerce/documents/00000000-0000-4000-8000-000000000000/render",
      headers: headers(owner),
      params: { id: "00000000-0000-4000-8000-000000000000" }
    });
    expect(missing.status).toBe(404);

    // Reading needs the read key; issuing needs the create key - separately.
    const reader = await seedPrincipal(owner.tenantId, "doc-reader", [
      "commerce.documents.read"
    ]);
    expect(
      (
        await invokeText(renderDocument, {
          path: `/api/v1/commerce/documents/${id}/render?format=text`,
          headers: headers(reader),
          params: { id }
        })
      ).status
    ).toBe(200);
    expect(
      (
        await invoke<Envelope>(postDocument, {
          method: "POST",
          path: "/api/v1/commerce/documents",
          headers: headers(reader, key()),
          body: issueBody
        })
      ).status
    ).toBe(403);
  });
});
