/**
 * `commerce` payment-gateway webhook intake + reconcile (Issue #113,
 * contract #106's D2) — exercised against a REAL migrated database through
 * `tests/integration/harness.ts`, the same pattern
 * `commerce-payment-gateway.integration.test.ts` (Issue #110) already
 * follows. Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * Covers the properties only a real database can prove:
 *
 *   - a verified webhook event ("paid") applies through
 *     `applyVerifiedWebhookEvent`: the order transitions to `paid` and a
 *     `awcms_commerce_payment_events` row is stored;
 *   - replaying the SAME event (same tenant/provider/event_key) is a no-op
 *     — still `{kind: "replay"}`, no duplicate event row, order stays
 *     `paid` (no double side effect);
 *   - `reconcilePendingSessionsForTenant` with the `log` provider marks a
 *     pending order's gateway session (and the order) paid;
 *   - RLS: a webhook-endpoint token belonging to tenant B resolves ONLY
 *     tenant B, so a payload naming tenant A's own `provider_ref` has zero
 *     effect on tenant A's order (the session lookup, tenant-scoped under
 *     FORCE RLS, simply finds nothing).
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
  applyVerifiedWebhookEvent,
  resolveWebhookEndpoint
} from "../../src/modules/commerce/application/payment-webhook-intake";
import { reconcilePendingSessionsForTenant } from "../../src/modules/commerce/application/payment-reconcile";
import { createWebhookEndpoint } from "../../src/modules/commerce/application/webhook-endpoint-directory";
import { createLogPaymentGatewayProvider } from "../../src/modules/commerce/infrastructure/log-payment-gateway-provider";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import type { CreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "44444444-4444-4444-4444-444444444444";
const TENANT_B = "55555555-5555-5555-5555-555555555555";
const ACTOR = "66666666-6666-6666-6666-666666666666";
const ACTOR_B = "77777777-7777-7777-7777-777777777777";
const NOW = new Date();

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

async function seedTenantUser(
  tenantId: string,
  actorId: string
): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Webhook Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`webhook-actor-${actorId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${actorId}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function enableSelfPickupAndGateway(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Uji Webhook",
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
  sku: "SKU-WEBHOOK",
  name: "Mie Gacoan",
  slug: "mie-gacoan-webhook",
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
    customer: { name: "Budi", phone: "0813-1111-2222", email: null },
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
): Promise<string> {
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
  return result.order.orderCode;
}

async function createLiveSession(
  tenantId: string,
  orderCode: string,
  auth: CreateGatewaySessionAuth
) {
  const outcome = await createGatewaySession(
    getRuntimeSql(),
    tenantId,
    orderCode,
    auth,
    PROVIDER,
    "log"
  );
  if (outcome.kind !== "created") {
    throw new Error(
      `expected a created session, got ${JSON.stringify(outcome)}`
    );
  }
  return outcome.session;
}

async function fetchOrderStatus(
  tenantId: string,
  orderCode: string
): Promise<string> {
  const rows = (await inTenant(
    tenantId,
    (tx) =>
      tx`SELECT status FROM awcms_commerce_orders WHERE order_code = ${orderCode}`
  )) as { status: string }[];
  return rows[0]!.status;
}

async function countPaymentEvents(
  tenantId: string,
  eventKey: string
): Promise<number> {
  const rows = (await inTenant(
    tenantId,
    (tx) =>
      tx`SELECT count(*)::int AS count FROM awcms_commerce_payment_events WHERE tenant_id = ${tenantId} AND event_key = ${eventKey}`
  )) as { count: number }[];
  return rows[0]!.count;
}

suite(
  "commerce payment-gateway webhook intake + reconcile (Issue #113)",
  () => {
    const previousGatewayEnv = process.env.COMMERCE_PAYMENT_GATEWAY;
    const previousPublicUrlEnv = process.env.COMMERCE_STOREFRONT_PUBLIC_URL;

    beforeAll(async () => {
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
      await seedTenant(TENANT_A, "tenant-wh-a");
      await seedTenant(TENANT_B, "tenant-wh-b");
      await enableSelfPickupAndGateway(TENANT_A);
      await enableSelfPickupAndGateway(TENANT_B);
      await seedTenantUser(TENANT_A, ACTOR);
    }, 30000);

    test("endpoint token -> webhook paid -> order transitions to paid + payment event stored", async () => {
      const productId = await seedActiveProduct(TENANT_A, "SKU-WH-PAID");
      const orderCode = await createGatewayOrder(TENANT_A, productId);
      const session = await createLiveSession(TENANT_A, orderCode, {
        kind: "phone",
        phone: "081311112222"
      });

      const { token } = await inTenant(TENANT_A, (tx) =>
        createWebhookEndpoint(tx, TENANT_A, ACTOR, "midtrans", "test-endpoint")
      );

      const resolved = await resolveWebhookEndpoint(getRuntimeSql(), token);
      expect(resolved).not.toBeNull();
      expect(resolved!.tenantId).toBe(TENANT_A);
      expect(resolved!.provider).toBe("midtrans");

      const eventKey = `${session.providerRef}:200`;
      const result = await applyVerifiedWebhookEvent(
        getRuntimeSql(),
        TENANT_A,
        {
          provider: "log",
          eventKey,
          providerRef: session.providerRef,
          status: "paid",
          payload: { fixture: "paid" }
        }
      );

      expect(result).toEqual({ kind: "applied", orderAffected: true });
      expect(await fetchOrderStatus(TENANT_A, orderCode)).toBe("paid");
      expect(await countPaymentEvents(TENANT_A, eventKey)).toBe(1);
    });

    test("replaying the same event is a no-op — still processed once, no duplicate event, order stays paid", async () => {
      const productId = await seedActiveProduct(TENANT_A, "SKU-WH-REPLAY");
      const orderCode = await createGatewayOrder(TENANT_A, productId);
      const session = await createLiveSession(TENANT_A, orderCode, {
        kind: "phone",
        phone: "081311112222"
      });

      const eventKey = `${session.providerRef}:200`;
      const payload = { fixture: "paid" };

      const first = await applyVerifiedWebhookEvent(getRuntimeSql(), TENANT_A, {
        provider: "log",
        eventKey,
        providerRef: session.providerRef,
        status: "paid",
        payload
      });
      expect(first).toEqual({ kind: "applied", orderAffected: true });

      const replay = await applyVerifiedWebhookEvent(
        getRuntimeSql(),
        TENANT_A,
        {
          provider: "log",
          eventKey,
          providerRef: session.providerRef,
          status: "paid",
          payload
        }
      );
      expect(replay).toEqual({ kind: "replay" });

      expect(await fetchOrderStatus(TENANT_A, orderCode)).toBe("paid");
      expect(await countPaymentEvents(TENANT_A, eventKey)).toBe(1);
    });

    test("commerce:payments:reconcile with the log provider marks a pending order's session (and the order) paid", async () => {
      const productId = await seedActiveProduct(TENANT_A, "SKU-RECONCILE");
      const orderCode = await createGatewayOrder(TENANT_A, productId);
      await createLiveSession(TENANT_A, orderCode, {
        kind: "phone",
        phone: "081311112222"
      });

      // The reconcile job only looks at sessions older than 2 minutes — back-date
      // this row's `created_at` directly (the row was just inserted for real).
      await inTenant(
        TENANT_A,
        (tx) =>
          tx`
          UPDATE awcms_commerce_payment_gateway_sessions
          SET created_at = created_at - interval '5 minutes'
          WHERE order_id = (SELECT id FROM awcms_commerce_orders WHERE order_code = ${orderCode})
        `
      );

      // A provider instance whose clock is 3 minutes ahead of the session's own
      // embedded creation timestamp — enough for `log`'s own `fetchStatus` to
      // answer "paid" (it requires >= 60 REAL seconds elapsed since creation,
      // per `LOG_PROVIDER_PAID_AFTER_MS`).
      const reconcileProvider = createLogPaymentGatewayProvider({
        storefrontPublicUrl: "https://toko.example.com",
        now: () => new Date(NOW.getTime() + 3 * 60_000)
      });

      const result = await reconcilePendingSessionsForTenant(
        getRuntimeSql(),
        TENANT_A,
        new Date(NOW.getTime() + 3 * 60_000),
        reconcileProvider,
        "log",
        "test-correlation"
      );

      expect(result.markedPaid).toBe(1);
      expect(await fetchOrderStatus(TENANT_A, orderCode)).toBe("paid");

      const sessionRows = (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT status FROM awcms_commerce_payment_gateway_sessions WHERE order_id = (SELECT id FROM awcms_commerce_orders WHERE order_code = ${orderCode})`
      )) as { status: string }[];
      expect(sessionRows[0]!.status).toBe("paid");
    });

    test("amount guard: a verified 'paid' whose gross_amount differs from the order total is recorded as amount_mismatch, audited, and never marks the order paid", async () => {
      const productId = await seedActiveProduct(TENANT_A, "SKU-WH-MISMATCH");
      const orderCode = await createGatewayOrder(TENANT_A, productId);
      const session = await createLiveSession(TENANT_A, orderCode, {
        kind: "phone",
        phone: "081311112222"
      });

      const eventKey = `${session.providerRef}:200`;
      const result = await applyVerifiedWebhookEvent(
        getRuntimeSql(),
        TENANT_A,
        {
          provider: "log",
          eventKey,
          providerRef: session.providerRef,
          status: "paid",
          grossAmount: "1.00", // the order is 10000.00
          payload: { fixture: "mismatch", gross_amount: "1.00" }
        }
      );

      expect(result.kind).toBe("amount_mismatch");
      expect(await fetchOrderStatus(TENANT_A, orderCode)).toBe(
        "pending_payment"
      );

      const events = (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT outcome FROM awcms_commerce_payment_events WHERE tenant_id = ${TENANT_A} AND event_key = ${eventKey}`
      )) as { outcome: string }[];
      expect(events).toEqual([{ outcome: "amount_mismatch" }]);

      // Not a terminal provider failure — the session is left pending.
      const sessionRows = (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT status FROM awcms_commerce_payment_gateway_sessions WHERE id = ${session.id}`
      )) as { status: string }[];
      expect(sessionRows[0]!.status).toBe("pending");

      const audit = (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT count(*)::int AS count FROM awcms_audit_events WHERE tenant_id = ${TENANT_A} AND resource_type = 'order' AND message LIKE '%REJECTED%'`
      )) as { count: number }[];
      expect(audit[0]!.count).toBe(1);

      // A later CORRECT callback (different event_key) still settles it.
      const correct = await applyVerifiedWebhookEvent(
        getRuntimeSql(),
        TENANT_A,
        {
          provider: "log",
          eventKey: `${session.providerRef}:200:retry`,
          providerRef: session.providerRef,
          status: "paid",
          grossAmount: "10000.00",
          payload: { fixture: "paid" }
        }
      );
      expect(correct).toEqual({ kind: "applied", orderAffected: true });
      expect(await fetchOrderStatus(TENANT_A, orderCode)).toBe("paid");
    });

    test("RLS: a webhook-endpoint token belonging to tenant B cannot pay/affect an order belonging to tenant A", async () => {
      const productId = await seedActiveProduct(TENANT_A, "SKU-RLS-WH");
      const orderCode = await createGatewayOrder(TENANT_A, productId);
      const session = await createLiveSession(TENANT_A, orderCode, {
        kind: "phone",
        phone: "081311112222"
      });

      // A tenant-B webhook endpoint token, resolving to TENANT_B.
      await seedTenantUser(TENANT_B, ACTOR_B);
      const { token: tenantBToken } = await inTenant(TENANT_B, (tx) =>
        createWebhookEndpoint(tx, TENANT_B, ACTOR_B, "midtrans", null)
      );

      const resolved = await resolveWebhookEndpoint(
        getRuntimeSql(),
        tenantBToken
      );
      expect(resolved).not.toBeNull();
      expect(resolved!.tenantId).toBe(TENANT_B);

      // Attacker/misrouted payload references TENANT A's own session
      // provider_ref, but under TENANT B's resolved tenant context.
      const eventKey = `${session.providerRef}:200`;
      const result = await applyVerifiedWebhookEvent(
        getRuntimeSql(),
        resolved!.tenantId,
        {
          provider: "log",
          eventKey,
          providerRef: session.providerRef,
          status: "paid",
          payload: { fixture: "cross-tenant-attempt" }
        }
      );

      // The session lookup is tenant-scoped under FORCE RLS — tenant B's
      // context simply cannot see tenant A's session row, so this is recorded
      // as an unattached event (order_id NULL) and nothing else happens.
      expect(result).toEqual({ kind: "ignored" });
      expect(await fetchOrderStatus(TENANT_A, orderCode)).toBe(
        "pending_payment"
      );

      const tenantAEventCount = await countPaymentEvents(TENANT_A, eventKey);
      expect(tenantAEventCount).toBe(0);
    });
  }
);
