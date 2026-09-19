/**
 * POS integration (Issue #116, epic #33 C7, contract #106 D6, ADR-0017) —
 * against a REAL migrated Postgres through `tests/integration/harness.ts`,
 * the same pattern `commerce-orders`/`commerce-feature-toggles` use. Gated
 * on `DATABASE_URL`; skips cleanly without one.
 *
 * Covers exactly the properties only a real database can prove:
 *   - a POS order is `paid` the moment it exists (status, payment_status,
 *     paid_at, `order_events` `pending_payment -> paid` with actor `admin`),
 *     stock is decremented, `channel = 'pos'`, the cashier is stamped, the
 *     `commerce.pos.sale` audit event is written;
 *   - the order appears in POS history (`listPosOrders`, with the date and
 *     cashier filters) and NOT through the storefront paths (anonymous
 *     tracking lookup, bearer account history);
 *   - the walk-in sentinel customer row is created once per tenant and
 *     reused; a phone-identified sale finds/creates by normalised phone and
 *     applies the customer's price level;
 *   - the storefront checkout (`createOrderFromCart`) refuses `cash`;
 *   - an idempotent replay of the same `Idempotency-Key` returns the same
 *     order and creates no second row; a different payload under the same
 *     key is `IdempotencyPayloadMismatchError`;
 *   - a short cash tender is `InsufficientTenderError` and writes nothing;
 *   - with the `pos` feature disabled the owner-route gate answers
 *     `409 FEATURE_DISABLED`.
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
  fetchOrderForTracking,
  IdempotencyPayloadMismatchError,
  listOrdersForAccount,
  listOrdersForAdmin
} from "../../src/modules/commerce/application/order-directory";
import {
  createPosOrder,
  listPosOrders,
  POS_SALE_AUDIT_ACTION
} from "../../src/modules/commerce/application/pos-directory";
import { requireCommerceFeatureForOwnerRoute } from "../../src/modules/commerce/application/commerce-feature-gate";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import {
  InsufficientTenderError,
  POS_WALK_IN_CUSTOMER_NAME,
  type CreatePosOrderInput
} from "../../src/modules/commerce/domain/pos-order-validation";
import { POS_WALK_IN_CUSTOMER_SENTINEL_PHONE } from "../../src/modules/commerce/domain/phone-normalisation";
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

const TENANT_A = "66666666-6666-4666-8666-666666666666";
const CASHIER_A = "77777777-7777-4777-8777-777777777777";
const CASHIER_B = "78787878-7878-4787-8787-787878787878";
const ACTOR = CASHIER_A;

const NOW = new Date("2026-09-19T10:00:00.000Z");

async function seedTenant(id: string, code: string): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function enableSelfPickupAndQris(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Kasir",
    shipping: { selfPickup: true },
    payment: { manualQris: { active: true, mediaObjectId: null } }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, ACTOR, validated.value)
  );
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-POS",
  name: "Kopi Susu",
  slug: "kopi-susu-pos",
  description: null,
  digitalNote: null,
  price: "15000.00",
  discountPercent: 0,
  stock: 20,
  label: null,
  labelColor: null,
  priceLevel2: "12000.00",
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
  return Number(rows[0]!.stock);
}

function posInput(
  productId: string,
  overrides: Partial<CreatePosOrderInput> = {}
): CreatePosOrderInput {
  return {
    idempotencyKey: "aaaaaaaa-1111-4222-8333-444444444444",
    customer: { name: null, phone: null },
    lines: [{ productId, variantId: null, quantity: 2 }],
    payment: { method: "cash", amountTendered: "50000.00" },
    notes: null,
    ...overrides
  };
}

suite("commerce POS integration (Issue #116)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-pos");
    await enableSelfPickupAndQris(TENANT_A);
  }, 30000);

  test("a cash counter sale is paid immediately, decrements stock, stamps channel/cashier, and is audited", async () => {
    const productId = await seedActiveProduct(TENANT_A);
    expect(await stockOf(TENANT_A, productId)).toBe(20);

    const outcome = await inTenant(TENANT_A, (tx) =>
      createPosOrder(
        tx,
        TENANT_A,
        CASHIER_A,
        mediaLibraryPortAdapter,
        posInput(productId),
        NOW,
        "corr-pos-1"
      )
    );
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") return;

    // Money as strings, computed in cents: 2 × 15000.00 = 30000.00; tendered
    // 50000.00 → change 20000.00.
    expect(outcome.order.subtotal).toBe("30000.00");
    expect(outcome.order.total).toBe("30000.00");
    expect(outcome.order.change).toBe("20000.00");
    expect(outcome.order.amountTendered).toBe("50000.00");
    expect(outcome.order.status).toBe("paid");
    expect(outcome.order.paymentStatus).toBe("paid");
    expect(outcome.order.paymentMethod).toBe("cash");
    expect(outcome.order.channel).toBe("pos");
    expect(outcome.order.shippingMethod).toBe("self_pickup");
    expect(outcome.order.cashierTenantUserId).toBe(CASHIER_A);
    expect(outcome.order.paidAt).not.toBeNull();
    expect(outcome.order.customer.name).toBe(POS_WALK_IN_CUSTOMER_NAME);
    expect(outcome.order.customer.phone).toBe(
      POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
    );

    expect(await stockOf(TENANT_A, productId)).toBe(18);

    const row = (await inTenant(
      TENANT_A,
      (tx) => tx`
        SELECT status, payment_status, payment_method, channel, shipping_method,
               pos_cashier_tenant_user_id, paid_at, total
        FROM awcms_commerce_orders WHERE order_code = ${outcome.order.orderCode}
      `
    )) as {
      status: string;
      payment_status: string;
      payment_method: string;
      channel: string;
      shipping_method: string;
      pos_cashier_tenant_user_id: string;
      paid_at: Date | null;
      total: string;
    }[];
    expect(row[0]).toMatchObject({
      status: "paid",
      payment_status: "paid",
      payment_method: "cash",
      channel: "pos",
      shipping_method: "self_pickup",
      pos_cashier_tenant_user_id: CASHIER_A
    });
    expect(row[0]!.paid_at).not.toBeNull();

    const events = (await inTenant(
      TENANT_A,
      (tx) => tx`
        SELECT e.from_status, e.to_status, e.actor
        FROM awcms_commerce_order_events e
        JOIN awcms_commerce_orders o ON o.id = e.order_id
        WHERE o.order_code = ${outcome.order.orderCode}
        -- Both rows are written in ONE transaction and share now(), and id
        -- is a random uuid — so order by the creation row's NULL from_status
        -- first rather than by time.
        ORDER BY e.from_status NULLS FIRST
      `
    )) as { from_status: string | null; to_status: string; actor: string }[];
    expect(events).toEqual([
      { from_status: null, to_status: "pending_payment", actor: "admin" },
      { from_status: "pending_payment", to_status: "paid", actor: "admin" }
    ]);

    const audit = (await inTenant(
      TENANT_A,
      (tx) => tx`
        SELECT action, actor_tenant_user_id, attributes
        FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND module_key = 'commerce'
          AND action = ${POS_SALE_AUDIT_ACTION}
      `
    )) as {
      action: string;
      actor_tenant_user_id: string;
      attributes: Record<string, unknown>;
    }[];
    expect(audit.length).toBe(1);
    expect(audit[0]!.actor_tenant_user_id).toBe(CASHIER_A);
    expect(audit[0]!.attributes).toMatchObject({
      orderCode: outcome.order.orderCode,
      total: "30000.00",
      method: "cash",
      change: "20000.00",
      walkIn: true
    });
    // No PII in the audit attributes.
    expect(JSON.stringify(audit[0]!.attributes)).not.toContain(
      POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
    );
  });

  test("the sale is in POS history (with date/cashier filters) and NOT on the storefront paths", async () => {
    const productId = await seedActiveProduct(TENANT_A);

    const posSale = await inTenant(TENANT_A, (tx) =>
      createPosOrder(
        tx,
        TENANT_A,
        CASHIER_A,
        mediaLibraryPortAdapter,
        posInput(productId),
        NOW
      )
    );
    expect(posSale.kind).toBe("created");
    if (posSale.kind !== "created") return;

    // A control storefront order in the same tenant — must NOT show in POS
    // history and MUST still show through the storefront tracking lookup.
    const storefrontInput: CreateOrderInput = {
      idempotencyKey: "bbbbbbbb-1111-4222-8333-444444444444",
      customer: { name: "Siti", phone: "0812-3456-7891", email: null },
      address: null,
      lines: [
        { productId, variantId: null, quantity: 1, serviceFormValues: null }
      ],
      shipping: { method: "self_pickup" },
      payment: { method: "manual_qris" },
      voucherCode: null,
      insurance: false,
      notes: null,
      affiliateCode: null
    };
    const storefrontOrder = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        storefrontInput,
        NOW
      )
    );
    expect(storefrontOrder.kind).toBe("created");
    if (storefrontOrder.kind !== "created") return;

    const history = await inTenant(TENANT_A, (tx) =>
      listPosOrders(tx, TENANT_A, null)
    );
    expect(history.items.map((item) => item.orderCode)).toEqual([
      posSale.order.orderCode
    ]);
    expect(history.items[0]).toMatchObject({
      status: "paid",
      paymentMethod: "cash",
      cashierTenantUserId: CASHIER_A,
      total: "30000.00"
    });
    expect(history.nextCursor).toBeNull();

    // Cashier filter: another cashier sees nothing, this one sees the sale.
    const otherCashier = await inTenant(TENANT_A, (tx) =>
      listPosOrders(tx, TENANT_A, null, { cashierTenantUserId: CASHIER_B })
    );
    expect(otherCashier.items).toEqual([]);
    const thisCashier = await inTenant(TENANT_A, (tx) =>
      listPosOrders(tx, TENANT_A, null, { cashierTenantUserId: CASHIER_A })
    );
    expect(thisCashier.items.length).toBe(1);

    // Date filter: a window that ends before the sale excludes it; one
    // around `now()` includes it (created_at is the DB clock, not NOW).
    const before = await inTenant(TENANT_A, (tx) =>
      listPosOrders(tx, TENANT_A, null, {
        dateTo: new Date("2000-01-01T00:00:00.000Z")
      })
    );
    expect(before.items).toEqual([]);
    const around = await inTenant(TENANT_A, (tx) =>
      listPosOrders(tx, TENANT_A, null, {
        dateFrom: new Date(Date.now() - 60 * 60 * 1000),
        dateTo: new Date(Date.now() + 60 * 60 * 1000)
      })
    );
    expect(around.items.length).toBe(1);

    // The admin order list is channel-agnostic (a POS order is still an
    // order the store manages) — both are there.
    const adminList = await inTenant(TENANT_A, (tx) =>
      listOrdersForAdmin(tx, TENANT_A, null)
    );
    expect(adminList.items.map((item) => item.orderCode).sort()).toEqual(
      [posSale.order.orderCode, storefrontOrder.order.orderCode].sort()
    );

    // Storefront tracking: the walk-in sentinel is documented, so the
    // lookup must refuse the POS order even with the "right" phone …
    const tracked = await inTenant(TENANT_A, (tx) =>
      fetchOrderForTracking(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        posSale.order.orderCode,
        POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
      )
    );
    expect(tracked).toBeNull();
    // … while the storefront order it sits next to still resolves.
    const trackedStorefront = await inTenant(TENANT_A, (tx) =>
      fetchOrderForTracking(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        storefrontOrder.order.orderCode,
        "+6281234567891"
      )
    );
    expect(trackedStorefront?.orderCode).toBe(storefrontOrder.order.orderCode);

    // Bearer account history for the walk-in customer row: empty.
    const accountHistory = await inTenant(TENANT_A, (tx) =>
      listOrdersForAccount(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        posSale.order.customerId,
        new Date("2000-01-01T00:00:00.000Z"),
        null
      )
    );
    expect(accountHistory.items).toEqual([]);
  });

  test("walk-in row is created once per tenant and reused; a phone-identified sale applies the customer's level", async () => {
    const productId = await seedActiveProduct(TENANT_A);

    const first = await inTenant(TENANT_A, (tx) =>
      createPosOrder(
        tx,
        TENANT_A,
        CASHIER_A,
        mediaLibraryPortAdapter,
        posInput(productId),
        NOW
      )
    );
    const second = await inTenant(TENANT_A, (tx) =>
      createPosOrder(
        tx,
        TENANT_A,
        CASHIER_A,
        mediaLibraryPortAdapter,
        posInput(productId, {
          idempotencyKey: "cccccccc-1111-4222-8333-444444444444",
          payment: { method: "manual_qris", amountTendered: null }
        }),
        NOW
      )
    );
    expect(first.kind).toBe("created");
    expect(second.kind).toBe("created");
    if (first.kind !== "created" || second.kind !== "created") return;
    expect(second.order.customerId).toBe(first.order.customerId);
    expect(second.order.change).toBeNull();
    expect(second.order.paymentMethod).toBe("manual_qris");

    const walkInRows = (await inTenant(
      TENANT_A,
      (tx) => tx`
        SELECT count(*)::int AS n FROM awcms_commerce_customers
        WHERE tenant_id = ${TENANT_A} AND phone = ${POS_WALK_IN_CUSTOMER_SENTINEL_PHONE}
      `
    )) as { n: number }[];
    expect(walkInRows[0]!.n).toBe(1);

    // A level-2 partner identified by phone pays price_level_2 at the counter.
    await inTenant(
      TENANT_A,
      (tx) => tx`
        INSERT INTO awcms_commerce_customers (tenant_id, name, phone, email, level, status)
        VALUES (${TENANT_A}, 'Budi', '+6281234567891', null, 2, 'active')
      `
    );
    const partner = await inTenant(TENANT_A, (tx) =>
      createPosOrder(
        tx,
        TENANT_A,
        CASHIER_A,
        mediaLibraryPortAdapter,
        posInput(productId, {
          idempotencyKey: "dddddddd-1111-4222-8333-444444444444",
          customer: { name: null, phone: "0812-3456-7891" },
          payment: { method: "cash", amountTendered: "24000.00" }
        }),
        NOW
      )
    );
    expect(partner.kind).toBe("created");
    if (partner.kind !== "created") return;
    expect(partner.order.customer.name).toBe("Budi");
    expect(partner.order.subtotal).toBe("24000.00");
    expect(partner.order.change).toBe("0.00");

    // A phone that does not normalise is refused, not silently walk-in.
    const badPhone = await inTenant(TENANT_A, (tx) =>
      createPosOrder(
        tx,
        TENANT_A,
        CASHIER_A,
        mediaLibraryPortAdapter,
        posInput(productId, {
          idempotencyKey: "eeeeeeee-1111-4222-8333-444444444444",
          customer: { name: null, phone: "12" }
        }),
        NOW
      )
    );
    expect(badPhone.kind).toBe("invalid_phone");
  });

  test("the storefront checkout refuses cash", async () => {
    const productId = await seedActiveProduct(TENANT_A);
    const input: CreateOrderInput = {
      idempotencyKey: "ffffffff-1111-4222-8333-444444444444",
      customer: { name: "Siti", phone: "0812-3456-7891", email: null },
      address: null,
      lines: [
        { productId, variantId: null, quantity: 1, serviceFormValues: null }
      ],
      shipping: { method: "self_pickup" },
      // Bypassing the route validator on purpose: even if `cash` reached the
      // application layer it is never an available storefront method.
      payment: { method: "cash" as CreateOrderInput["payment"]["method"] },
      voucherCode: null,
      insurance: false,
      notes: null,
      affiliateCode: null
    };
    const outcome = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(tx, TENANT_A, mediaLibraryPortAdapter, input, NOW)
    );
    expect(outcome.kind).toBe("cart_changed");
    if (outcome.kind === "cart_changed") {
      expect(
        outcome.quote.paymentMethods.some((m) => m.method === "cash")
      ).toBe(false);
    }
    expect(await stockOf(TENANT_A, productId)).toBe(20);

    // The sentinel phone is refused as a storefront identity too.
    const sentinel = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        {
          ...input,
          idempotencyKey: "abababab-1111-4222-8333-444444444444",
          customer: {
            name: "X",
            phone: POS_WALK_IN_CUSTOMER_SENTINEL_PHONE,
            email: null
          },
          payment: { method: "manual_qris" }
        },
        NOW
      )
    );
    expect(sentinel.kind).toBe("invalid_phone");
  });

  test("same Idempotency-Key replays the same order (no duplicate); a different payload is a conflict; a short tender writes nothing", async () => {
    const productId = await seedActiveProduct(TENANT_A);

    const first = await inTenant(TENANT_A, (tx) =>
      createPosOrder(
        tx,
        TENANT_A,
        CASHIER_A,
        mediaLibraryPortAdapter,
        posInput(productId),
        NOW
      )
    );
    expect(first.kind).toBe("created");
    if (first.kind !== "created") return;

    const replay = await inTenant(TENANT_A, (tx) =>
      createPosOrder(
        tx,
        TENANT_A,
        CASHIER_A,
        mediaLibraryPortAdapter,
        posInput(productId),
        NOW
      )
    );
    expect(replay.kind).toBe("replayed");
    if (replay.kind !== "replayed") return;
    expect(replay.order.orderCode).toBe(first.order.orderCode);
    expect(replay.order.change).toBe("20000.00");

    const count = (await inTenant(
      TENANT_A,
      (tx) =>
        tx`SELECT count(*)::int AS n FROM awcms_commerce_orders WHERE tenant_id = ${TENANT_A}`
    )) as { n: number }[];
    expect(count[0]!.n).toBe(1);
    expect(await stockOf(TENANT_A, productId)).toBe(18);

    // Same key, different payload (quantity) → conflict, nothing written.
    let conflict: unknown;
    try {
      await inTenant(TENANT_A, (tx) =>
        createPosOrder(
          tx,
          TENANT_A,
          CASHIER_A,
          mediaLibraryPortAdapter,
          posInput(productId, {
            lines: [{ productId, variantId: null, quantity: 3 }]
          }),
          NOW
        )
      );
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(IdempotencyPayloadMismatchError);

    // Same key value, DIFFERENT cashier → the hash is bound to the actor,
    // so this is a conflict too, never a replay of cashier A's sale.
    let crossCashier: unknown;
    try {
      await inTenant(TENANT_A, (tx) =>
        createPosOrder(
          tx,
          TENANT_A,
          CASHIER_B,
          mediaLibraryPortAdapter,
          posInput(productId),
          NOW
        )
      );
    } catch (error) {
      crossCashier = error;
    }
    expect(crossCashier).toBeInstanceOf(IdempotencyPayloadMismatchError);

    // Short tender: the transaction throws before any row is written.
    let short: unknown;
    try {
      await inTenant(TENANT_A, (tx) =>
        createPosOrder(
          tx,
          TENANT_A,
          CASHIER_A,
          mediaLibraryPortAdapter,
          posInput(productId, {
            idempotencyKey: "12121212-1111-4222-8333-444444444444",
            payment: { method: "cash", amountTendered: "29999.99" }
          }),
          NOW
        )
      );
    } catch (error) {
      short = error;
    }
    expect(short).toBeInstanceOf(InsufficientTenderError);
    expect((short as InsufficientTenderError).shortfall).toBe("0.01");
    const after = (await inTenant(
      TENANT_A,
      (tx) =>
        tx`SELECT count(*)::int AS n FROM awcms_commerce_orders WHERE tenant_id = ${TENANT_A}`
    )) as { n: number }[];
    expect(after[0]!.n).toBe(1);
    expect(await stockOf(TENANT_A, productId)).toBe(18);
  });

  test("with the pos feature disabled the owner-route gate answers 409 FEATURE_DISABLED", async () => {
    const enabled = await inTenant(TENANT_A, (tx) =>
      requireCommerceFeatureForOwnerRoute(tx, TENANT_A, "pos")
    );
    expect(enabled).toBeNull();

    await inTenant(TENANT_A, (tx) =>
      updateModuleSettings(
        tx,
        TENANT_A,
        "commerce",
        { features: { pos: false } },
        ACTOR
      )
    );

    const gate = await inTenant(TENANT_A, (tx) =>
      requireCommerceFeatureForOwnerRoute(tx, TENANT_A, "pos")
    );
    expect(gate).not.toBeNull();
    expect(gate?.status).toBe(409);
    const body = (await gate?.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FEATURE_DISABLED");
  });
});
