/**
 * Commerce's adapter over the upstream inventory ledger (Issue #282,
 * ADR-0038) against a REAL migrated Postgres through
 * `tests/integration/harness.ts`. Gated on `DATABASE_URL`; skips cleanly without
 * one.
 *
 * Proves what only a database can:
 *
 *   - `counter` mode (the default) is today's behaviour and posts nothing;
 *   - the cut-over (dry-run by default) posts one opening per stock unit equal to
 *     its counter, skips zero-stock units and variant-bearing products, flips the
 *     mode atomically, verifies itself, and a second run is a refusal;
 *   - in `ledger` mode an order decrements the LEDGER and writes the cache
 *     through, an out-of-stock cart answers `cart_changed` with nothing left
 *     behind, and eight parallel orders for the last unit sell exactly one;
 *   - cancel and expiry (as the `awcms_worker` role) post `sale_return`; a
 *     return's restock posts through the ledger port and is idempotent;
 *   - a movement made by someone else (a receipt) reaches the cache through the
 *     domain-event consumer, and only for the sales location and `commerce.*`;
 *   - an admin stock edit / create / CSV import that would change a count is
 *     refused in ledger mode and accepted in counter mode;
 *   - reconciliation sees a forced drift and resync repairs it from the ledger;
 *     the rollback returns to counter mode;
 *   - RLS: another tenant can neither see the ledger rows nor point its settings
 *     at this tenant's location.
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
import { commerceInventoryPort } from "../../src/modules/commerce/application/commerce-inventory";
import {
  InventoryLedgerRefusedError,
  StockManagedByInventoryError,
  readInventoryConfig,
  resolveInventoryConfig
} from "../../src/modules/commerce/application/commerce-inventory";
import { projectStockCacheFromMovement } from "../../src/modules/commerce/application/commerce-inventory-cache-projector";
import {
  CutoverOpeningRefusedError,
  runCommerceInventoryCutover
} from "../../src/modules/commerce/application/commerce-inventory-cutover";
import {
  reconcileStockCache,
  resyncStockCache,
  rollbackToCounterMode
} from "../../src/modules/commerce/application/commerce-inventory-reconciliation";
import { dryRunCatalogImport } from "../../src/modules/commerce/application/catalog-import";
import {
  cancelOrderByCustomer,
  createOrderFromCart,
  expireOrdersForTenant,
  updateOrderStatusByAdmin
} from "../../src/modules/commerce/application/order-directory";
import {
  createPosOrder,
  PosCartChangedError
} from "../../src/modules/commerce/application/pos-directory";
import {
  createProduct,
  updateProduct
} from "../../src/modules/commerce/application/product-directory";
import {
  createProductVariant,
  updateProductVariant
} from "../../src/modules/commerce/application/product-variant-directory";
import { createReturn } from "../../src/modules/commerce/application/return-directory";
import {
  ledgerInventoryPort,
  modeAwareInventoryPort
} from "../../src/modules/commerce/application/return-inventory-port";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import type { CreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import type { CreatePosOrderInput } from "../../src/modules/commerce/domain/pos-order-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import { postOpeningThroughInventory } from "../../scripts/commerce-inventory-cutover";
import {
  assertRejected,
  getAdminSql,
  getRuntimeSql,
  getWorkerRoleSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase,
  workerRoleActivated
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a282";
const TENANT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b282";
const STAFF = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c282";
const LOC_SALES = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d282";
const LOC_WAREHOUSE = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e282";
const LOC_B = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f282";
const NOW = new Date("2026-10-05T10:00:00.000Z");

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-INV",
  name: "Kopi Susu",
  slug: "kopi-susu-inv",
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

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedStaff(tenantId: string): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Inventory Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`inv-actor-${tenantId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${STAFF}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedLocation(
  tenantId: string,
  id: string,
  code: string,
  status = "active"
): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_inventory_locations (id, tenant_id, code, name, status)
    VALUES (${id}, ${tenantId}, ${code}, ${code}, ${status})
  `;
}

async function enableStore(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Uji",
    shipping: { selfPickup: true },
    payment: { manualQris: { active: true, mediaObjectId: null } }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, STAFF, validated.value)
  );
}

let productSeq = 0;

async function seedProduct(
  tenantId: string,
  stock: number,
  overrides: Partial<CreateProductInput> = {}
): Promise<string> {
  productSeq += 1;
  const product = await inTenant(tenantId, (tx) =>
    createProduct(tx, tenantId, STAFF, {
      ...BASE_PRODUCT,
      sku: `SKU-INV-${productSeq}`,
      slug: `kopi-susu-inv-${productSeq}`,
      stock,
      ...overrides
    })
  );
  await getAdminSql()`
    UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}
  `;
  return product.id;
}

async function seedVariant(
  tenantId: string,
  productId: string,
  stock: number,
  value: string
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_product_variants
      (tenant_id, product_id, name, value, stock)
    VALUES (${tenantId}, ${productId}, 'Size', ${value}, ${stock})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function stockOf(productId: string): Promise<number> {
  const rows = (await getAdminSql()`
    SELECT stock FROM awcms_commerce_products WHERE id = ${productId}
  `) as { stock: number }[];
  return Number(rows[0]!.stock);
}

async function variantStockOf(variantId: string): Promise<number> {
  const rows = (await getAdminSql()`
    SELECT stock FROM awcms_commerce_product_variants WHERE id = ${variantId}
  `) as { stock: number }[];
  return Number(rows[0]!.stock);
}

async function onHand(
  tenantId: string,
  locationId: string,
  itemType: string,
  itemRef: string
): Promise<string> {
  return inTenant(tenantId, (tx) =>
    commerceInventoryPort().getOnHand(tx, tenantId, locationId, {
      itemType,
      itemRef,
      unitCode: "unit"
    })
  );
}

async function movements(
  tenantId: string,
  filter: { itemRef?: string; type?: string } = {}
): Promise<
  {
    movement_type: string;
    quantity_delta: string;
    source_type: string;
    source_id: string;
    source_line: string;
    item_ref: string;
    location_id: string;
  }[]
> {
  const rows = (await getAdminSql()`
    SELECT movement_type, trim_scale(quantity_delta)::text AS quantity_delta, source_type,
           source_id, source_line, item_ref, location_id
    FROM awcms_inventory_movements
    WHERE tenant_id = ${tenantId}
      AND (${filter.itemRef ?? null}::text IS NULL OR item_ref = ${filter.itemRef ?? null})
      AND (${filter.type ?? null}::text IS NULL OR movement_type = ${filter.type ?? null})
    ORDER BY created_at, id
  `) as never[];
  return rows;
}

async function cutover(
  tenantId: string,
  locationId: string,
  commit: boolean
): Promise<
  Awaited<ReturnType<typeof runCommerceInventoryCutover>> | "rolled_back"
> {
  class Rollback extends Error {}
  try {
    return await inTenant(tenantId, async (tx) => {
      const result = await runCommerceInventoryCutover(
        tx,
        tenantId,
        locationId,
        postOpeningThroughInventory,
        "cutover-test"
      );
      if (!commit) throw new Rollback();
      return result;
    });
  } catch (error) {
    if (error instanceof Rollback) return "rolled_back";
    throw error;
  }
}

function orderInput(
  productId: string,
  overrides: Partial<CreateOrderInput> = {},
  quantity = 2,
  variantId: string | null = null
): CreateOrderInput {
  return {
    idempotencyKey: crypto.randomUUID(),
    customer: { name: "Siti", phone: "0812-3456-7890", email: null },
    address: null,
    lines: [{ productId, variantId, quantity, serviceFormValues: null }],
    shipping: { method: "self_pickup" },
    payment: { method: "manual_qris" },
    voucherCode: null,
    insurance: false,
    notes: null,
    affiliateCode: null,
    ...overrides
  };
}

function shopper(index: number) {
  return {
    name: `Shopper ${index}`,
    phone: `08123456${String(7000 + index)}`,
    email: null
  };
}

function placeOrder(
  tenantId: string,
  input: CreateOrderInput,
  correlationId?: string
) {
  return inTenant(tenantId, (tx) =>
    createOrderFromCart(
      tx,
      tenantId,
      mediaLibraryPortAdapter,
      input,
      NOW,
      correlationId
    )
  );
}

suite("commerce inventory adapter integration (Issue #282)", () => {
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
    await seedStaff(TENANT_A);
    await seedLocation(TENANT_A, LOC_SALES, "sales");
    await seedLocation(TENANT_A, LOC_WAREHOUSE, "warehouse");
    await seedLocation(TENANT_B, LOC_B, "sales-b");
    await enableStore(TENANT_A);
  }, 60000);

  // -------------------------------------------------------------------------
  describe("counter mode (the default) is unchanged", () => {
    test("the mode defaults to counter, an order decrements the counter and posts nothing", async () => {
      const productId = await seedProduct(TENANT_A, 10);
      expect(
        await inTenant(TENANT_A, (tx) => readInventoryConfig(tx, TENANT_A))
      ).toMatchObject({ mode: "counter" });

      const outcome = await placeOrder(TENANT_A, orderInput(productId));
      expect(outcome.kind).toBe("created");
      expect(await stockOf(productId)).toBe(8);
      expect(await movements(TENANT_A)).toHaveLength(0);
    }, 30000);

    test("cancel restocks the counter, and an out-of-stock cart is still cart_changed", async () => {
      const productId = await seedProduct(TENANT_A, 3);
      const created = await placeOrder(TENANT_A, orderInput(productId, {}, 3));
      expect(created.kind).toBe("created");
      if (created.kind !== "created") return;
      expect(await stockOf(productId)).toBe(0);

      const refused = await placeOrder(TENANT_A, orderInput(productId, {}, 1));
      expect(refused.kind).toBe("cart_changed");

      await inTenant(TENANT_A, (tx) =>
        cancelOrderByCustomer(
          tx,
          TENANT_A,
          mediaLibraryPortAdapter,
          created.order.orderCode,
          "+6281234567890",
          null
        )
      );
      expect(await stockOf(productId)).toBe(3);
      expect(await movements(TENANT_A)).toHaveLength(0);
    }, 30000);

    test("admin stock edits and creates are accepted in counter mode", async () => {
      const productId = await seedProduct(TENANT_A, 10);
      const updated = await inTenant(TENANT_A, (tx) =>
        updateProduct(tx, TENANT_A, STAFF, productId, { stock: 40 })
      );
      expect(updated?.stock).toBe(40);
    }, 30000);
  });

  // -------------------------------------------------------------------------
  describe("the cut-over", () => {
    async function catalog() {
      const plain = await seedProduct(TENANT_A, 7);
      const zero = await seedProduct(TENANT_A, 0);
      const withVariants = await seedProduct(TENANT_A, 99);
      const variantA = await seedVariant(TENANT_A, withVariants, 4, "S");
      const variantB = await seedVariant(TENANT_A, withVariants, 0, "M");
      const variantC = await seedVariant(TENANT_A, withVariants, 6, "L");
      return { plain, zero, withVariants, variantA, variantB, variantC };
    }

    test("a dry run executes the whole path and changes nothing", async () => {
      await catalog();
      expect(await cutover(TENANT_A, LOC_SALES, false)).toBe("rolled_back");
      expect(await movements(TENANT_A)).toHaveLength(0);
      expect(
        await inTenant(TENANT_A, (tx) => readInventoryConfig(tx, TENANT_A))
      ).toMatchObject({ mode: "counter" });
    }, 60000);

    test("--commit posts one opening per positive unit equal to its counter, and flips the mode", async () => {
      const c = await catalog();
      const result = await cutover(TENANT_A, LOC_SALES, true);

      expect(result).toEqual({
        kind: "completed",
        units: 5, // plain, zero, variants A/B/C (the product WITH variants is not a unit)
        openings: 3,
        zeroUnits: 2,
        totalQuantity: 17
      });

      const openings = await movements(TENANT_A, { type: "opening" });
      expect(
        openings.map((m) => `${m.item_ref}=${m.quantity_delta}`).sort()
      ).toEqual([`${c.plain}=7`, `${c.variantA}=4`, `${c.variantC}=6`].sort());
      for (const opening of openings) {
        expect(opening.source_type).toBe("commerce_inventory_opening");
        expect(opening.source_id).toBe(TENANT_A);
        expect(opening.source_line).toBe(opening.item_ref);
        expect(opening.location_id).toBe(LOC_SALES);
      }
      // The product that has variants is not a unit: its own counter is left alone.
      expect(await stockOf(c.withVariants)).toBe(99);
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", c.withVariants)
      ).toBe("0");

      expect(
        await inTenant(TENANT_A, (tx) => readInventoryConfig(tx, TENANT_A))
      ).toMatchObject({ mode: "ledger", locationId: LOC_SALES });
      // The cache already equals the ledger.
      const report = await inTenant(TENANT_A, (tx) =>
        reconcileStockCache(tx, TENANT_A, null, 500)
      );
      expect("drift" in report && report.drift).toEqual([]);
    }, 60000);

    test("a second run is a refusal, never a second backfill", async () => {
      await catalog();
      await cutover(TENANT_A, LOC_SALES, true);
      const before = (await movements(TENANT_A)).length;
      expect(await cutover(TENANT_A, LOC_SALES, true)).toEqual({
        kind: "already_ledger"
      });
      expect((await movements(TENANT_A)).length).toBe(before);
    }, 60000);

    test("a refused opening (inactive location) throws and rolls the whole cut-over back", async () => {
      await getAdminSql()`
        UPDATE awcms_inventory_locations SET status = 'inactive' WHERE id = ${LOC_SALES}
      `;
      await catalog();
      await expect(cutover(TENANT_A, LOC_SALES, true)).rejects.toBeInstanceOf(
        CutoverOpeningRefusedError
      );
      expect(await movements(TENANT_A)).toHaveLength(0);
      expect(
        await inTenant(TENANT_A, (tx) => readInventoryConfig(tx, TENANT_A))
      ).toMatchObject({ mode: "counter" });
    }, 60000);

    test("the settings row the cut-over creates holds the real defaults, not an empty object", async () => {
      await getAdminSql()`DELETE FROM awcms_commerce_store_settings WHERE tenant_id = ${TENANT_A}`;
      await catalog();
      await cutover(TENANT_A, LOC_SALES, true);
      const rows = (await getAdminSql()`
        SELECT settings, deleted_at FROM awcms_commerce_store_settings WHERE tenant_id = ${TENANT_A}
      `) as { settings: Record<string, unknown>; deleted_at: Date | null }[];
      expect(Object.keys(rows[0]!.settings).length).toBeGreaterThan(3);
      expect(rows[0]!.deleted_at).toBeNull();
    }, 60000);

    test("resetting the store settings in ledger mode keeps the row live, so retention cannot purge the mode", async () => {
      await catalog();
      await cutover(TENANT_A, LOC_SALES, true);
      const { resetStoreSettings } =
        await import("../../src/modules/commerce/application/store-settings-directory");
      await inTenant(TENANT_A, (tx) => resetStoreSettings(tx, TENANT_A, STAFF));
      const rows = (await getAdminSql()`
        SELECT inventory_mode, deleted_at FROM awcms_commerce_store_settings WHERE tenant_id = ${TENANT_A}
      `) as { inventory_mode: string; deleted_at: Date | null }[];
      expect(rows[0]).toMatchObject({
        inventory_mode: "ledger",
        deleted_at: null
      });
    }, 60000);
  });

  // -------------------------------------------------------------------------
  describe("ledger mode", () => {
    async function ledgerStore(stock = 10) {
      const productId = await seedProduct(TENANT_A, stock);
      await cutover(TENANT_A, LOC_SALES, true);
      return productId;
    }

    test("an order sells out of the ledger and writes the cache through", async () => {
      const productId = await ledgerStore(10);
      const outcome = await placeOrder(
        TENANT_A,
        orderInput(productId),
        "corr-1"
      );
      expect(outcome.kind).toBe("created");
      if (outcome.kind !== "created") return;

      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", productId)
      ).toBe("8");
      expect(await stockOf(productId)).toBe(8);

      const sales = await movements(TENANT_A, { type: "sale" });
      expect(sales).toHaveLength(1);
      expect(sales[0]).toMatchObject({
        quantity_delta: "-2",
        source_type: "commerce_order",
        item_ref: productId
      });
      const items = (await getAdminSql()`
        SELECT id, order_id FROM awcms_commerce_order_items WHERE tenant_id = ${TENANT_A}
      `) as { id: string; order_id: string }[];
      expect(sales[0]!.source_id).toBe(items[0]!.order_id);
      expect(sales[0]!.source_line).toBe(items[0]!.id);

      const corr = (await getAdminSql()`
        SELECT correlation_id FROM awcms_inventory_movements WHERE tenant_id = ${TENANT_A} AND movement_type = 'sale'
      `) as { correlation_id: string }[];
      expect(corr[0]!.correlation_id).toBe("corr-1");
    }, 60000);

    test("a variant line sells the variant's unit", async () => {
      const productId = await seedProduct(TENANT_A, 0);
      const variantId = await seedVariant(TENANT_A, productId, 5, "L");
      await cutover(TENANT_A, LOC_SALES, true);
      const outcome = await placeOrder(
        TENANT_A,
        orderInput(productId, {}, 2, variantId)
      );
      expect(outcome.kind).toBe("created");
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.variant", variantId)
      ).toBe("3");
      expect(await variantStockOf(variantId)).toBe(3);
    }, 60000);

    test("a replay of the same idempotency key posts nothing twice", async () => {
      const productId = await ledgerStore(10);
      const input = orderInput(productId);
      expect((await placeOrder(TENANT_A, input)).kind).toBe("created");
      expect((await placeOrder(TENANT_A, input)).kind).toBe("replayed");
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", productId)
      ).toBe("8");
      expect(await movements(TENANT_A, { type: "sale" })).toHaveLength(1);
    }, 60000);

    test("insufficient ledger stock is cart_changed, the whole order rolls back and the cache is corrected", async () => {
      const productId = await ledgerStore(1);
      // Drift: the cache claims 10 while the ledger holds 1, so the quote passes
      // and only the LEDGER can refuse.
      await getAdminSql()`UPDATE awcms_commerce_products SET stock = 10 WHERE id = ${productId}`;

      const outcome = await placeOrder(TENANT_A, orderInput(productId, {}, 2));
      expect(outcome.kind).toBe("cart_changed");
      if (outcome.kind === "cart_changed") {
        expect(outcome.quote.canCheckout).toBe(false);
      }

      const orders = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_orders WHERE tenant_id = ${TENANT_A}
      `) as { n: number }[];
      expect(orders[0]!.n).toBe(0);
      expect(await movements(TENANT_A, { type: "sale" })).toHaveLength(0);
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", productId)
      ).toBe("1");
      // The refusal re-read the ledger: the cache is true again.
      expect(await stockOf(productId)).toBe(1);
    }, 60000);

    test("a multi-line order where line 2 is refused leaves line 1 unsold (all or nothing)", async () => {
      const first = await seedProduct(TENANT_A, 5);
      const second = await seedProduct(TENANT_A, 1);
      await cutover(TENANT_A, LOC_SALES, true);
      await getAdminSql()`UPDATE awcms_commerce_products SET stock = 9 WHERE id = ${second}`;

      const outcome = await placeOrder(TENANT_A, {
        ...orderInput(first),
        lines: [
          {
            productId: first,
            variantId: null,
            quantity: 2,
            serviceFormValues: null
          },
          {
            productId: second,
            variantId: null,
            quantity: 3,
            serviceFormValues: null
          }
        ]
      });
      expect(outcome.kind).toBe("cart_changed");
      expect(await onHand(TENANT_A, LOC_SALES, "commerce.product", first)).toBe(
        "5"
      );
      expect(await movements(TENANT_A, { type: "sale" })).toHaveLength(0);
    }, 60000);

    test("eight parallel orders for the last unit sell exactly one", async () => {
      const productId = await ledgerStore(1);
      // One phone per shopper: the customer find-or-create is a pre-existing
      // unique-key race for the SAME phone, unrelated to stock.
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          placeOrder(
            TENANT_A,
            orderInput(productId, { customer: shopper(index) }, 1)
          )
        )
      );
      expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "cart_changed")).toHaveLength(7);
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", productId)
      ).toBe("0");
      expect(await stockOf(productId)).toBe(0);
      const orders = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_orders WHERE tenant_id = ${TENANT_A}
      `) as { n: number }[];
      expect(orders[0]!.n).toBe(1);
      expect(await movements(TENANT_A, { type: "sale" })).toHaveLength(1);
    }, 90000);

    test("orders whose lines are in opposite cart order never deadlock", async () => {
      const a = await seedProduct(TENANT_A, 50);
      const b = await seedProduct(TENANT_A, 50);
      await cutover(TENANT_A, LOC_SALES, true);
      const line = (productId: string) => ({
        productId,
        variantId: null,
        quantity: 1,
        serviceFormValues: null
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          placeOrder(TENANT_A, {
            ...orderInput(a, { customer: shopper(index) }),
            lines: index % 2 === 0 ? [line(a), line(b)] : [line(b), line(a)]
          })
        )
      );
      expect(results.every((r) => r.kind === "created")).toBe(true);
      expect(await onHand(TENANT_A, LOC_SALES, "commerce.product", a)).toBe(
        "40"
      );
      expect(await onHand(TENANT_A, LOC_SALES, "commerce.product", b)).toBe(
        "40"
      );
    }, 90000);

    test("a POS sale posts the same commerce_order identity; out of stock is PosCartChangedError and leaves nothing", async () => {
      const productId = await ledgerStore(5);
      const input: CreatePosOrderInput = {
        idempotencyKey: crypto.randomUUID(),
        customer: { name: null, phone: null },
        lines: [{ productId, variantId: null, quantity: 2 }],
        payment: { method: "cash", amountTendered: "50000.00" },
        tenders: null,
        allowDue: false,
        notes: null
      };
      const sold = await inTenant(TENANT_A, (tx) =>
        createPosOrder(
          tx,
          TENANT_A,
          STAFF,
          mediaLibraryPortAdapter,
          input,
          NOW,
          "corr-pos"
        )
      );
      expect(sold.kind).toBe("created");
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", productId)
      ).toBe("3");
      expect(await stockOf(productId)).toBe(3);
      const sales = await movements(TENANT_A, { type: "sale" });
      expect(sales[0]).toMatchObject({
        source_type: "commerce_order",
        quantity_delta: "-2"
      });

      await getAdminSql()`UPDATE awcms_commerce_products SET stock = 50 WHERE id = ${productId}`;
      await expect(
        inTenant(TENANT_A, (tx) =>
          createPosOrder(
            tx,
            TENANT_A,
            STAFF,
            mediaLibraryPortAdapter,
            {
              ...input,
              idempotencyKey: crypto.randomUUID(),
              lines: [{ productId, variantId: null, quantity: 10 }],
              payment: { method: "cash", amountTendered: "500000.00" }
            },
            NOW
          )
        )
      ).rejects.toBeInstanceOf(PosCartChangedError);
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", productId)
      ).toBe("3");
      const orders = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_orders WHERE tenant_id = ${TENANT_A}
      `) as { n: number }[];
      expect(orders[0]!.n).toBe(1);
    }, 60000);

    test("cancel posts a sale_return per line and restores the cache", async () => {
      const productId = await ledgerStore(10);
      const created = await placeOrder(TENANT_A, orderInput(productId, {}, 4));
      if (created.kind !== "created") throw new Error("expected an order");
      expect(await stockOf(productId)).toBe(6);

      await inTenant(TENANT_A, (tx) =>
        cancelOrderByCustomer(
          tx,
          TENANT_A,
          mediaLibraryPortAdapter,
          created.order.orderCode,
          "+6281234567890",
          null,
          "corr-cancel"
        )
      );
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", productId)
      ).toBe("10");
      expect(await stockOf(productId)).toBe(10);
      const returns = await movements(TENANT_A, { type: "sale_return" });
      expect(returns).toHaveLength(1);
      expect(returns[0]).toMatchObject({
        source_type: "commerce_order_restock",
        quantity_delta: "4"
      });
    }, 60000);

    test("an admin status change to cancelled restocks through the ledger too", async () => {
      const productId = await ledgerStore(10);
      const created = await placeOrder(TENANT_A, orderInput(productId, {}, 3));
      if (created.kind !== "created") throw new Error("expected an order");
      const orderId = (
        (await getAdminSql()`SELECT id FROM awcms_commerce_orders WHERE tenant_id = ${TENANT_A}`) as {
          id: string;
        }[]
      )[0]!.id;
      await inTenant(TENANT_A, (tx) =>
        updateOrderStatusByAdmin(
          tx,
          TENANT_A,
          STAFF,
          orderId,
          "cancelled",
          null
        )
      );
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", productId)
      ).toBe("10");
      expect(await stockOf(productId)).toBe(10);
    }, 60000);

    test("the expiry job restocks through the ledger as the awcms_worker role", async () => {
      if (!workerRoleActivated) return;
      const productId = await ledgerStore(10);
      const created = await placeOrder(TENANT_A, orderInput(productId, {}, 5));
      expect(created.kind).toBe("created");
      expect(await stockOf(productId)).toBe(5);

      const result = await expireOrdersForTenant(
        getWorkerRoleSql(),
        TENANT_A,
        new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 30)
      );
      expect(result.expiredCount).toBe(1);
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", productId)
      ).toBe("10");
      expect(await stockOf(productId)).toBe(10);
      expect(await movements(TENANT_A, { type: "sale_return" })).toHaveLength(
        1
      );
    }, 60000);

    test("a ledger refusal on one order's restock leaves THAT order pending and does not abort the batch", async () => {
      if (!workerRoleActivated) return;
      const productId = await ledgerStore(10);
      const first = await placeOrder(TENANT_A, orderInput(productId, {}, 1));
      const second = await placeOrder(TENANT_A, orderInput(productId, {}, 1));
      expect(first.kind).toBe("created");
      expect(second.kind).toBe("created");
      // The sales location is deactivated: every restock is refused.
      await getAdminSql()`UPDATE awcms_inventory_locations SET status = 'inactive' WHERE id = ${LOC_SALES}`;

      const result = await expireOrdersForTenant(
        getWorkerRoleSql(),
        TENANT_A,
        new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 30)
      );
      expect(result.expiredCount).toBe(0);
      const statuses = (await getAdminSql()`
        SELECT status FROM awcms_commerce_orders WHERE tenant_id = ${TENANT_A}
      `) as { status: string }[];
      expect(statuses.every((row) => row.status === "pending_payment")).toBe(
        true
      );
    }, 60000);
  });

  // -------------------------------------------------------------------------
  describe("returns", () => {
    async function paidOrder(productId: string, quantity: number) {
      const customerRows = (await getAdminSql()`
        INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
        VALUES (${TENANT_A}, 'Budi', '+6281234567282')
        RETURNING id
      `) as { id: string }[];
      const customerId = customerRows[0]!.id;
      const orderRows = (await getAdminSql()`
        INSERT INTO awcms_commerce_orders
          (tenant_id, order_code, customer_id, status, payment_method, payment_status,
           shipping_method, shipping_cost, subtotal, discount, voucher_discount, total, paid_at)
        VALUES (${TENANT_A}, 'INV-0001', ${customerId}, 'paid', 'manual_bank', 'paid',
          'self_pickup', 0.00, ${quantity * 10000}, 0.00, 0.00, ${quantity * 10000}, now())
        RETURNING id
      `) as { id: string }[];
      const orderId = orderRows[0]!.id;
      const itemRows = (await getAdminSql()`
        INSERT INTO awcms_commerce_order_items
          (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
        VALUES (${TENANT_A}, ${orderId}, ${productId}, 'Kopi', 10000.00, ${quantity}, ${quantity * 10000})
        RETURNING id
      `) as { id: string }[];
      await getAdminSql()`
        INSERT INTO awcms_commerce_order_events (tenant_id, order_id, from_status, to_status, actor)
        VALUES (${TENANT_A}, ${orderId}, 'pending_payment', 'paid', 'admin')
      `;
      return { orderId, itemId: itemRows[0]!.id };
    }

    test("a return's restock posts commerce_return sale_returns through ledgerInventoryPort, and a replay does not double", async () => {
      const productId = await seedProduct(TENANT_A, 10);
      await cutover(TENANT_A, LOC_SALES, true);
      const config = { mode: "ledger" as const, locationId: LOC_SALES };
      const lines = [
        {
          returnId: "11111111-1111-4111-8111-111111111111",
          returnLineId: "22222222-2222-4222-8222-222222222222",
          productId,
          variantId: null,
          quantity: 3,
          disposition: "restock" as const
        },
        {
          returnId: "11111111-1111-4111-8111-111111111111",
          returnLineId: "33333333-3333-4333-8333-333333333333",
          productId,
          variantId: null,
          quantity: 9,
          disposition: "damaged" as const
        }
      ];

      const first = await inTenant(TENANT_A, (tx) =>
        ledgerInventoryPort(config).applyReturn(tx, TENANT_A, lines, {
          actorTenantUserId: STAFF,
          correlationId: "corr-ret"
        })
      );
      expect(first.restockedUnits).toBe(3);
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", productId)
      ).toBe("13");
      expect(await stockOf(productId)).toBe(13);

      const posted = await movements(TENANT_A, { type: "sale_return" });
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        source_type: "commerce_return",
        source_id: "11111111-1111-4111-8111-111111111111",
        source_line: "22222222-2222-4222-8222-222222222222"
      });

      const replay = await inTenant(TENANT_A, (tx) =>
        ledgerInventoryPort(config).applyReturn(tx, TENANT_A, lines)
      );
      expect(replay.restockedUnits).toBe(3);
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", productId)
      ).toBe("13");
    }, 60000);

    test("createReturn in ledger mode restocks the ledger; in counter mode the counter (mode-aware default)", async () => {
      const productId = await seedProduct(TENANT_A, 10);
      await inTenant(TENANT_A, (tx) =>
        updateModuleSettings(
          tx,
          TENANT_A,
          "commerce",
          { features: { returns: true } },
          STAFF
        )
      );
      const counterOrder = await paidOrder(productId, 2);
      const counterReturn = await inTenant(TENANT_A, (tx) =>
        createReturn(
          tx,
          TENANT_A,
          STAFF,
          counterOrder.orderId,
          {
            idempotencyKey: crypto.randomUUID(),
            kind: "return",
            lines: [
              {
                orderItemId: counterOrder.itemId,
                quantity: 1,
                reason: "defective" as never,
                disposition: "restock",
                note: null
              }
            ],
            note: null,
            refund: null,
            exchangeOrderId: null
          },
          NOW
        )
      );
      expect(counterReturn.kind).toBe("created");
      expect(await stockOf(productId)).toBe(11);
      expect(await movements(TENANT_A)).toHaveLength(0);

      await cutover(TENANT_A, LOC_SALES, true);
      const ledgerReturn = await inTenant(TENANT_A, (tx) =>
        createReturn(
          tx,
          TENANT_A,
          STAFF,
          counterOrder.orderId,
          {
            idempotencyKey: crypto.randomUUID(),
            kind: "return",
            lines: [
              {
                orderItemId: counterOrder.itemId,
                quantity: 1,
                reason: "defective" as never,
                disposition: "restock",
                note: null
              }
            ],
            note: null,
            refund: null,
            exchangeOrderId: null
          },
          NOW,
          "corr-return"
        )
      );
      expect(ledgerReturn.kind).toBe("created");
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", productId)
      ).toBe("12");
      expect(await stockOf(productId)).toBe(12);
      const rows = await movements(TENANT_A, { type: "sale_return" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source_type).toBe("commerce_return");
    }, 90000);

    test("the mode-aware port picks counter or ledger per tenant", async () => {
      const productId = await seedProduct(TENANT_A, 10);
      const line = {
        returnId: "11111111-1111-4111-8111-111111111111",
        returnLineId: "22222222-2222-4222-8222-222222222222",
        productId,
        variantId: null,
        quantity: 2,
        disposition: "restock" as const
      };
      await inTenant(TENANT_A, (tx) =>
        modeAwareInventoryPort.applyReturn(tx, TENANT_A, [line])
      );
      expect(await stockOf(productId)).toBe(12);
      expect(await movements(TENANT_A)).toHaveLength(0);
    }, 60000);
  });

  // -------------------------------------------------------------------------
  describe("a movement made by someone else reaches the cache (D4)", () => {
    async function receive(
      locationId: string,
      itemType: string,
      itemRef: string,
      quantity: string,
      id: string
    ) {
      await inTenant(TENANT_A, (tx) =>
        commerceInventoryPort().postReceipt(tx, TENANT_A, null, {
          itemType,
          itemRef,
          unitCode: "unit",
          locationId,
          quantity,
          source: { type: "procurement_receipt", id, line: "1" }
        })
      );
    }

    async function dispatch() {
      const sql = workerRoleActivated ? getWorkerRoleSql() : getRuntimeSql();
      for (let pass = 0; pass < 3; pass += 1) {
        await dispatchDomainEventsForTenant(sql, TENANT_A, { limit: 100 });
      }
    }

    test("a receipt at the sales location refreshes the cache once the dispatcher runs", async () => {
      const productId = await seedProduct(TENANT_A, 10);
      await cutover(TENANT_A, LOC_SALES, true);
      await dispatch(); // drain the opening's own delivery
      await receive(LOC_SALES, "commerce.product", productId, "15", "r-1");
      expect(await stockOf(productId)).toBe(10); // not yet: the cache is event-driven
      await dispatch();
      expect(await stockOf(productId)).toBe(25);
    }, 90000);

    test("a receipt at another location, of another item type, or for a counter-mode tenant changes nothing", async () => {
      const productId = await seedProduct(TENANT_A, 10);
      await cutover(TENANT_A, LOC_SALES, true);
      await dispatch();
      await receive(LOC_WAREHOUSE, "commerce.product", productId, "40", "r-2");
      await receive(LOC_SALES, "pos.item", productId, "40", "r-3");
      await dispatch();
      expect(await stockOf(productId)).toBe(10);

      // Directly: a counter-mode tenant (rolled back) is ignored too.
      await inTenant(TENANT_A, (tx) =>
        rollbackToCounterMode(tx, TENANT_A, STAFF)
      );
      await receive(LOC_SALES, "commerce.product", productId, "5", "r-4");
      await dispatch();
      expect(await stockOf(productId)).toBe(10);
    }, 90000);

    test("the projector re-reads the ledger and never trusts the payload", async () => {
      const productId = await seedProduct(TENANT_A, 10);
      await cutover(TENANT_A, LOC_SALES, true);
      await receive(LOC_SALES, "commerce.product", productId, "5", "r-5");
      // A stale/forged payload that claims a different balance.
      await inTenant(TENANT_A, (tx) =>
        projectStockCacheFromMovement(tx, TENANT_A, {
          itemType: "commerce.product",
          itemRef: productId,
          locationId: LOC_SALES,
          balanceAfter: "999999"
        })
      );
      expect(await stockOf(productId)).toBe(15);
    }, 60000);

    test("redelivery is idempotent", async () => {
      const productId = await seedProduct(TENANT_A, 10);
      await cutover(TENANT_A, LOC_SALES, true);
      await receive(LOC_SALES, "commerce.product", productId, "5", "r-6");
      await dispatch();
      await dispatch();
      expect(await stockOf(productId)).toBe(15);
    }, 60000);
  });

  // -------------------------------------------------------------------------
  describe("admin edits and imports (D6)", () => {
    test("a stock change is refused in ledger mode, the unchanged value is accepted", async () => {
      const productId = await seedProduct(TENANT_A, 10);
      const variantProduct = await seedProduct(TENANT_A, 0);
      const variantId = await seedVariant(TENANT_A, variantProduct, 3, "M");
      await cutover(TENANT_A, LOC_SALES, true);

      await expect(
        inTenant(TENANT_A, (tx) =>
          updateProduct(tx, TENANT_A, STAFF, productId, { stock: 99 })
        )
      ).rejects.toBeInstanceOf(StockManagedByInventoryError);
      expect(await stockOf(productId)).toBe(10);

      const same = await inTenant(TENANT_A, (tx) =>
        updateProduct(tx, TENANT_A, STAFF, productId, {
          stock: 10,
          name: "Renamed"
        })
      );
      expect(same?.name).toBe("Renamed");

      await expect(
        inTenant(TENANT_A, (tx) =>
          updateProductVariant(tx, TENANT_A, STAFF, variantProduct, variantId, {
            stock: 50
          })
        )
      ).rejects.toBeInstanceOf(StockManagedByInventoryError);
      expect(await variantStockOf(variantId)).toBe(3);

      await expect(seedProduct(TENANT_A, 5)).rejects.toBeInstanceOf(
        StockManagedByInventoryError
      );
      // A new product may start at zero; stock then arrives as a receipt.
      expect(await seedProduct(TENANT_A, 0)).toBeTruthy();
      await expect(
        inTenant(TENANT_A, (tx) =>
          createProductVariant(tx, TENANT_A, STAFF, productId, {
            name: "Size",
            value: "XL",
            colorHex: null,
            imageMediaObjectId: null,
            sku: null,
            price: null,
            priceLevel2: null,
            priceLevel3: null,
            priceLevel4: null,
            stock: 7,
            weightGrams: 0,
            sortOrder: 0
          })
        )
      ).rejects.toBeInstanceOf(StockManagedByInventoryError);
    }, 90000);

    test("the CSV import dry run reports a stock change as a row error in ledger mode only", async () => {
      await seedProduct(TENANT_A, 10);
      const sku = (
        (await getAdminSql()`SELECT sku FROM awcms_commerce_products WHERE tenant_id = ${TENANT_A}`) as {
          sku: string;
        }[]
      )[0]!.sku;
      const csv = `sku,stock\n${sku},99\n`;
      const counter = await inTenant(TENANT_A, (tx) =>
        dryRunCatalogImport(tx, TENANT_A, csv)
      );
      expect(counter.summary.error).toBe(0);

      await cutover(TENANT_A, LOC_SALES, true);
      const ledger = await inTenant(TENANT_A, (tx) =>
        dryRunCatalogImport(tx, TENANT_A, csv)
      );
      expect(ledger.summary.error).toBe(1);
      expect(JSON.stringify(ledger.rows)).toContain("inventory ledger");

      const unchanged = await inTenant(TENANT_A, (tx) =>
        dryRunCatalogImport(tx, TENANT_A, `sku,stock\n${sku},10\n`)
      );
      expect(unchanged.summary.error).toBe(0);
    }, 90000);
  });

  // -------------------------------------------------------------------------
  describe("reconciliation, resync and rollback (D7)", () => {
    test("a forced drift is reported and the resync repairs it from the ledger", async () => {
      const a = await seedProduct(TENANT_A, 10);
      const b = await seedProduct(TENANT_A, 4);
      await cutover(TENANT_A, LOC_SALES, true);
      await getAdminSql()`UPDATE awcms_commerce_products SET stock = 77 WHERE id = ${a}`;
      await getAdminSql()`UPDATE awcms_commerce_products SET stock = 0 WHERE id = ${b}`;

      const report = await inTenant(TENANT_A, (tx) =>
        reconcileStockCache(tx, TENANT_A, null, 100)
      );
      if (!("drift" in report)) throw new Error("expected a report");
      expect(report.scanned).toBe(2);
      expect(
        report.drift
          .map((d) => `${d.itemRef}:${d.cached}->${d.expected}`)
          .sort()
      ).toEqual([`${a}:77->10`, `${b}:0->4`].sort());

      const repaired = await inTenant(TENANT_A, (tx) =>
        resyncStockCache(tx, TENANT_A, STAFF, null, 100, "corr-resync")
      );
      if (!("repaired" in repaired)) throw new Error("expected a repair");
      expect(repaired.repaired).toBe(2);
      expect(await stockOf(a)).toBe(10);
      expect(await stockOf(b)).toBe(4);

      const again = await inTenant(TENANT_A, (tx) =>
        reconcileStockCache(tx, TENANT_A, null, 100)
      );
      expect("drift" in again && again.drift).toEqual([]);
      const second = await inTenant(TENANT_A, (tx) =>
        resyncStockCache(tx, TENANT_A, STAFF, null, 100)
      );
      expect("repaired" in second && second.repaired).toBe(0);

      const audit = (await getAdminSql()`
        SELECT severity FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'inventory.resync'
      `) as { severity: string }[];
      expect(audit.length).toBeGreaterThanOrEqual(1);
      expect(audit[0]!.severity).toBe("warning");
    }, 90000);

    test("a negative or fractional ledger balance floors the cache at zero / whole units", async () => {
      const a = await seedProduct(TENANT_A, 3);
      await cutover(TENANT_A, LOC_SALES, true);
      await inTenant(TENANT_A, (tx) =>
        commerceInventoryPort().postReceipt(tx, TENANT_A, null, {
          itemType: "commerce.product",
          itemRef: a,
          unitCode: "unit",
          locationId: LOC_SALES,
          quantity: "0.5",
          source: { type: "procurement_receipt", id: "frac", line: "1" }
        })
      );
      const report = await inTenant(TENANT_A, (tx) =>
        reconcileStockCache(tx, TENANT_A, null, 100)
      );
      // 3.5 on hand -> cache 3 is correct, so no drift.
      expect("drift" in report && report.drift).toEqual([]);
    }, 60000);

    test("reconciliation pages by cursor", async () => {
      await seedProduct(TENANT_A, 1);
      await seedProduct(TENANT_A, 1);
      await seedProduct(TENANT_A, 1);
      await cutover(TENANT_A, LOC_SALES, true);
      const first = await inTenant(TENANT_A, (tx) =>
        reconcileStockCache(tx, TENANT_A, null, 2)
      );
      if (!("scanned" in first)) throw new Error("expected a page");
      expect(first.scanned).toBe(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await inTenant(TENANT_A, (tx) =>
        reconcileStockCache(tx, TENANT_A, first.nextCursor, 2)
      );
      if (!("scanned" in second)) throw new Error("expected a page");
      expect(second.scanned).toBe(1);
      expect(second.nextCursor).toBeNull();
      expect(
        await inTenant(TENANT_A, (tx) =>
          reconcileStockCache(tx, TENANT_A, "garbage", 2)
        )
      ).toEqual({ kind: "invalid_cursor" });
    }, 60000);

    test("a counter-mode tenant has nothing to reconcile", async () => {
      expect(
        await inTenant(TENANT_A, (tx) =>
          reconcileStockCache(tx, TENANT_A, null, 10)
        )
      ).toEqual({ kind: "not_ledger_mode" });
      expect(
        await inTenant(TENANT_A, (tx) =>
          resyncStockCache(tx, TENANT_A, STAFF, null, 10)
        )
      ).toEqual({ kind: "not_ledger_mode" });
    }, 30000);

    test("the rollback returns to counter mode (audited, idempotent) and the counter paths resume from the cache", async () => {
      const productId = await seedProduct(TENANT_A, 10);
      await cutover(TENANT_A, LOC_SALES, true);
      expect(
        await inTenant(TENANT_A, (tx) =>
          rollbackToCounterMode(tx, TENANT_A, STAFF, "corr-rb")
        )
      ).toEqual({ changed: true });
      expect(
        await inTenant(TENANT_A, (tx) =>
          rollbackToCounterMode(tx, TENANT_A, STAFF)
        )
      ).toEqual({ changed: false });

      const outcome = await placeOrder(TENANT_A, orderInput(productId, {}, 4));
      expect(outcome.kind).toBe("created");
      expect(await stockOf(productId)).toBe(6);
      expect(await movements(TENANT_A, { type: "sale" })).toHaveLength(0);

      const audit = (await getAdminSql()`
        SELECT severity FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'inventory.rollback'
      `) as { severity: string }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]!.severity).toBe("warning");
    }, 60000);
  });

  // -------------------------------------------------------------------------
  describe("RLS and tenancy", () => {
    test("another tenant cannot see this tenant's movements or point its settings at its location", async () => {
      const productId = await seedProduct(TENANT_A, 5);
      await cutover(TENANT_A, LOC_SALES, true);

      const seen = (await inTenant(
        TENANT_B,
        (tx) => tx`SELECT count(*)::int AS n FROM awcms_inventory_movements`
      )) as { n: number }[];
      expect(seen[0]!.n).toBe(0);
      expect(
        await onHand(TENANT_B, LOC_SALES, "commerce.product", productId)
      ).toBe("0");

      // The composite FK refuses another tenant's location even for a superuser.
      await getAdminSql()`
        INSERT INTO awcms_commerce_store_settings (tenant_id) VALUES (${TENANT_B})
        ON CONFLICT (tenant_id) DO NOTHING
      `;
      await assertRejected(
        getAdminSql()`
          UPDATE awcms_commerce_store_settings
          SET inventory_mode = 'ledger', inventory_location_id = ${LOC_SALES}
          WHERE tenant_id = ${TENANT_B}
        `,
        "awcms_commerce_store_settings_inventory_location_fk"
      );
      // 'ledger' without a location is refused by the CHECK.
      await assertRejected(
        getAdminSql()`
          UPDATE awcms_commerce_store_settings SET inventory_mode = 'ledger'
          WHERE tenant_id = ${TENANT_B}
        `,
        "awcms_commerce_store_settings_inventory_location_required"
      );
    }, 60000);

    test("tenant B cannot cut over with tenant A's location", async () => {
      await seedProduct(TENANT_A, 5);
      await expect(cutover(TENANT_B, LOC_SALES, true)).rejects.toThrow();
      expect(
        await inTenant(TENANT_B, (tx) => readInventoryConfig(tx, TENANT_B))
      ).toMatchObject({ mode: "counter" });
    }, 60000);

    test("the worker role holds exactly the inventory grants the posting core needs", async () => {
      if (!workerRoleActivated) return;
      const rows = (await getAdminSql()`
        SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'awcms_worker' AND table_name LIKE 'awcms_inventory_%'
        ORDER BY table_name, privilege_type
      `) as { table_name: string; privilege_type: string }[];
      const grants = new Map<string, string[]>();
      for (const row of rows) {
        grants.set(row.table_name, [
          ...(grants.get(row.table_name) ?? []),
          row.privilege_type
        ]);
      }
      expect(Object.fromEntries(grants)).toEqual({
        awcms_inventory_balances: ["INSERT", "SELECT", "UPDATE"],
        awcms_inventory_locations: ["SELECT"],
        awcms_inventory_low_stock_signals: ["INSERT", "SELECT"],
        awcms_inventory_movements: ["INSERT", "SELECT"],
        awcms_inventory_settings: ["SELECT"]
      });
      // ...and still cannot rewrite history.
      await assertRejected(
        withTenantOrThrow(
          getWorkerRoleSql(),
          TENANT_A,
          (tx) => tx`UPDATE awcms_inventory_movements SET quantity_delta = 1`
        ),
        "permission denied"
      );
    }, 60000);

    test("the mode lock: resolveInventoryConfig and a concurrent cut-over serialise", async () => {
      const productId = await seedProduct(TENANT_A, 10);
      // An in-flight counter-mode order holds the shared lock while the cut-over
      // waits for it; the cut-over's snapshot must include the order's decrement.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const order = inTenant(TENANT_A, async (tx) => {
        const config = await resolveInventoryConfig(tx, TENANT_A);
        expect(config.mode).toBe("counter");
        await tx`UPDATE awcms_commerce_products SET stock = stock - 4 WHERE id = ${productId}`;
        await gate;
      });
      await Bun.sleep(300);
      const cut = cutover(TENANT_A, LOC_SALES, true);
      await Bun.sleep(300);
      release();
      await order;
      const result = await cut;
      expect(result).toMatchObject({ kind: "completed", totalQuantity: 6 });
      expect(
        await onHand(TENANT_A, LOC_SALES, "commerce.product", productId)
      ).toBe("6");
    }, 60000);

    test("InventoryLedgerRefusedError carries no balance in its message", () => {
      const error = new InventoryLedgerRefusedError(
        "insufficient_stock",
        { itemType: "commerce.product", itemRef: "x" },
        LOC_SALES,
        "1"
      );
      expect(error.message).not.toContain("1 unit");
      expect(error.kind).toBe("insufficient_stock");
    });
  });
});
