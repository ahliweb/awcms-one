/**
 * `commerce` account resource endpoints integration (Issue #91, C3, contract
 * #86/ADR-0016) — addresses/wishlist/orders/reviews, exercised against a REAL
 * migrated database through `tests/integration/harness.ts`, the way
 * `commerce-orders` (#29) and `commerce-customer-account-store` (#87) already
 * are. Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * Covers the properties only a real database can prove:
 *
 *   - address CRUD, the FIRST address becoming the default automatically,
 *     the 10-address limit, deleting the default promoting the
 *     most-recently-created remaining one, and the `920` partial unique
 *     index actually holding (never two defaults at once);
 *   - wishlist union-merge (dedupe, an unknown/foreign product id silently
 *     skipped, the 200-item limit) and soft-delete removal;
 *   - the account order list/detail both enforcing `created_at >=
 *     historyFrom` INSIDE the query (one order seeded before, one after);
 *   - an order created with a bearer binds to the account's OWN customer
 *     row, never a second guest row for whatever phone was typed;
 *   - the account's own review list;
 *   - RLS: tenant B cannot see tenant A's rows through any of these
 *     functions even when handed tenant A's own customerId.
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
  fetchOrderForAccount,
  listOrdersForAccount
} from "../../src/modules/commerce/application/order-directory";
import {
  createReview,
  listReviewsForAccount
} from "../../src/modules/commerce/application/review-directory";
import {
  ACCOUNT_ADDRESS_LIMIT,
  ACCOUNT_WISHLIST_LIMIT,
  createAccountAddress,
  deleteAccountAddress,
  listAccountAddresses,
  listAccountWishlist,
  mergeAccountWishlist,
  removeAccountWishlistItem,
  setDefaultAccountAddress,
  updateAccountAddress
} from "../../src/modules/commerce/application/customer-account-resources";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import type { AccountAddressInput } from "../../src/modules/commerce/domain/address-validation";
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

async function seedCustomer(
  tenantId: string,
  phone: string,
  name = "Siti"
): Promise<string> {
  const rows = (await inTenant(
    tenantId,
    (tx) =>
      tx`
        INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
        VALUES (${tenantId}, ${name}, ${phone})
        RETURNING id
      `
  )) as { id: string }[];
  return rows[0]!.id;
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-ACCT",
  name: "Mie Gacoan",
  slug: "mie-gacoan-acct",
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
  slug = "mie-gacoan-acct"
): Promise<string> {
  const product = await inTenant(tenantId, (tx) =>
    createProduct(tx, tenantId, ACTOR, {
      ...BASE_PRODUCT,
      slug,
      sku: `SKU-${slug}`
    })
  );
  await inTenant(
    tenantId,
    (tx) =>
      tx`UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}`
  );
  return product.id;
}

function addressInput(
  overrides: Partial<AccountAddressInput> = {}
): AccountAddressInput {
  return {
    label: "Rumah",
    recipientName: "Budi Santoso",
    phone: "+6281234567890",
    provinceCode: "62",
    provinceName: "Kalimantan Tengah",
    cityCode: "6202",
    cityName: "Kotawaringin Timur",
    districtCode: "620201",
    districtName: "Baamang",
    postalCode: "74311",
    street: "Jl. Jenderal Sudirman No. 1",
    latitude: null,
    longitude: null,
    notes: null,
    ...overrides
  };
}

suite("commerce account resource endpoints integration (Issue #91)", () => {
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
  }, 30000);

  // ---------------------------------------------------------------------
  // Addresses
  // ---------------------------------------------------------------------

  test("the first saved address becomes the default automatically", async () => {
    const customerId = await seedCustomer(TENANT_A, "+6281200000001");

    const outcome = await inTenant(TENANT_A, (tx) =>
      createAccountAddress(tx, TENANT_A, customerId, addressInput())
    );
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") throw new Error("expected created");
    expect(outcome.address.isDefault).toBe(true);

    const second = await inTenant(TENANT_A, (tx) =>
      createAccountAddress(
        tx,
        TENANT_A,
        customerId,
        addressInput({ label: "Kantor" })
      )
    );
    if (second.kind !== "created") throw new Error("expected created");
    expect(second.address.isDefault).toBe(false);

    const list = await inTenant(TENANT_A, (tx) =>
      listAccountAddresses(tx, TENANT_A, customerId)
    );
    expect(list).toHaveLength(2);
    expect(list[0]!.isDefault).toBe(true); // default first
  });

  test("refuses an 11th address with ADDRESS_LIMIT_REACHED, and the 920 index allows only one default at a time", async () => {
    const customerId = await seedCustomer(TENANT_A, "+6281200000002");

    for (let i = 0; i < ACCOUNT_ADDRESS_LIMIT; i += 1) {
      const outcome = await inTenant(TENANT_A, (tx) =>
        createAccountAddress(
          tx,
          TENANT_A,
          customerId,
          addressInput({ label: `Addr ${i}` })
        )
      );
      expect(outcome.kind).toBe("created");
    }

    const overLimit = await inTenant(TENANT_A, (tx) =>
      createAccountAddress(
        tx,
        TENANT_A,
        customerId,
        addressInput({ label: "One too many" })
      )
    );
    expect(overLimit.kind).toBe("limit_reached");

    const list = await inTenant(TENANT_A, (tx) =>
      listAccountAddresses(tx, TENANT_A, customerId)
    );
    expect(list).toHaveLength(ACCOUNT_ADDRESS_LIMIT);
    expect(list.filter((address) => address.isDefault)).toHaveLength(1);
  });

  test("update never touches isDefault; delete of the default promotes the most-recently-created remaining one", async () => {
    const customerId = await seedCustomer(TENANT_A, "+6281200000003");

    const first = await inTenant(TENANT_A, (tx) =>
      createAccountAddress(
        tx,
        TENANT_A,
        customerId,
        addressInput({ label: "First" })
      )
    );
    if (first.kind !== "created") throw new Error("expected created");
    const second = await inTenant(TENANT_A, (tx) =>
      createAccountAddress(
        tx,
        TENANT_A,
        customerId,
        addressInput({ label: "Second" })
      )
    );
    if (second.kind !== "created") throw new Error("expected created");

    const updated = await inTenant(TENANT_A, (tx) =>
      updateAccountAddress(
        tx,
        TENANT_A,
        customerId,
        second.address.id,
        addressInput({ label: "Second (renamed)" })
      )
    );
    expect(updated?.label).toBe("Second (renamed)");
    expect(updated?.isDefault).toBe(false);

    const deleted = await inTenant(TENANT_A, (tx) =>
      deleteAccountAddress(tx, TENANT_A, customerId, first.address.id)
    );
    expect(deleted).toBe(true);

    const remaining = await inTenant(TENANT_A, (tx) =>
      listAccountAddresses(tx, TENANT_A, customerId)
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(second.address.id);
    expect(remaining[0]!.isDefault).toBe(true); // promoted
  });

  test("setDefaultAccountAddress switches the default without ever violating the 920 unique index", async () => {
    const customerId = await seedCustomer(TENANT_A, "+6281200000004");

    const first = await inTenant(TENANT_A, (tx) =>
      createAccountAddress(
        tx,
        TENANT_A,
        customerId,
        addressInput({ label: "First" })
      )
    );
    if (first.kind !== "created") throw new Error("expected created");
    const second = await inTenant(TENANT_A, (tx) =>
      createAccountAddress(
        tx,
        TENANT_A,
        customerId,
        addressInput({ label: "Second" })
      )
    );
    if (second.kind !== "created") throw new Error("expected created");

    const switched = await inTenant(TENANT_A, (tx) =>
      setDefaultAccountAddress(tx, TENANT_A, customerId, second.address.id)
    );
    expect(switched?.isDefault).toBe(true);

    const list = await inTenant(TENANT_A, (tx) =>
      listAccountAddresses(tx, TENANT_A, customerId)
    );
    expect(list.filter((address) => address.isDefault)).toHaveLength(1);
    expect(
      list.find((address) => address.id === second.address.id)?.isDefault
    ).toBe(true);
  });

  test("mutations against another customer's address id are refused", async () => {
    const customerId = await seedCustomer(TENANT_A, "+6281200000005");
    const otherCustomerId = await seedCustomer(TENANT_A, "+6281200000006");

    const created = await inTenant(TENANT_A, (tx) =>
      createAccountAddress(tx, TENANT_A, customerId, addressInput())
    );
    if (created.kind !== "created") throw new Error("expected created");

    const updateResult = await inTenant(TENANT_A, (tx) =>
      updateAccountAddress(
        tx,
        TENANT_A,
        otherCustomerId,
        created.address.id,
        addressInput()
      )
    );
    expect(updateResult).toBeNull();

    const deleteResult = await inTenant(TENANT_A, (tx) =>
      deleteAccountAddress(tx, TENANT_A, otherCustomerId, created.address.id)
    );
    expect(deleteResult).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Wishlist
  // ---------------------------------------------------------------------

  test("merge union-adds published products, dedupes, and silently skips an unknown/foreign product id", async () => {
    const customerId = await seedCustomer(TENANT_A, "+6281200000007");
    const productId = await seedActiveProduct(TENANT_A, "wishlist-product-1");
    const foreignProductId = await seedActiveProduct(
      TENANT_B,
      "wishlist-product-foreign"
    );
    const unknownId = "99999999-9999-4999-8999-999999999999";

    const outcome = await inTenant(TENANT_A, (tx) =>
      mergeAccountWishlist(
        tx,
        TENANT_A,
        customerId,
        [productId, foreignProductId, unknownId],
        mediaLibraryPortAdapter
      )
    );
    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") throw new Error("expected merged");
    expect(outcome.items).toHaveLength(1);
    expect(outcome.items[0]!.productId).toBe(productId);
    expect(outcome.items[0]!.image).toBeNull();

    // Merging the SAME id again does not duplicate.
    const again = await inTenant(TENANT_A, (tx) =>
      mergeAccountWishlist(
        tx,
        TENANT_A,
        customerId,
        [productId],
        mediaLibraryPortAdapter
      )
    );
    if (again.kind !== "merged") throw new Error("expected merged");
    expect(again.items).toHaveLength(1);
  });

  test("a product moderated back out of active status stops appearing in the list, without touching the wishlist row", async () => {
    const customerId = await seedCustomer(TENANT_A, "+6281200000008");
    const productId = await seedActiveProduct(TENANT_A, "wishlist-product-2");

    await inTenant(TENANT_A, (tx) =>
      mergeAccountWishlist(
        tx,
        TENANT_A,
        customerId,
        [productId],
        mediaLibraryPortAdapter
      )
    );

    await inTenant(
      TENANT_A,
      (tx) =>
        tx`UPDATE awcms_commerce_products SET status = 'inactive' WHERE id = ${productId}`
    );

    const list = await inTenant(TENANT_A, (tx) =>
      listAccountWishlist(tx, TENANT_A, customerId, mediaLibraryPortAdapter)
    );
    expect(list).toHaveLength(0);

    const rawRows = (await inTenant(
      TENANT_A,
      (tx) =>
        tx`SELECT 1 FROM awcms_commerce_wishlists WHERE tenant_id = ${TENANT_A} AND customer_id = ${customerId} AND deleted_at IS NULL`
    )) as unknown[];
    expect(rawRows).toHaveLength(1); // row itself untouched
  });

  test("removal is soft-delete + idempotent, and a merge comfortably under the cap succeeds", async () => {
    const customerId = await seedCustomer(TENANT_A, "+6281200000009");
    const productIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      productIds.push(await seedActiveProduct(TENANT_A, `wishlist-limit-${i}`));
    }

    const merged = await inTenant(TENANT_A, (tx) =>
      mergeAccountWishlist(
        tx,
        TENANT_A,
        customerId,
        productIds,
        mediaLibraryPortAdapter
      )
    );
    expect(merged.kind).toBe("merged");
    if (merged.kind !== "merged") throw new Error("expected merged");
    expect(merged.items).toHaveLength(3);

    await inTenant(TENANT_A, (tx) =>
      removeAccountWishlistItem(tx, TENANT_A, customerId, productIds[0]!)
    );
    const afterRemove = await inTenant(TENANT_A, (tx) =>
      listAccountWishlist(tx, TENANT_A, customerId, mediaLibraryPortAdapter)
    );
    expect(
      afterRemove.find((item) => item.productId === productIds[0])
    ).toBeUndefined();
    expect(afterRemove).toHaveLength(2);

    // Idempotent — removing again does not throw, and re-adding the same id
    // works (the soft-deleted row does not block a fresh INSERT — the
    // unique index is `WHERE deleted_at IS NULL`).
    await inTenant(TENANT_A, (tx) =>
      removeAccountWishlistItem(tx, TENANT_A, customerId, productIds[0]!)
    );
    const readded = await inTenant(TENANT_A, (tx) =>
      mergeAccountWishlist(
        tx,
        TENANT_A,
        customerId,
        [productIds[0]!],
        mediaLibraryPortAdapter
      )
    );
    expect(readded.kind).toBe("merged");
    if (readded.kind !== "merged") throw new Error("expected merged");
    expect(readded.items).toHaveLength(3);
  });

  test("mergeAccountWishlist answers limit_reached and inserts nothing when the cap would be exceeded", async () => {
    const customerId = await seedCustomer(TENANT_A, "+6281200000010");
    const productId = await seedActiveProduct(TENANT_A, "wishlist-overflow");

    const admin = getAdminSql();
    // Seed exactly ACCOUNT_WISHLIST_LIMIT distinct FILLER products (minimal
    // raw rows — the count query below does not care about their status)
    // and wishlist rows referencing them, cheaply, without going through
    // `createProduct`'s full validation 200 times.
    for (let i = 0; i < ACCOUNT_WISHLIST_LIMIT; i += 1) {
      const fillerRows = (await admin`
        INSERT INTO awcms_commerce_products (tenant_id, sku, name, slug, price)
        VALUES (${TENANT_A}, ${`SKU-FILLER-${i}`}, ${`Filler ${i}`}, ${`filler-${i}`}, '1.00')
        RETURNING id
      `) as { id: string }[];
      await admin`
        INSERT INTO awcms_commerce_wishlists (tenant_id, customer_id, product_id)
        VALUES (${TENANT_A}, ${customerId}, ${fillerRows[0]!.id})
      `;
    }

    const outcome = await inTenant(TENANT_A, (tx) =>
      mergeAccountWishlist(
        tx,
        TENANT_A,
        customerId,
        [productId],
        mediaLibraryPortAdapter
      )
    );
    expect(outcome.kind).toBe("limit_reached");

    const countRows = (await inTenant(
      TENANT_A,
      (tx) =>
        tx`SELECT count(*)::int AS n FROM awcms_commerce_wishlists WHERE tenant_id = ${TENANT_A} AND customer_id = ${customerId} AND deleted_at IS NULL`
    )) as { n: number }[];
    expect(countRows[0]!.n).toBe(ACCOUNT_WISHLIST_LIMIT); // unchanged
  });

  // ---------------------------------------------------------------------
  // Orders — history_from window, ownership, bearer binding
  // ---------------------------------------------------------------------

  async function seedOrder(
    tenantId: string,
    customerId: string,
    orderCode: string,
    createdAt: string
  ): Promise<string> {
    const rows = (await inTenant(
      tenantId,
      (tx) =>
        tx`
          INSERT INTO awcms_commerce_orders (
            tenant_id, order_code, customer_id, status, payment_method, payment_status,
            shipping_method, shipping_cost, subtotal, discount, voucher_discount,
            insurance_fee, tax, total, created_at
          )
          VALUES (
            ${tenantId}, ${orderCode}, ${customerId}, 'completed', 'manual_qris', 'paid',
            'self_pickup', '0.00', '10000.00', '0.00', '0.00', '0.00', '0.00', '10000.00', ${createdAt}
          )
          RETURNING id
        `
    )) as { id: string }[];
    return rows[0]!.id;
  }

  test("account order list/detail enforce created_at >= historyFrom INSIDE the query", async () => {
    const customerId = await seedCustomer(TENANT_A, "+6281200000011");
    const historyFrom = new Date("2026-01-01T00:00:00.000Z");

    await seedOrder(
      TENANT_A,
      customerId,
      "ORD-BEFORE",
      "2025-11-15T03:00:00.000Z"
    );
    await seedOrder(
      TENANT_A,
      customerId,
      "ORD-AFTER",
      "2026-02-01T03:00:00.000Z"
    );

    const page = await inTenant(TENANT_A, (tx) =>
      listOrdersForAccount(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        customerId,
        historyFrom,
        null,
        20
      )
    );
    expect(page.items.map((item) => item.orderCode)).toEqual(["ORD-AFTER"]);

    const before = await inTenant(TENANT_A, (tx) =>
      fetchOrderForAccount(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        customerId,
        historyFrom,
        "ORD-BEFORE"
      )
    );
    expect(before).toBeNull();

    const after = await inTenant(TENANT_A, (tx) =>
      fetchOrderForAccount(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        customerId,
        historyFrom,
        "ORD-AFTER"
      )
    );
    expect(after?.orderCode).toBe("ORD-AFTER");
  });

  test("an order belonging to another customer answers null (the owned-order-detail vs foreign-order-404 case)", async () => {
    const customerId = await seedCustomer(TENANT_A, "+6281200000012");
    const foreignCustomerId = await seedCustomer(TENANT_A, "+6281200000013");
    await seedOrder(
      TENANT_A,
      foreignCustomerId,
      "ORD-FOREIGN",
      "2026-02-01T03:00:00.000Z"
    );

    const result = await inTenant(TENANT_A, (tx) =>
      fetchOrderForAccount(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        customerId,
        new Date("2026-01-01T00:00:00.000Z"),
        "ORD-FOREIGN"
      )
    );
    expect(result).toBeNull();
  });

  test("createOrderFromCart with a bearer binds the order to the account's OWN customer row, never a new guest row", async () => {
    await inTenant(TENANT_A, async (tx) => {
      const validated = validateStoreSettingsInput({
        storeName: "Toko Uji",
        shipping: { selfPickup: true },
        payment: { manualQris: { active: true, mediaObjectId: null } }
      });
      if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
      await saveStoreSettings(tx, TENANT_A, ACTOR, validated.value);
    });

    const accountCustomerId = await seedCustomer(
      TENANT_A,
      "+6281200000014",
      "Account Holder"
    );
    const productId = await seedActiveProduct(TENANT_A, "bearer-bound-product");

    const input: CreateOrderInput = {
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      // A DIFFERENT phone than the account's own — proves identity comes
      // from `accountCustomerId`, not this field.
      customer: { name: "Someone Else", phone: "0812-0000-9999", email: null },
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

    const outcome = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        input,
        new Date("2026-03-01T00:00:00.000Z"),
        undefined,
        accountCustomerId
      )
    );
    expect(outcome.kind).toBe("created");

    const rows = (await inTenant(
      TENANT_A,
      (tx) =>
        tx`SELECT customer_id FROM awcms_commerce_orders WHERE tenant_id = ${TENANT_A} AND order_code = ${(outcome as { order: { orderCode: string } }).order.orderCode}`
    )) as { customer_id: string }[];
    expect(rows[0]!.customer_id).toBe(accountCustomerId);

    // No SECOND customer row was created for the differing phone.
    const customerRows = (await inTenant(
      TENANT_A,
      (tx) =>
        tx`SELECT count(*)::int AS n FROM awcms_commerce_customers WHERE tenant_id = ${TENANT_A} AND phone = '+6281200009999'`
    )) as { n: number }[];
    expect(customerRows[0]!.n).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Reviews
  // ---------------------------------------------------------------------

  test("listReviewsForAccount returns own reviews with product name and order code inlined", async () => {
    const customerId = await seedCustomer(TENANT_A, "+6281200000015");
    const productId = await seedActiveProduct(TENANT_A, "review-product");
    const orderId = await seedOrder(
      TENANT_A,
      customerId,
      "ORD-REVIEW",
      "2026-02-01T00:00:00.000Z"
    );

    await inTenant(
      TENANT_A,
      (tx) =>
        tx`
          INSERT INTO awcms_commerce_order_items (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
          VALUES (${TENANT_A}, ${orderId}, ${productId}, 'Mie Gacoan', '10000.00', 1, '10000.00')
        `
    );

    const created = await inTenant(TENANT_A, (tx) =>
      createReview(
        tx,
        TENANT_A,
        "ORD-REVIEW",
        "+6281200000015",
        productId,
        5,
        "Mantap!"
      )
    );
    expect(created.kind).toBe("created");

    const reviews = await inTenant(TENANT_A, (tx) =>
      listReviewsForAccount(tx, TENANT_A, customerId)
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.productName).toBe("Mie Gacoan");
    expect(reviews[0]!.orderCode).toBe("ORD-REVIEW");
    expect(reviews[0]!.status).toBe("pending");
  });

  // ---------------------------------------------------------------------
  // RLS — tenant B cannot see tenant A's rows
  // ---------------------------------------------------------------------

  test("RLS: addresses/wishlist/orders created under tenant A are invisible under tenant B, even with tenant A's own customerId", async () => {
    const customerId = await seedCustomer(TENANT_A, "+6281200000016");
    const productId = await seedActiveProduct(TENANT_A, "rls-product");
    const created = await inTenant(TENANT_A, (tx) =>
      createAccountAddress(tx, TENANT_A, customerId, addressInput())
    );
    if (created.kind !== "created") throw new Error("expected created");
    await inTenant(TENANT_A, (tx) =>
      mergeAccountWishlist(
        tx,
        TENANT_A,
        customerId,
        [productId],
        mediaLibraryPortAdapter
      )
    );
    await seedOrder(
      TENANT_A,
      customerId,
      "ORD-RLS",
      "2026-02-01T00:00:00.000Z"
    );

    // Every call below runs inside TENANT B's RLS context but is HANDED
    // tenant A's own tenantId/customerId as arguments — proving the
    // enforcement is the database's `FORCE ROW LEVEL SECURITY`, not merely
    // this module's own WHERE clause.
    const addresses = await inTenant(TENANT_B, (tx) =>
      listAccountAddresses(tx, TENANT_A, customerId)
    );
    expect(addresses).toHaveLength(0);

    const wishlist = await inTenant(TENANT_B, (tx) =>
      listAccountWishlist(tx, TENANT_A, customerId, mediaLibraryPortAdapter)
    );
    expect(wishlist).toHaveLength(0);

    const orders = await inTenant(TENANT_B, (tx) =>
      listOrdersForAccount(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        customerId,
        new Date("2020-01-01T00:00:00.000Z"),
        null,
        20
      )
    );
    expect(orders.items).toHaveLength(0);
  });
});
