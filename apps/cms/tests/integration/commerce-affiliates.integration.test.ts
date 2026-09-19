/**
 * `commerce` affiliate program integration (Issue #92, contract #86's D5) —
 * exercised against a REAL migrated database through
 * `tests/integration/harness.ts`, the same shape `commerce-orders`'s own
 * integration suite (#29) already uses. Gated on `DATABASE_URL`; skips
 * cleanly without one.
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
  updateOrderStatusByAdmin
} from "../../src/modules/commerce/application/order-directory";
import { findOrCreateCustomerByPhone } from "../../src/modules/commerce/application/customer-directory";
import {
  fetchAffiliateCommissionRate,
  fetchStoreSettings,
  saveAffiliateCommissionRate,
  saveStoreSettings,
  toPublicRecord
} from "../../src/modules/commerce/application/store-settings-directory";
import {
  AffiliateProgramDisabledError,
  InvalidCommissionTransitionError,
  approveAffiliateCommission,
  enrolAffiliate,
  fetchAccountAffiliate,
  listAffiliateCommissionsForAdmin,
  listAffiliatesForAdmin,
  patchAffiliate,
  payAffiliateCommission,
  resolveAffiliateForOrder,
  voidAffiliateCommission,
  voidAffiliateCommissionForOrder
} from "../../src/modules/commerce/application/affiliate-directory";
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

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-AFFILIATE",
  name: "Kopi Susu",
  slug: "kopi-susu-affiliate",
  description: null,
  digitalNote: null,
  price: "50000.00",
  discountPercent: 0,
  stock: 100,
  label: null,
  labelColor: null,
  priceLevel2: null,
  priceLevel3: null,
  priceLevel4: null,
  costPrice: null,
  minPurchase: 1,
  weightGrams: 200,
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

async function enableSelfPickupAndQris(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Afiliasi",
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

function orderInput(
  productId: string,
  overrides: Partial<CreateOrderInput> = {}
): CreateOrderInput {
  return {
    idempotencyKey: crypto.randomUUID(),
    customer: {
      name: "Referred Shopper",
      phone: "0812-0000-0001",
      email: null
    },
    address: null,
    lines: [
      { productId, variantId: null, quantity: 1, serviceFormValues: null }
    ],
    shipping: { method: "self_pickup" },
    payment: { method: "manual_qris" },
    voucherCode: null,
    insurance: false,
    notes: null,
    affiliateCode: null,
    ...overrides
  };
}

/** Walks an order through every legal admin transition up to `completed`. */
async function completeOrder(tenantId: string, orderId: string): Promise<void> {
  for (const to of ["paid", "processing", "shipped", "completed"] as const) {
    const ok = await inTenant(tenantId, (tx) =>
      updateOrderStatusByAdmin(tx, tenantId, ACTOR, orderId, to, null)
    );
    if (!ok) throw new Error(`Transition to ${to} failed unexpectedly.`);
  }
}

async function orderIdByCode(
  tenantId: string,
  orderCode: string
): Promise<string> {
  const rows = (await inTenant(
    tenantId,
    (tx) =>
      tx`SELECT id FROM awcms_commerce_orders WHERE order_code = ${orderCode}`
  )) as { id: string }[];
  return rows[0]!.id;
}

async function orderRowByCode(
  tenantId: string,
  orderCode: string
): Promise<{ affiliate_id: string | null; customer_id: string }> {
  const rows = (await inTenant(
    tenantId,
    (tx) =>
      tx`SELECT affiliate_id, customer_id FROM awcms_commerce_orders WHERE order_code = ${orderCode}`
  )) as { affiliate_id: string | null; customer_id: string }[];
  return rows[0]!;
}

async function commissionForOrder(
  tenantId: string,
  orderId: string
): Promise<
  | {
      id: string;
      status: string;
      amount: string;
      base_amount: string;
      rate: string;
    }
  | undefined
> {
  const rows = (await inTenant(
    tenantId,
    (tx) =>
      tx`SELECT id, status, amount, base_amount, rate FROM awcms_commerce_affiliate_commissions WHERE order_id = ${orderId}`
  )) as {
    id: string;
    status: string;
    amount: string;
    base_amount: string;
    rate: string;
  }[];
  return rows[0];
}

suite("commerce affiliates integration (Issue #92)", () => {
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

  test("enrol: program disabled -> throws; enabled -> gets a code; enrolling twice returns the same row", async () => {
    const customer = await inTenant(TENANT_A, (tx) =>
      findOrCreateCustomerByPhone(
        tx,
        TENANT_A,
        "Affiliate Person",
        "+6281200000099",
        null
      )
    );

    await expect(
      inTenant(TENANT_A, (tx) => enrolAffiliate(tx, TENANT_A, customer.id))
    ).rejects.toBeInstanceOf(AffiliateProgramDisabledError);

    await inTenant(TENANT_A, (tx) =>
      saveAffiliateCommissionRate(tx, TENANT_A, "10.00")
    );

    const first = await inTenant(TENANT_A, (tx) =>
      enrolAffiliate(tx, TENANT_A, customer.id)
    );
    expect(first.status).toBe("active");
    expect(first.commissionRate).toBe("10.00");
    expect(first.code).toHaveLength(8);

    const second = await inTenant(TENANT_A, (tx) =>
      enrolAffiliate(tx, TENANT_A, customer.id)
    );
    expect(second.code).toBe(first.code);

    const fetched = await inTenant(TENANT_A, (tx) =>
      fetchAccountAffiliate(tx, TENANT_A, customer.id)
    );
    expect(fetched?.code).toBe(first.code);
  }, 30000);

  test("order with a valid code links affiliate_id; unknown or suspended code links nothing, and checkout still succeeds", async () => {
    await inTenant(TENANT_A, (tx) =>
      saveAffiliateCommissionRate(tx, TENANT_A, "10.00")
    );
    const affiliateCustomer = await inTenant(TENANT_A, (tx) =>
      findOrCreateCustomerByPhone(
        tx,
        TENANT_A,
        "Affiliate Person",
        "+6281200000099",
        null
      )
    );
    const affiliate = await inTenant(TENANT_A, (tx) =>
      enrolAffiliate(tx, TENANT_A, affiliateCustomer.id)
    );
    const productId = await seedActiveProduct(TENANT_A);

    // Valid code.
    const withCode = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId, { affiliateCode: affiliate.code }),
        NOW
      )
    );
    expect(withCode.kind).toBe("created");
    if (withCode.kind !== "created") return;
    const withCodeRow = await orderRowByCode(
      TENANT_A,
      withCode.order.orderCode
    );
    expect(withCodeRow.affiliate_id).not.toBeNull();

    // Unknown code — never fails checkout, just does not link.
    const unknown = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId, {
          idempotencyKey: crypto.randomUUID(),
          affiliateCode: "ZZZZZZZZ",
          customer: {
            name: "Another Shopper",
            phone: "0812-0000-0002",
            email: null
          }
        }),
        NOW
      )
    );
    expect(unknown.kind).toBe("created");
    if (unknown.kind !== "created") return;
    const unknownRow = await orderRowByCode(TENANT_A, unknown.order.orderCode);
    expect(unknownRow.affiliate_id).toBeNull();

    // Suspend the affiliate, then a fresh order with the (now-suspended) code.
    const affiliateIdRows = (await inTenant(
      TENANT_A,
      (tx) =>
        tx`SELECT id FROM awcms_commerce_affiliates WHERE code = ${affiliate.code}`
    )) as { id: string }[];
    const affiliateId = affiliateIdRows[0]!.id;

    await inTenant(TENANT_A, (tx) =>
      patchAffiliate(tx, TENANT_A, ACTOR, affiliateId, {
        status: "suspended"
      })
    );

    const suspended = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId, {
          idempotencyKey: crypto.randomUUID(),
          affiliateCode: affiliate.code,
          customer: {
            name: "Third Shopper",
            phone: "0812-0000-0003",
            email: null
          }
        }),
        NOW
      )
    );
    expect(suspended.kind).toBe("created");
    if (suspended.kind !== "created") return;
    const suspendedRow = await orderRowByCode(
      TENANT_A,
      suspended.order.orderCode
    );
    expect(suspendedRow.affiliate_id).toBeNull();
  }, 30000);

  test("commission is created pending when the order reaches completed; none on self-referral", async () => {
    await inTenant(TENANT_A, (tx) =>
      saveAffiliateCommissionRate(tx, TENANT_A, "10.00")
    );
    const affiliateCustomer = await inTenant(TENANT_A, (tx) =>
      findOrCreateCustomerByPhone(
        tx,
        TENANT_A,
        "Affiliate Person",
        "+6281200000099",
        null
      )
    );
    const affiliate = await inTenant(TENANT_A, (tx) =>
      enrolAffiliate(tx, TENANT_A, affiliateCustomer.id)
    );
    const productId = await seedActiveProduct(TENANT_A);

    const referred = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId, { affiliateCode: affiliate.code }),
        NOW
      )
    );
    expect(referred.kind).toBe("created");
    if (referred.kind !== "created") return;

    const referredId = await orderIdByCode(TENANT_A, referred.order.orderCode);
    await completeOrder(TENANT_A, referredId);

    const commission = await commissionForOrder(TENANT_A, referredId);
    expect(commission).toBeDefined();
    expect(commission?.status).toBe("pending");
    // subtotal 50000.00, no discount/voucher -> base 50000.00, rate 10% -> 5000.00
    expect(commission?.amount).toBe("5000.00");

    // Self-referral: the SAME phone as the affiliate's own customer row.
    const selfReferred = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId, {
          idempotencyKey: crypto.randomUUID(),
          affiliateCode: affiliate.code,
          customer: {
            name: "Affiliate Person",
            phone: "0812-0000-0099",
            email: null
          }
        }),
        NOW
      )
    );
    expect(selfReferred.kind).toBe("created");
    if (selfReferred.kind !== "created") return;

    const selfReferredId = await orderIdByCode(
      TENANT_A,
      selfReferred.order.orderCode
    );
    await completeOrder(TENANT_A, selfReferredId);
    const selfCommission = await commissionForOrder(TENANT_A, selfReferredId);
    expect(selfCommission).toBeUndefined();
  }, 30000);

  test("void marks a pending/approved commission void; approve -> pay; invalid transitions 409", async () => {
    await inTenant(TENANT_A, (tx) =>
      saveAffiliateCommissionRate(tx, TENANT_A, "10.00")
    );
    const affiliateCustomer = await inTenant(TENANT_A, (tx) =>
      findOrCreateCustomerByPhone(
        tx,
        TENANT_A,
        "Affiliate Person",
        "+6281200000099",
        null
      )
    );
    const affiliate = await inTenant(TENANT_A, (tx) =>
      enrolAffiliate(tx, TENANT_A, affiliateCustomer.id)
    );
    const productId = await seedActiveProduct(TENANT_A);

    const order1 = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId, { affiliateCode: affiliate.code }),
        NOW
      )
    );
    if (order1.kind !== "created") throw new Error("setup failed");
    const order1Id = await orderIdByCode(TENANT_A, order1.order.orderCode);
    await completeOrder(TENANT_A, order1Id);
    const commission1 = await commissionForOrder(TENANT_A, order1Id);
    expect(commission1).toBeDefined();

    // void directly (order-directory.ts's own hook on a cancel transition —
    // exercised here at the application layer since `completed` has no
    // outgoing edge in the current order-status graph).
    await inTenant(TENANT_A, (tx) =>
      voidAffiliateCommissionForOrder(tx, TENANT_A, order1Id)
    );
    const voided = await commissionForOrder(TENANT_A, order1Id);
    expect(voided?.status).toBe("void");

    // A second order/commission for approve -> pay and invalid transitions.
    const order2 = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId, {
          idempotencyKey: crypto.randomUUID(),
          affiliateCode: affiliate.code,
          customer: {
            name: "Fourth Shopper",
            phone: "0812-0000-0004",
            email: null
          }
        }),
        NOW
      )
    );
    if (order2.kind !== "created") throw new Error("setup failed");
    const order2Id = await orderIdByCode(TENANT_A, order2.order.orderCode);
    await completeOrder(TENANT_A, order2Id);
    const commission2 = await commissionForOrder(TENANT_A, order2Id);
    expect(commission2).toBeDefined();

    // pay before approve -> 409-shaped error.
    await expect(
      inTenant(TENANT_A, (tx) =>
        payAffiliateCommission(tx, TENANT_A, ACTOR, commission2!.id)
      )
    ).rejects.toBeInstanceOf(InvalidCommissionTransitionError);

    const approved = await inTenant(TENANT_A, (tx) =>
      approveAffiliateCommission(tx, TENANT_A, ACTOR, commission2!.id)
    );
    expect(approved?.status).toBe("approved");

    const paid = await inTenant(TENANT_A, (tx) =>
      payAffiliateCommission(tx, TENANT_A, ACTOR, commission2!.id)
    );
    expect(paid?.status).toBe("paid");

    // void after paid -> 409-shaped error (already final).
    await expect(
      inTenant(TENANT_A, (tx) =>
        voidAffiliateCommission(tx, TENANT_A, ACTOR, commission2!.id)
      )
    ).rejects.toBeInstanceOf(InvalidCommissionTransitionError);
  }, 30000);

  test("RLS: tenant B cannot see tenant A's affiliates or commissions", async () => {
    await inTenant(TENANT_A, (tx) =>
      saveAffiliateCommissionRate(tx, TENANT_A, "10.00")
    );
    const affiliateCustomer = await inTenant(TENANT_A, (tx) =>
      findOrCreateCustomerByPhone(
        tx,
        TENANT_A,
        "Affiliate Person",
        "+6281200000099",
        null
      )
    );
    await inTenant(TENANT_A, (tx) =>
      enrolAffiliate(tx, TENANT_A, affiliateCustomer.id)
    );

    const tenantAList = await inTenant(TENANT_A, (tx) =>
      listAffiliatesForAdmin(tx, TENANT_A, null)
    );
    expect(tenantAList.items.length).toBe(1);

    const tenantBList = await inTenant(TENANT_B, (tx) =>
      listAffiliatesForAdmin(tx, TENANT_B, null)
    );
    expect(tenantBList.items.length).toBe(0);

    const tenantBCommissions = await inTenant(TENANT_B, (tx) =>
      listAffiliateCommissionsForAdmin(tx, TENANT_B, null)
    );
    expect(tenantBCommissions.items.length).toBe(0);
  }, 30000);

  test("public store-settings read model exposes affiliateProgramEnabled only — never the rate", async () => {
    await inTenant(TENANT_A, (tx) =>
      saveAffiliateCommissionRate(tx, TENANT_A, "15.00")
    );

    const publicRecord = await inTenant(TENANT_A, async (tx) => {
      const settings = await fetchStoreSettings(tx, TENANT_A);
      const enabled =
        (await fetchAffiliateCommissionRate(tx, TENANT_A)) !== null;
      return toPublicRecord(
        tx,
        TENANT_A,
        settings,
        mediaLibraryPortAdapter,
        enabled
      );
    });

    expect(publicRecord.affiliateProgramEnabled).toBe(true);
    const serialized = JSON.stringify(publicRecord);
    expect(serialized).not.toContain("15.00");
    expect(serialized).not.toContain("affiliateCommissionRate");

    const rate = await inTenant(TENANT_A, (tx) =>
      fetchAffiliateCommissionRate(tx, TENANT_A)
    );
    expect(rate).toBe("15.00");
  }, 30000);

  test("resolveAffiliateForOrder: unknown/malformed code resolves to null, never throws", async () => {
    const result = await inTenant(TENANT_A, (tx) =>
      resolveAffiliateForOrder(tx, TENANT_A, "not-a-real-code")
    );
    expect(result).toBeNull();

    const nullCode = await inTenant(TENANT_A, (tx) =>
      resolveAffiliateForOrder(tx, TENANT_A, null)
    );
    expect(nullCode).toBeNull();
  }, 30000);
});
