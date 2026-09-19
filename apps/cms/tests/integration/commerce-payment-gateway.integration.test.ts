/**
 * `commerce` payment-gateway integration (Issue #110, contract #106's D2/D3)
 * — exercised against a REAL migrated database through
 * `tests/integration/harness.ts`, the same pattern
 * `commerce-shipping-rates.integration.test.ts` already follows. Gated on
 * `DATABASE_URL`; skips cleanly without one.
 *
 * Covers the properties only a real database can prove:
 *
 *   - `createGatewaySession` is idempotent with the `log` provider (a
 *     repeat call for the same order reuses the still-live session, never a
 *     second row / second provider call);
 *   - phone-based auth and Bearer-based auth both resolve the same order;
 *   - a mismatched auth (wrong phone, or a bearer for a DIFFERENT order's
 *     owner) answers the neutral `not_found`, indistinguishable from an
 *     unknown order code;
 *   - a non-gateway-payment order answers `not_applicable`;
 *   - the webhook-endpoint token round-trips through the SECURITY DEFINER
 *     `awcms_resolve_commerce_webhook_endpoint` lookup, and a revoked token
 *     no longer resolves;
 *   - RLS: tenant B cannot see tenant A's gateway session or webhook
 *     endpoint even with the right id, and the bootstrap lookup only ever
 *     resolves through the function, never a direct SELECT as `awcms_app`.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { createProduct } from "../../src/modules/commerce/application/product-directory";
import { createOrderFromCart } from "../../src/modules/commerce/application/order-directory";
import {
  createGatewaySession,
  type CreateGatewaySessionAuth
} from "../../src/modules/commerce/application/payment-gateway-directory";
import {
  createWebhookEndpoint,
  listWebhookEndpoints,
  revokeWebhookEndpoint
} from "../../src/modules/commerce/application/webhook-endpoint-directory";
import { hashWebhookEndpointToken } from "../../src/lib/auth/webhook-endpoint-token";
import {
  generateCustomerSessionToken,
  hashCustomerSessionToken
} from "../../src/modules/commerce/domain/customer-session-token";
import { createLogPaymentGatewayProvider } from "../../src/modules/commerce/infrastructure/log-payment-gateway-provider";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import type { CreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import {
  appRoleActivated,
  getAdminSql,
  getAppRoleSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const ACTOR = "33333333-3333-3333-3333-333333333333";
const NOW = new Date("2026-09-19T10:00:00.000Z");

const PROVIDER = createLogPaymentGatewayProvider({
  storefrontPublicUrl: "https://toko.example.com",
  now: () => NOW
});

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function seedTenant(id: string, code: string): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

/** `awcms_commerce_webhook_endpoints.created_by` is a hard FK to `awcms_tenant_users` — this seeds the minimal identity/profile/tenant-user chain so `createWebhookEndpoint`'s own actor id is a real row, not just an audit-log-only value the way `ACTOR` is used everywhere else in this file. */
async function seedTenantUser(
  tenantId: string,
  actorId: string
): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Gateway Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`actor-${actorId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${actorId}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function enableSelfPickupQrisAndGateway(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Uji",
    shipping: { selfPickup: true },
    payment: {
      manualQris: { active: true, mediaObjectId: null },
      gateway: { enabled: true }
    }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, ACTOR, validated.value)
  );
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-GATEWAY",
  name: "Mie Gacoan",
  slug: "mie-gacoan-gateway",
  description: null,
  digitalNote: null,
  price: "10000.00",
  discountPercent: 0,
  stock: 10,
  label: null,
  labelColor: null,
  priceLevel2: null,
  priceLevel3: null,
  priceLevel4: null,
  costPrice: null,
  minPurchase: 1,
  weightGrams: 350,
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

async function seedActiveProduct(
  tenantId: string,
  sku: string
): Promise<string> {
  const product = await inTenant(tenantId, (tx) =>
    createProduct(tx, tenantId, ACTOR, {
      ...BASE_PRODUCT,
      sku,
      slug: `${sku}-slug`
    })
  );
  await inTenant(
    tenantId,
    (tx) =>
      tx`UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}`
  );
  return product.id;
}

function orderInput(
  productId: string,
  overrides: Partial<CreateOrderInput> = {}
): CreateOrderInput {
  return {
    idempotencyKey: crypto.randomUUID(),
    customer: { name: "Siti", phone: "0812-3456-7890", email: null },
    address: null,
    lines: [
      { productId, variantId: null, quantity: 1, serviceFormValues: null }
    ],
    shipping: { method: "self_pickup" },
    payment: { method: "gateway" },
    voucherCode: null,
    insurance: false,
    notes: null,
    affiliateCode: null,
    ...overrides
  };
}

async function createGatewayOrder(
  tenantId: string,
  productId: string,
  overrides: Partial<CreateOrderInput> = {}
): Promise<{ orderCode: string; customerId: string }> {
  const result = await inTenant(tenantId, (tx) =>
    createOrderFromCart(
      tx,
      tenantId,
      mediaLibraryPortAdapter,
      orderInput(productId, overrides),
      NOW
    )
  );
  if (result.kind !== "created") {
    throw new Error(`expected order creation, got ${JSON.stringify(result)}`);
  }
  const rows = (await inTenant(
    tenantId,
    (tx) =>
      tx`SELECT customer_id FROM awcms_commerce_orders WHERE order_code = ${result.order.orderCode}`
  )) as { customer_id: string }[];
  return {
    orderCode: result.order.orderCode,
    customerId: rows[0]!.customer_id
  };
}

/** Inserts a live customer bearer session directly (no HTTP/OTP round trip needed for this test's purposes) — returns the RAW bearer token. */
async function seedCustomerBearerSession(
  tenantId: string,
  customerId: string
): Promise<string> {
  const accountRows = (await inTenant(
    tenantId,
    (tx) =>
      tx`
        INSERT INTO awcms_commerce_customer_accounts
          (tenant_id, customer_id, email_normalized, history_from)
        VALUES (${tenantId}, ${customerId}, ${`${customerId}@example.com`}, now())
        RETURNING id
      `
  )) as { id: string }[];
  const accountId = accountRows[0]!.id;

  const token = generateCustomerSessionToken();
  const tokenHash = hashCustomerSessionToken(token);
  const expiresAt = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);

  await inTenant(
    tenantId,
    (tx) =>
      tx`
        INSERT INTO awcms_commerce_customer_sessions
          (tenant_id, account_id, token_hash, expires_at)
        VALUES (${tenantId}, ${accountId}, ${tokenHash}, ${expiresAt})
      `
  );

  return token;
}

function bearerAuth(token: string): CreateGatewaySessionAuth {
  return {
    kind: "bearer",
    request: new Request("https://cms.example.com/x", {
      headers: { authorization: `Bearer ${token}` }
    })
  };
}

suite("commerce payment-gateway integration (Issue #110)", () => {
  const previousGatewayEnv = process.env.COMMERCE_PAYMENT_GATEWAY;
  const previousPublicUrlEnv = process.env.COMMERCE_STOREFRONT_PUBLIC_URL;

  beforeAll(async () => {
    // `createOrderFromCart`'s own re-quote (inside its write transaction)
    // gates `payment.method: "gateway"` on `isPaymentGatewayProviderConfigured()`
    // — a pure `process.env` read (`cart-quote-service.ts`'s header) — so a
    // real provider must be "configured" for the orders this suite seeds to
    // validate at all. Restored in `afterAll` so this file never leaks its
    // env into a sibling integration test file run in the same process.
    process.env.COMMERCE_PAYMENT_GATEWAY = "log";
    process.env.COMMERCE_STOREFRONT_PUBLIC_URL = "https://toko.example.com";
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
    if (previousGatewayEnv === undefined) {
      delete process.env.COMMERCE_PAYMENT_GATEWAY;
    } else {
      process.env.COMMERCE_PAYMENT_GATEWAY = previousGatewayEnv;
    }
    if (previousPublicUrlEnv === undefined) {
      delete process.env.COMMERCE_STOREFRONT_PUBLIC_URL;
    } else {
      process.env.COMMERCE_STOREFRONT_PUBLIC_URL = previousPublicUrlEnv;
    }
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-a");
    await seedTenant(TENANT_B, "tenant-b");
    await enableSelfPickupQrisAndGateway(TENANT_A);
    await enableSelfPickupQrisAndGateway(TENANT_B);
    // Only TENANT_A ever creates a webhook endpoint in this suite (the RLS
    // test only LISTS as tenant B, never creates) — a second tenant-user row
    // reusing the same `ACTOR` id for TENANT_B would collide on the primary
    // key.
    await seedTenantUser(TENANT_A, ACTOR);
  }, 30000);

  test("createGatewaySession is idempotent with the log provider — a repeat call reuses the live session", async () => {
    const productId = await seedActiveProduct(TENANT_A, "SKU-IDEM");
    const { orderCode } = await createGatewayOrder(TENANT_A, productId);

    const first = await createGatewaySession(
      getRuntimeSql(),
      TENANT_A,
      orderCode,
      { kind: "phone", phone: "081234567890" },
      PROVIDER,
      "log"
    );
    expect(first.kind).toBe("created");
    if (first.kind !== "created") return;

    const second = await createGatewaySession(
      getRuntimeSql(),
      TENANT_A,
      orderCode,
      { kind: "phone", phone: "081234567890" },
      PROVIDER,
      "log"
    );
    expect(second.kind).toBe("reused");
    if (second.kind !== "reused") return;
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.providerRef).toBe(first.session.providerRef);

    const rows = (await inTenant(
      TENANT_A,
      (tx) =>
        tx`SELECT count(*)::int AS count FROM awcms_commerce_payment_gateway_sessions WHERE order_id = (SELECT id FROM awcms_commerce_orders WHERE order_code = ${orderCode})`
    )) as { count: number }[];
    expect(rows[0]!.count).toBe(1);
  });

  test("phone-based auth creates a session; the SAME order via Bearer reuses it", async () => {
    const productId = await seedActiveProduct(TENANT_A, "SKU-PHONE-BEARER");
    const { orderCode, customerId } = await createGatewayOrder(
      TENANT_A,
      productId
    );
    const token = await seedCustomerBearerSession(TENANT_A, customerId);

    const byPhone = await createGatewaySession(
      getRuntimeSql(),
      TENANT_A,
      orderCode,
      { kind: "phone", phone: "081234567890" },
      PROVIDER,
      "log"
    );
    expect(byPhone.kind).toBe("created");

    const byBearer = await createGatewaySession(
      getRuntimeSql(),
      TENANT_A,
      orderCode,
      bearerAuth(token),
      PROVIDER,
      "log"
    );
    expect(byBearer.kind).toBe("reused");
  });

  test("a wrong phone answers the neutral not_found, same as an unknown order code", async () => {
    const productId = await seedActiveProduct(TENANT_A, "SKU-WRONG-PHONE");
    const { orderCode } = await createGatewayOrder(TENANT_A, productId);

    const wrongPhone = await createGatewaySession(
      getRuntimeSql(),
      TENANT_A,
      orderCode,
      { kind: "phone", phone: "089999999999" },
      PROVIDER,
      "log"
    );
    expect(wrongPhone.kind).toBe("not_found");

    const unknownOrder = await createGatewaySession(
      getRuntimeSql(),
      TENANT_A,
      "NO-SUCH-ORDER",
      { kind: "phone", phone: "081234567890" },
      PROVIDER,
      "log"
    );
    expect(unknownOrder.kind).toBe("not_found");
  });

  test("a live bearer session for a DIFFERENT order's owner answers not_found, never leaking that the order exists", async () => {
    const productId = await seedActiveProduct(TENANT_A, "SKU-OTHER-OWNER");
    const { orderCode } = await createGatewayOrder(TENANT_A, productId, {
      customer: { name: "Order Owner", phone: "0812-0000-0001", email: null }
    });

    // A different customer's account/bearer entirely.
    const otherCustomerRows = (await inTenant(
      TENANT_A,
      (tx) =>
        tx`
          INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
          VALUES (${TENANT_A}, 'Someone Else', '081200000002')
          RETURNING id
        `
    )) as { id: string }[];
    const token = await seedCustomerBearerSession(
      TENANT_A,
      otherCustomerRows[0]!.id
    );

    const result = await createGatewaySession(
      getRuntimeSql(),
      TENANT_A,
      orderCode,
      bearerAuth(token),
      PROVIDER,
      "log"
    );
    expect(result.kind).toBe("not_found");
  });

  test("an invalid/expired bearer answers unauthenticated", async () => {
    const productId = await seedActiveProduct(TENANT_A, "SKU-BAD-BEARER");
    const { orderCode } = await createGatewayOrder(TENANT_A, productId);

    const result = await createGatewaySession(
      getRuntimeSql(),
      TENANT_A,
      orderCode,
      bearerAuth("cs_" + "a".repeat(43)),
      PROVIDER,
      "log"
    );
    expect(result.kind).toBe("unauthenticated");
  });

  test("a non-gateway-payment order answers not_applicable", async () => {
    const productId = await seedActiveProduct(TENANT_A, "SKU-NOT-GATEWAY");
    const result = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId, { payment: { method: "manual_qris" } }),
        NOW
      )
    );
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;

    const outcome = await createGatewaySession(
      getRuntimeSql(),
      TENANT_A,
      result.order.orderCode,
      { kind: "phone", phone: "081234567890" },
      PROVIDER,
      "log"
    );
    expect(outcome.kind).toBe("not_applicable");
  });

  test("RLS: tenant B cannot see tenant A's gateway session even with the right order code/phone", async () => {
    const productId = await seedActiveProduct(TENANT_A, "SKU-RLS-SESSION");
    const { orderCode } = await createGatewayOrder(TENANT_A, productId);

    const created = await createGatewaySession(
      getRuntimeSql(),
      TENANT_A,
      orderCode,
      { kind: "phone", phone: "081234567890" },
      PROVIDER,
      "log"
    );
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;

    const rows = (await inTenant(
      TENANT_B,
      (tx) =>
        tx`SELECT id FROM awcms_commerce_payment_gateway_sessions WHERE id = ${created.session.id}`
    )) as { id: string }[];
    expect(rows).toHaveLength(0);

    // The order itself is invisible from tenant B either, so the same
    // createGatewaySession call from tenant B answers not_found.
    const fromTenantB = await createGatewaySession(
      getRuntimeSql(),
      TENANT_B,
      orderCode,
      { kind: "phone", phone: "081234567890" },
      PROVIDER,
      "log"
    );
    expect(fromTenantB.kind).toBe("not_found");
  });

  test("webhook-endpoint token round-trips through the SECURITY DEFINER lookup function, and a revoked token no longer resolves", async () => {
    if (!appRoleActivated) return;

    const { endpoint, token } = await inTenant(TENANT_A, (tx) =>
      createWebhookEndpoint(tx, TENANT_A, ACTOR, "midtrans", "prod")
    );
    expect(token.startsWith("awcmswh_")).toBe(true);

    const app = getAppRoleSql();
    const tokenHash = hashWebhookEndpointToken(token);

    // A direct SELECT with no app.current_tenant_id set returns zero rows
    // (fail-closed default GUC + FORCE RLS) — the function is the ONLY
    // sanctioned bootstrap read.
    const direct = (await app`
      SELECT id FROM awcms_commerce_webhook_endpoints WHERE token_hash = ${tokenHash}
    `) as { id: string }[];
    expect(direct).toHaveLength(0);

    const resolved = (await app`
      SELECT * FROM awcms_resolve_commerce_webhook_endpoint(${tokenHash})
    `) as { tenant_id: string; provider: string }[];
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.tenant_id).toBe(TENANT_A);
    expect(resolved[0]!.provider).toBe("midtrans");
    // Never exposes a secret/identifying column beyond tenant_id/provider.
    expect(resolved[0]).not.toHaveProperty("token_hash");
    expect(resolved[0]).not.toHaveProperty("label");
    expect(resolved[0]).not.toHaveProperty("created_by");

    await inTenant(TENANT_A, (tx) =>
      revokeWebhookEndpoint(tx, TENANT_A, endpoint.id)
    );

    const afterRevoke = (await app`
      SELECT * FROM awcms_resolve_commerce_webhook_endpoint(${tokenHash})
    `) as { tenant_id: string; provider: string }[];
    expect(afterRevoke).toHaveLength(0);
  });

  test("RLS: tenant B cannot see tenant A's webhook endpoint through listWebhookEndpoints", async () => {
    await inTenant(TENANT_A, (tx) =>
      createWebhookEndpoint(
        tx,
        TENANT_A,
        ACTOR,
        "midtrans",
        "tenant-a-endpoint"
      )
    );

    const tenantAList = await inTenant(TENANT_A, (tx) =>
      listWebhookEndpoints(tx, TENANT_A)
    );
    expect(tenantAList).toHaveLength(1);

    const tenantBList = await inTenant(TENANT_B, (tx) =>
      listWebhookEndpoints(tx, TENANT_B)
    );
    expect(tenantBList).toHaveLength(0);
  });
});
