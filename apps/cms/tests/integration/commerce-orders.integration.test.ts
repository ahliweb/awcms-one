/**
 * `commerce` customers & orders integration (Issue #29, awcms-one epic #21)
 * — the order path exercised against a REAL migrated database through
 * `tests/integration/harness.ts`, the way `commerce-catalog` (#23) and
 * `commerce-marketing` (#26) already are. Gated on `DATABASE_URL`; skips
 * cleanly without one.
 *
 * Issue #29's acceptance list names exactly these, and every one of them is
 * a property only a real database can prove:
 *
 *   - create order → stock decremented (an UPDATE under RLS, inside the same
 *     transaction as the INSERT);
 *   - double submit with the same idempotency key → the SAME order, and
 *     stock decremented once (the shared `awcms_idempotency_keys` store);
 *   - tracking with the wrong phone → `null` (the route maps it to the one
 *     neutral 404 an unknown code also gets);
 *   - the expire job restocks;
 *   - RLS: tenant B cannot see tenant A's order even with the right pair.
 *
 * The end-to-end proof in PR #42's body covered these by hand against a
 * seeded server; this file is what keeps them true after the next change.
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
import {
  createOrderFromCart,
  expireOrdersForTenant,
  fetchOrderForTracking
} from "../../src/modules/commerce/application/order-directory";
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

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const ACTOR = "33333333-3333-3333-3333-333333333333";

const NOW = new Date("2026-09-16T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

async function seedTenant(id: string, code: string): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-ORDER",
  name: "Mie Gacoan",
  slug: "mie-gacoan-jw13",
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

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

/** The store must offer self-pickup + manual QRIS for the order below to be placeable at all. */
async function enableSelfPickupAndQris(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Uji",
    shipping: { selfPickup: true },
    payment: { manualQris: { active: true, mediaObjectId: null } }
  });
  if (!validated.valid) {
    throw new Error(JSON.stringify(validated.errors));
  }
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, ACTOR, validated.value)
  );
}

async function seedActiveProduct(tenantId: string): Promise<string> {
  const product = await inTenant(tenantId, (tx) =>
    createProduct(tx, tenantId, ACTOR, BASE_PRODUCT)
  );
  await inTenant(
    tenantId,
    (tx) =>
      tx`UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}`
  );
  return product.id;
}

async function stockOf(tenantId: string, productId: string): Promise<number> {
  const rows = (await inTenant(
    tenantId,
    (tx) =>
      tx`SELECT stock FROM awcms_commerce_products WHERE id = ${productId}`
  )) as { stock: number }[];
  return rows[0]!.stock;
}

function orderInput(
  productId: string,
  overrides: Partial<CreateOrderInput> = {}
): CreateOrderInput {
  return {
    idempotencyKey: "11111111-2222-4333-8444-555555555555",
    customer: { name: "Siti", phone: "0812-3456-7890", email: null },
    address: null,
    lines: [
      { productId, variantId: null, quantity: 2, serviceFormValues: null }
    ],
    shipping: { method: "self_pickup" },
    payment: { method: "manual_qris" },
    voucherCode: null,
    insurance: false,
    notes: null,
    ...overrides
  };
}

suite("commerce orders integration (Issue #29)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-a");
    await seedTenant(TENANT_B, "tenant-b");
    await enableSelfPickupAndQris(TENANT_A);
  }, 30000);

  test("create order → stock decremented; the same idempotency key replays the SAME order without a second decrement", async () => {
    const productId = await seedActiveProduct(TENANT_A);

    const first = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId),
        NOW
      )
    );
    expect(first.kind).toBe("created");
    if (first.kind !== "created") return;

    expect(first.order.status).toBe("pending_payment");
    expect(first.order.subtotal).toBe("20000.00");
    expect(first.order.total).toBe("20000.00");
    expect(first.order.customer.phoneMasked).not.toContain("3456");
    expect(await stockOf(TENANT_A, productId)).toBe(8);

    const replay = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId),
        NOW
      )
    );
    expect(replay.kind).toBe("replayed");
    if (replay.kind !== "replayed") return;
    expect(replay.order.orderCode).toBe(first.order.orderCode);
    expect(await stockOf(TENANT_A, productId)).toBe(8);

    // A different key IS a second order, and it decrements again.
    const second = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId, {
          idempotencyKey: "66666666-7777-4888-8999-000000000000"
        }),
        NOW
      )
    );
    expect(second.kind).toBe("created");
    expect(await stockOf(TENANT_A, productId)).toBe(6);
  }, 30000);

  test("a quantity above stock is refused as cart_changed, and nothing is written", async () => {
    const productId = await seedActiveProduct(TENANT_A);

    const outcome = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId, {
          lines: [
            {
              productId,
              variantId: null,
              quantity: 11,
              serviceFormValues: null
            }
          ]
        }),
        NOW
      )
    );
    expect(outcome.kind).toBe("cart_changed");
    if (outcome.kind === "cart_changed") {
      expect(outcome.quote.canCheckout).toBe(false);
      expect(outcome.quote.lines[0]?.status).not.toBe("ok");
    }
    expect(await stockOf(TENANT_A, productId)).toBe(10);
    const orders = (await inTenant(
      TENANT_A,
      (tx) => tx`SELECT count(*)::int AS n FROM awcms_commerce_orders`
    )) as { n: number }[];
    expect(orders[0]!.n).toBe(0);
  }, 30000);

  test("tracking answers only for the right (code, phone) pair — wrong phone and wrong code look identical", async () => {
    const productId = await seedActiveProduct(TENANT_A);
    const created = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId),
        NOW
      )
    );
    if (created.kind !== "created") throw new Error(created.kind);
    const code = created.order.orderCode;

    const right = await inTenant(TENANT_A, (tx) =>
      fetchOrderForTracking(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        code,
        "+6281234567890"
      )
    );
    expect(right?.orderCode).toBe(code);
    // Payment instructions are present while the order is still payable.
    expect(right?.status).toBe("pending_payment");

    const wrongPhone = await inTenant(TENANT_A, (tx) =>
      fetchOrderForTracking(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        code,
        "+6289999999999"
      )
    );
    const wrongCode = await inTenant(TENANT_A, (tx) =>
      fetchOrderForTracking(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        "BJM-20260916-ZZZZ",
        "+6281234567890"
      )
    );
    expect(wrongPhone).toBeNull();
    expect(wrongCode).toBeNull();
  }, 30000);

  test("the expire job moves an elapsed pending_payment order to expired and restocks it", async () => {
    const productId = await seedActiveProduct(TENANT_A);
    const created = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId),
        NOW
      )
    );
    if (created.kind !== "created") throw new Error(created.kind);
    expect(await stockOf(TENANT_A, productId)).toBe(8);

    // Not yet: the window is measured from the order's own expires_at.
    const early = await expireOrdersForTenant(getRuntimeSql(), TENANT_A, NOW);
    expect(early.expiredCount).toBe(0);

    const late = await expireOrdersForTenant(
      getRuntimeSql(),
      TENANT_A,
      new Date(NOW.getTime() + 24 * 7 * HOUR)
    );
    expect(late.expiredCount).toBe(1);
    expect(await stockOf(TENANT_A, productId)).toBe(10);

    const tracked = await inTenant(TENANT_A, (tx) =>
      fetchOrderForTracking(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        created.order.orderCode,
        "+6281234567890"
      )
    );
    expect(tracked?.status).toBe("expired");

    // Idempotent: nothing left to expire.
    const again = await expireOrdersForTenant(
      getRuntimeSql(),
      TENANT_A,
      new Date(NOW.getTime() + 24 * 7 * HOUR)
    );
    expect(again.expiredCount).toBe(0);
  }, 30000);

  test("RLS: tenant B cannot read tenant A's order even with the right code and phone", async () => {
    const productId = await seedActiveProduct(TENANT_A);
    const created = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId),
        NOW
      )
    );
    if (created.kind !== "created") throw new Error(created.kind);

    const fromB = await inTenant(TENANT_B, (tx) =>
      fetchOrderForTracking(
        tx,
        TENANT_B,
        mediaLibraryPortAdapter,
        created.order.orderCode,
        "+6281234567890"
      )
    );
    expect(fromB).toBeNull();

    const countB = (await inTenant(
      TENANT_B,
      (tx) => tx`SELECT count(*)::int AS n FROM awcms_commerce_orders`
    )) as { n: number }[];
    expect(countB[0]!.n).toBe(0);
  }, 30000);
});
