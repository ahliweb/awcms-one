/**
 * Item kits / product bundles (Issue #290, ADR-0036) against a REAL migrated
 * Postgres through `tests/integration/harness.ts`. Gated on `DATABASE_URL`.
 *
 * Proves what only a database can: tenant isolation and cross-tenant refusal on
 * the new tables, the nesting/variant/flash-sale triggers, a bundle sold as ONE
 * order line with an immutable component snapshot, component-aware stock in
 * both authority modes (counter decrement; ledger `sale` per component with the
 * `<orderItemId>:c<position>` source line), no oversell under concurrency,
 * variant components, cancel/expiry/return restocks, a definition edit after
 * the sale leaving the snapshot alone, a POS sale of a bundle, and engine-mode
 * tax on the bundle line.
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
import {
  commerceInventoryPort,
  readInventoryConfig
} from "../../src/modules/commerce/application/commerce-inventory";
import { runCommerceInventoryCutover } from "../../src/modules/commerce/application/commerce-inventory-cutover";
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
  updateProduct,
  attachProductRelations
} from "../../src/modules/commerce/application/product-directory";
import { BundleDefinitionInvalidError } from "../../src/modules/commerce/application/bundle-directory";
import { lookupBarcode } from "../../src/modules/commerce/application/barcode-directory";
import { createReturn } from "../../src/modules/commerce/application/return-directory";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { runTaxCutoverForTenant } from "../../src/modules/commerce/application/tax-cutover";
import { createFlashSale } from "../../src/modules/commerce/application/flash-sale-directory";
import type { CreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import type { CreatePosOrderInput } from "../../src/modules/commerce/domain/pos-order-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { listSnapshots } from "../../src/modules/tax/application/tax-snapshot-directory";
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

const refused = (statement: Promise<unknown>): Promise<Error> =>
  assertRejected(statement, "the statement");

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a290";
const TENANT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b290";
const STAFF = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c290";
const LOC_SALES = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d290";
const NOW = new Date("2026-10-05T10:00:00.000Z");

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
    VALUES (${tenantId}, 'person', 'Bundle Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`bundle-actor-${tenantId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${STAFF}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function configureStore(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Paket",
    shipping: { selfPickup: true },
    payment: {
      manualQris: { active: true, mediaObjectId: null },
      tax: { active: true, percent: 11 }
    }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, STAFF, validated.value)
  );
  await inTenant(tenantId, (tx) =>
    updateModuleSettings(
      tx,
      tenantId,
      "commerce",
      { features: { pos: true, returns: true } },
      STAFF
    )
  );
}

let seq = 0;

async function seedProduct(
  tenantId: string,
  price: string,
  stock: number,
  overrides: { kind?: "bundle"; pricing?: string; discount?: string } = {}
): Promise<string> {
  seq += 1;
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_products
      (tenant_id, sku, name, slug, price, stock, status, kind, bundle_pricing, bundle_discount_percent)
    VALUES (${tenantId}, ${`SKU-B${seq}`}, ${`Produk ${seq}`}, ${`produk-b${seq}`}, ${price}, ${stock},
            'active', ${overrides.kind ?? "standard"}, ${overrides.pricing ?? "fixed"}, ${overrides.discount ?? null})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function seedVariant(
  tenantId: string,
  productId: string,
  stock: number,
  value: string,
  price: string | null = null
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_product_variants
      (tenant_id, product_id, name, value, stock, price)
    VALUES (${tenantId}, ${productId}, 'Ukuran', ${value}, ${stock}, ${price})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

type ComponentSeed = {
  productId: string;
  variantId?: string | null;
  quantity: number;
};

async function seedComponents(
  tenantId: string,
  bundleId: string,
  components: ComponentSeed[]
): Promise<void> {
  for (const [index, component] of components.entries()) {
    await getAdminSql()`
      INSERT INTO awcms_commerce_bundle_components
        (tenant_id, bundle_product_id, position, component_product_id, component_variant_id, quantity)
      VALUES (${tenantId}, ${bundleId}, ${index + 1}, ${component.productId},
              ${component.variantId ?? null}, ${component.quantity})
    `;
  }
}

/** A bundle of `components`, fixed-priced at `price`, ready to sell. */
async function seedBundle(
  tenantId: string,
  price: string,
  components: ComponentSeed[],
  overrides: { pricing?: string; discount?: string } = {}
): Promise<string> {
  const id = await seedProduct(tenantId, price, 0, {
    kind: "bundle",
    ...overrides
  });
  await seedComponents(tenantId, id, components);
  return id;
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
  itemType: "commerce.product" | "commerce.variant",
  itemRef: string
): Promise<string> {
  return inTenant(TENANT_A, (tx) =>
    commerceInventoryPort().getOnHand(tx, TENANT_A, LOC_SALES, {
      itemType,
      itemRef,
      unitCode: "unit"
    })
  );
}

async function sales(type: "sale" | "sale_return") {
  return (await getAdminSql()`
    SELECT item_ref, trim_scale(quantity_delta)::text AS quantity_delta,
           source_type, source_id, source_line
    FROM awcms_inventory_movements
    WHERE tenant_id = ${TENANT_A} AND movement_type = ${type}
    ORDER BY item_ref, source_line
  `) as {
    item_ref: string;
    quantity_delta: string;
    source_type: string;
    source_id: string;
    source_line: string;
  }[];
}

async function goLedger(): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_inventory_locations (id, tenant_id, code, name, status)
    VALUES (${LOC_SALES}, ${TENANT_A}, 'sales', 'sales', 'active')
    ON CONFLICT (id) DO NOTHING
  `;
  await inTenant(TENANT_A, (tx) =>
    runCommerceInventoryCutover(
      tx,
      TENANT_A,
      LOC_SALES,
      postOpeningThroughInventory,
      "bundle-test"
    )
  );
}

let keySeq = 0;
const key = (): string =>
  `00000000-0000-4000-8000-${String(++keySeq).padStart(12, "0")}`;

function orderInput(
  lines: { productId: string; quantity: number }[],
  overrides: Partial<CreateOrderInput> = {}
): CreateOrderInput {
  return {
    idempotencyKey: key(),
    customer: { name: "Siti", phone: "0812-3456-7890", email: null },
    address: null,
    lines: lines.map((line) => ({
      productId: line.productId,
      variantId: null,
      quantity: line.quantity,
      serviceFormValues: null
    })),
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

function place(
  lines: { productId: string; quantity: number }[],
  overrides: Partial<CreateOrderInput> = {}
) {
  return inTenant(TENANT_A, (tx) =>
    createOrderFromCart(
      tx,
      TENANT_A,
      mediaLibraryPortAdapter,
      orderInput(lines, overrides),
      NOW,
      "corr-bundle"
    )
  );
}

async function placed(
  lines: { productId: string; quantity: number }[]
): Promise<{ orderId: string; orderCode: string; total: string }> {
  const outcome = await place(lines);
  if (outcome.kind !== "created") {
    throw new Error(`order not created: ${outcome.kind}`);
  }
  const rows = (await getAdminSql()`
    SELECT id FROM awcms_commerce_orders WHERE order_code = ${outcome.order.orderCode}
  `) as { id: string }[];
  return {
    orderId: rows[0]!.id,
    orderCode: outcome.order.orderCode,
    total: outcome.order.total
  };
}

async function itemsOf(orderId: string) {
  return (await getAdminSql()`
    SELECT id, product_id, quantity, unit_price::text AS unit_price, line_total::text AS line_total
    FROM awcms_commerce_order_items WHERE order_id = ${orderId}
    ORDER BY created_at, id
  `) as {
    id: string;
    product_id: string;
    quantity: number;
    unit_price: string;
    line_total: string;
  }[];
}

async function snapshotOf(orderItemId: string) {
  return (await getAdminSql()`
    SELECT position, component_product_id, component_variant_id, sku, name, variant_name,
           quantity_per_bundle, quantity_total, allocated_value::text AS allocated_value
    FROM awcms_commerce_order_item_components
    WHERE order_item_id = ${orderItemId}
    ORDER BY position
  `) as {
    position: number;
    component_product_id: string;
    component_variant_id: string | null;
    sku: string | null;
    name: string;
    variant_name: string | null;
    quantity_per_bundle: number;
    quantity_total: number;
    allocated_value: string;
  }[];
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-NEW",
  name: "Paket Baru",
  slug: "paket-baru",
  description: null,
  digitalNote: null,
  price: "50000.00",
  discountPercent: 0,
  stock: 0,
  label: null,
  labelColor: null,
  priceLevel2: null,
  priceLevel3: null,
  priceLevel4: null,
  costPrice: null,
  minPurchase: 1,
  weightGrams: 0,
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

suite("commerce bundles integration (Issue #290)", () => {
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
    await configureStore(TENANT_A);
  }, 60000);

  // -------------------------------------------------------------------------
  describe("schema: tenant isolation and the nesting rule", () => {
    test("RLS: another tenant sees none of a bundle's components, and cannot reference its products", async () => {
      const part = await seedProduct(TENANT_A, "1000.00", 5);
      const bundle = await seedBundle(TENANT_A, "1500.00", [
        { productId: part, quantity: 1 }
      ]);
      expect(
        (await inTenant(
          TENANT_A,
          (tx) => tx`
          SELECT id FROM awcms_commerce_bundle_components WHERE bundle_product_id = ${bundle}
        `
        )) as unknown[]
      ).toHaveLength(1);
      expect(
        (await inTenant(
          TENANT_B,
          (tx) => tx`
          SELECT id FROM awcms_commerce_bundle_components
        `
        )) as unknown[]
      ).toHaveLength(0);

      // Tenant B naming tenant A's products: the composite FK refuses, even for the admin role.
      const bundleB = await seedProduct(TENANT_B, "1500.00", 0, {
        kind: "bundle"
      });
      await refused(
        getAdminSql()`
          INSERT INTO awcms_commerce_bundle_components
            (tenant_id, bundle_product_id, position, component_product_id, quantity)
          VALUES (${TENANT_B}, ${bundleB}, 1, ${part}, 1)
        `
      );
      // ... and the app role cannot write another tenant's row at all (RLS WITH CHECK).
      await refused(
        inTenant(
          TENANT_B,
          (tx) => tx`
            INSERT INTO awcms_commerce_bundle_components
              (tenant_id, bundle_product_id, position, component_product_id, quantity)
            VALUES (${TENANT_A}, ${bundle}, 2, ${part}, 1)
          `
        )
      );
    }, 60000);

    test("nesting is refused: a bundle cannot be a component, and a component cannot become a bundle", async () => {
      const part = await seedProduct(TENANT_A, "1000.00", 5);
      const inner = await seedBundle(TENANT_A, "900.00", [
        { productId: part, quantity: 1 }
      ]);
      const outer = await seedProduct(TENANT_A, "2000.00", 0, {
        kind: "bundle"
      });
      await refused(
        getAdminSql()`
          INSERT INTO awcms_commerce_bundle_components
            (tenant_id, bundle_product_id, position, component_product_id, quantity)
          VALUES (${TENANT_A}, ${outer}, 1, ${inner}, 1)
        `
      );
      // `part` is used as a component, so it cannot become a bundle.
      await refused(
        getAdminSql()`
          UPDATE awcms_commerce_products SET kind = 'bundle' WHERE id = ${part}
        `
      );
      // A bundle cannot name itself.
      await refused(
        getAdminSql()`
          INSERT INTO awcms_commerce_bundle_components
            (tenant_id, bundle_product_id, position, component_product_id, quantity)
          VALUES (${TENANT_A}, ${outer}, 1, ${outer}, 1)
        `
      );
      // A bundle that still has components cannot be turned back into a product.
      await refused(
        getAdminSql()`
          UPDATE awcms_commerce_products SET kind = 'standard' WHERE id = ${inner}
        `
      );
    }, 60000);

    test("a bundle has no variants, no stock, no service form, is not flash-sale eligible; at most 20 lines", async () => {
      const part = await seedProduct(TENANT_A, "1000.00", 5);
      const bundle = await seedBundle(TENANT_A, "1500.00", [
        { productId: part, quantity: 1 }
      ]);
      await refused(
        getAdminSql()`
          INSERT INTO awcms_commerce_product_variants (tenant_id, product_id, name, value)
          VALUES (${TENANT_A}, ${bundle}, 'Ukuran', 'S')
        `
      );
      await refused(
        getAdminSql()`UPDATE awcms_commerce_products SET stock = 3 WHERE id = ${bundle}`
      );
      await refused(
        getAdminSql()`
          UPDATE awcms_commerce_products SET service_form = '[]'::jsonb WHERE id = ${bundle}
        `
      );
      await refused(
        inTenant(TENANT_A, (tx) =>
          createFlashSale(tx, TENANT_A, STAFF, {
            name: "Flash",
            slug: "flash-paket",
            startsAt: new Date(NOW.getTime() - 1000),
            endsAt: new Date(NOW.getTime() + 3_600_000),
            status: "active"
          } as never).then(async (sale) => {
            await getAdminSql()`
                INSERT INTO awcms_commerce_flash_sale_products
                  (tenant_id, flash_sale_id, product_id, sale_price)
                VALUES (${TENANT_A}, ${(sale as { id: string }).id}, ${bundle}, 1.00)
              `;
          })
        )
      );

      const many = await seedProduct(TENANT_A, "1000.00", 0, {
        kind: "bundle"
      });
      for (let index = 1; index <= 20; index += 1) {
        const comp = await seedProduct(TENANT_A, "10.00", 5);
        await getAdminSql()`
          INSERT INTO awcms_commerce_bundle_components
            (tenant_id, bundle_product_id, position, component_product_id, quantity)
          VALUES (${TENANT_A}, ${many}, ${index}, ${comp}, 1)
        `;
      }
      const extra = await seedProduct(TENANT_A, "10.00", 5);
      await refused(
        getAdminSql()`
          INSERT INTO awcms_commerce_bundle_components
            (tenant_id, bundle_product_id, position, component_product_id, quantity)
          VALUES (${TENANT_A}, ${many}, 20, ${extra}, 1)
        `
      );
    }, 90000);

    test("a component product with live variants must name a variant, and the variant must be its own", async () => {
      const shirt = await seedProduct(TENANT_A, "50000.00", 0);
      const small = await seedVariant(TENANT_A, shirt, 4, "S");
      const other = await seedProduct(TENANT_A, "1000.00", 5);
      const bundle = await seedProduct(TENANT_A, "60000.00", 0, {
        kind: "bundle"
      });
      await refused(
        getAdminSql()`
          INSERT INTO awcms_commerce_bundle_components
            (tenant_id, bundle_product_id, position, component_product_id, quantity)
          VALUES (${TENANT_A}, ${bundle}, 1, ${shirt}, 1)
        `
      );
      await refused(
        getAdminSql()`
          INSERT INTO awcms_commerce_bundle_components
            (tenant_id, bundle_product_id, position, component_product_id, component_variant_id, quantity)
          VALUES (${TENANT_A}, ${bundle}, 1, ${other}, ${small}, 1)
        `
      );
      await getAdminSql()`
        INSERT INTO awcms_commerce_bundle_components
          (tenant_id, bundle_product_id, position, component_product_id, component_variant_id, quantity)
        VALUES (${TENANT_A}, ${bundle}, 1, ${shirt}, ${small}, 1)
      `;
    }, 60000);
  });

  // -------------------------------------------------------------------------
  describe("admin definition (createProduct / updateProduct)", () => {
    test("creates a bundle with components, derived pricing, and reports computed availability as stock", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 9);
      const b = await seedProduct(TENANT_A, "5000.00", 5);
      const bundle = await inTenant(TENANT_A, (tx) =>
        createProduct(tx, TENANT_A, STAFF, {
          ...BASE_PRODUCT,
          kind: "bundle",
          bundlePricing: "derived",
          bundleDiscountPercent: "10.00",
          bundleComponents: [
            { productId: a, variantId: null, quantity: 3 },
            { productId: b, variantId: null, quantity: 2 }
          ]
        })
      );
      expect(bundle.kind).toBe("bundle");
      expect(bundle.bundlePricing).toBe("derived");
      expect(bundle.bundleDiscountPercent).toBe("10.00");

      const [withRelations] = await inTenant(TENANT_A, (tx) =>
        attachProductRelations(tx, TENANT_A, mediaLibraryPortAdapter, [bundle])
      );
      // min(floor(9 / 3), floor(5 / 2)) = 2
      expect(withRelations!.stock).toBe(2);
      expect(withRelations!.bundle!.components.map((c) => c.quantity)).toEqual([
        3, 2
      ]);
      // The column itself is never anything but 0.
      expect(await stockOf(bundle.id)).toBe(0);
    }, 60000);

    test("components named by SKU resolve to the product or the variant; an unknown SKU is a field error", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 9);
      const shirt = await seedProduct(TENANT_A, "50000.00", 0);
      const small = await seedVariant(TENANT_A, shirt, 4, "S");
      await getAdminSql()`UPDATE awcms_commerce_product_variants SET sku = 'SHIRT-S' WHERE id = ${small}`;
      const skuOf =
        (await getAdminSql()`SELECT sku FROM awcms_commerce_products WHERE id = ${a}`) as {
          sku: string;
        }[];

      const bundle = await inTenant(TENANT_A, (tx) =>
        createProduct(tx, TENANT_A, STAFF, {
          ...BASE_PRODUCT,
          kind: "bundle",
          bundleComponents: [
            { sku: skuOf[0]!.sku, quantity: 2 },
            { sku: "SHIRT-S", quantity: 1 }
          ]
        })
      );
      const rows = (await getAdminSql()`
        SELECT position, component_product_id, component_variant_id, quantity
        FROM awcms_commerce_bundle_components WHERE bundle_product_id = ${bundle.id} ORDER BY position
      `) as {
        position: number;
        component_product_id: string;
        component_variant_id: string | null;
        quantity: number;
      }[];
      expect(rows).toEqual([
        {
          position: 1,
          component_product_id: a,
          component_variant_id: null,
          quantity: 2
        },
        {
          position: 2,
          component_product_id: shirt,
          component_variant_id: small,
          quantity: 1
        }
      ]);

      await expect(
        inTenant(TENANT_A, (tx) =>
          createProduct(tx, TENANT_A, STAFF, {
            ...BASE_PRODUCT,
            sku: "SKU-N9",
            slug: "paket-n9",
            kind: "bundle",
            bundleComponents: [{ sku: "NOPE", quantity: 1 }]
          })
        )
      ).rejects.toBeInstanceOf(BundleDefinitionInvalidError);
    }, 60000);

    test("refuses stock on a bundle, nesting, an unknown component and a missing variant with field errors", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 9);
      const shirt = await seedProduct(TENANT_A, "50000.00", 0);
      await seedVariant(TENANT_A, shirt, 3, "S");
      const inner = await seedBundle(TENANT_A, "1.00", [
        { productId: a, quantity: 1 }
      ]);
      const create = (patch: Partial<CreateProductInput>, n: number) =>
        inTenant(TENANT_A, (tx) =>
          createProduct(tx, TENANT_A, STAFF, {
            ...BASE_PRODUCT,
            sku: `SKU-N${n}`,
            slug: `paket-n${n}`,
            kind: "bundle",
            ...patch
          })
        );
      const fields = async (promise: Promise<unknown>) => {
        try {
          await promise;
        } catch (error) {
          if (error instanceof BundleDefinitionInvalidError) {
            return error.errors.map((e) => e.field);
          }
          throw error;
        }
        return [];
      };

      expect(
        await fields(
          create(
            {
              stock: 5,
              bundleComponents: [{ productId: a, variantId: null, quantity: 1 }]
            },
            1
          )
        )
      ).toEqual(["stock"]);
      expect(
        await fields(
          create(
            {
              bundleComponents: [
                { productId: inner, variantId: null, quantity: 1 }
              ]
            },
            2
          )
        )
      ).toEqual(["bundleComponents[0].productId"]);
      expect(
        await fields(
          create(
            {
              bundleComponents: [
                { productId: shirt, variantId: null, quantity: 1 }
              ]
            },
            3
          )
        )
      ).toEqual(["bundleComponents[0].variantId"]);
      expect(
        await fields(
          create(
            {
              bundleComponents: [
                {
                  productId: "00000000-0000-4000-8000-0000000000aa",
                  variantId: null,
                  quantity: 1
                }
              ]
            },
            4
          )
        )
      ).toEqual(["bundleComponents[0].productId"]);
      expect(await fields(create({ bundleComponents: [] }, 5))).toEqual([
        "bundleComponents"
      ]);
      // Nothing half-written: none of the refused creates left a product behind.
      const leftovers = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_products WHERE sku LIKE 'SKU-N%'
      `) as { n: number }[];
      expect(leftovers[0]!.n).toBe(0);
    }, 60000);

    test("update replaces components, converts a standard product, and refuses stock on a bundle", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 9);
      const b = await seedProduct(TENANT_A, "5000.00", 9);
      const plain = await inTenant(TENANT_A, (tx) =>
        createProduct(tx, TENANT_A, STAFF, BASE_PRODUCT)
      );
      const converted = await inTenant(TENANT_A, (tx) =>
        updateProduct(tx, TENANT_A, STAFF, plain.id, {
          kind: "bundle",
          bundleComponents: [{ productId: a, variantId: null, quantity: 1 }]
        })
      );
      expect(converted?.kind).toBe("bundle");

      const replaced = await inTenant(TENANT_A, (tx) =>
        updateProduct(tx, TENANT_A, STAFF, plain.id, {
          bundleComponents: [{ productId: b, variantId: null, quantity: 4 }]
        })
      );
      expect(replaced?.kind).toBe("bundle");
      const rows = (await getAdminSql()`
        SELECT component_product_id, quantity FROM awcms_commerce_bundle_components
        WHERE bundle_product_id = ${plain.id} AND deleted_at IS NULL
      `) as { component_product_id: string; quantity: number }[];
      expect(rows).toEqual([{ component_product_id: b, quantity: 4 }]);

      await expect(
        inTenant(TENANT_A, (tx) =>
          updateProduct(tx, TENANT_A, STAFF, plain.id, { stock: 3 })
        )
      ).rejects.toBeInstanceOf(BundleDefinitionInvalidError);

      // Back to a standard product: components go with it.
      const back = await inTenant(TENANT_A, (tx) =>
        updateProduct(tx, TENANT_A, STAFF, plain.id, { kind: "standard" })
      );
      expect(back?.kind).toBe("standard");
      const left = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_bundle_components
        WHERE bundle_product_id = ${plain.id} AND deleted_at IS NULL
      `) as { n: number }[];
      expect(left[0]!.n).toBe(0);
    }, 60000);
  });

  // -------------------------------------------------------------------------
  describe("counter mode", () => {
    test("a bundle order is ONE line, snapshots its components, and decrements each component counter", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 10);
      const b = await seedProduct(TENANT_A, "5000.00", 10);
      const bundle = await seedBundle(TENANT_A, "20000.00", [
        { productId: a, quantity: 2 },
        { productId: b, quantity: 1 }
      ]);

      const order = await placed([{ productId: bundle, quantity: 3 }]);
      const items = await itemsOf(order.orderId);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        product_id: bundle,
        quantity: 3,
        unit_price: "20000.00",
        line_total: "60000.00"
      });
      // The bundle moved no stock of its own; its components did.
      expect(await stockOf(bundle)).toBe(0);
      expect(await stockOf(a)).toBe(4);
      expect(await stockOf(b)).toBe(7);

      const snapshot = await snapshotOf(items[0]!.id);
      expect(snapshot.map((row) => [row.position, row.quantity_total])).toEqual(
        [
          [1, 6],
          [2, 3]
        ]
      );
      // list value 2 x 10000 : 1 x 5000 = 4 : 1 of 60000
      expect(snapshot.map((row) => row.allocated_value)).toEqual([
        "48000.00",
        "12000.00"
      ]);
      expect(
        snapshot
          .reduce((sum, row) => sum + Number(row.allocated_value) * 100, 0)
          .toString()
      ).toBe("6000000");
    }, 60000);

    test("derived pricing: the order line carries the derived price", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 10);
      const b = await seedProduct(TENANT_A, "2500.50", 10);
      const bundle = await seedBundle(
        TENANT_A,
        "999999.00", // ignored: derived
        [
          { productId: a, quantity: 2 },
          { productId: b, quantity: 1 }
        ],
        { pricing: "derived", discount: "10.00" }
      );
      const order = await placed([{ productId: bundle, quantity: 1 }]);
      const items = await itemsOf(order.orderId);
      expect(items[0]!.unit_price).toBe("20250.45");
    }, 60000);

    test("not enough of a component is cart_changed with nothing left behind", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 3);
      const bundle = await seedBundle(TENANT_A, "25000.00", [
        { productId: a, quantity: 2 }
      ]);
      const outcome = await place([{ productId: bundle, quantity: 2 }]);
      expect(outcome.kind).toBe("cart_changed");
      if (outcome.kind === "cart_changed") {
        expect(outcome.quote.lines[0]!.availableStock).toBe(1);
      }
      expect(await stockOf(a)).toBe(3);
      const orders =
        (await getAdminSql()`SELECT count(*)::int AS n FROM awcms_commerce_orders`) as {
          n: number;
        }[];
      expect(orders[0]!.n).toBe(0);
    }, 60000);

    test("six parallel orders for the last unit of a shared component sell exactly one", async () => {
      const shared = await seedProduct(TENANT_A, "10000.00", 1);
      const extra = await seedProduct(TENANT_A, "1000.00", 50);
      const x = await seedBundle(TENANT_A, "11000.00", [
        { productId: shared, quantity: 1 },
        { productId: extra, quantity: 1 }
      ]);
      const y = await seedBundle(TENANT_A, "10500.00", [
        { productId: extra, quantity: 2 },
        { productId: shared, quantity: 1 }
      ]);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          place([{ productId: index % 2 === 0 ? x : y, quantity: 1 }], {
            customer: shopper(index)
          })
        )
      );
      expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "cart_changed")).toHaveLength(5);
      expect(await stockOf(shared)).toBe(0);
    }, 90000);

    test("a variant component decrements the variant's counter", async () => {
      const shirt = await seedProduct(TENANT_A, "50000.00", 0);
      const small = await seedVariant(TENANT_A, shirt, 5, "S", "40000.00");
      const bundle = await seedBundle(TENANT_A, "60000.00", [
        { productId: shirt, variantId: small, quantity: 2 }
      ]);
      const order = await placed([{ productId: bundle, quantity: 2 }]);
      expect(await variantStockOf(small)).toBe(1);
      const items = await itemsOf(order.orderId);
      const snapshot = await snapshotOf(items[0]!.id);
      expect(snapshot[0]).toMatchObject({
        component_variant_id: small,
        variant_name: "S",
        quantity_total: 4
      });
    }, 60000);

    test("cancel restocks the components; the snapshot rows stay", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 10);
      const bundle = await seedBundle(TENANT_A, "20000.00", [
        { productId: a, quantity: 2 }
      ]);
      const order = await placed([{ productId: bundle, quantity: 3 }]);
      expect(await stockOf(a)).toBe(4);
      await inTenant(TENANT_A, (tx) =>
        cancelOrderByCustomer(
          tx,
          TENANT_A,
          mediaLibraryPortAdapter,
          order.orderCode,
          "+6281234567890",
          null
        )
      );
      expect(await stockOf(a)).toBe(10);
      expect(await stockOf(bundle)).toBe(0);
      const items = await itemsOf(order.orderId);
      expect(await snapshotOf(items[0]!.id)).toHaveLength(1);
    }, 60000);

    test("the expiry job (as the worker role) restocks the components", async () => {
      if (!workerRoleActivated) return;
      const a = await seedProduct(TENANT_A, "10000.00", 10);
      const bundle = await seedBundle(TENANT_A, "20000.00", [
        { productId: a, quantity: 2 }
      ]);
      await placed([{ productId: bundle, quantity: 3 }]);
      expect(await stockOf(a)).toBe(4);
      const result = await expireOrdersForTenant(
        getWorkerRoleSql(),
        TENANT_A,
        new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 30)
      );
      expect(result.expiredCount).toBe(1);
      expect(await stockOf(a)).toBe(10);
    }, 60000);

    test("a definition edit after the sale leaves the snapshot, and the restock, unchanged", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 10);
      const b = await seedProduct(TENANT_A, "5000.00", 10);
      const bundle = await seedBundle(TENANT_A, "20000.00", [
        { productId: a, quantity: 2 }
      ]);
      const order = await placed([{ productId: bundle, quantity: 1 }]);
      const items = await itemsOf(order.orderId);
      const before = await snapshotOf(items[0]!.id);

      await inTenant(TENANT_A, (tx) =>
        updateProduct(tx, TENANT_A, STAFF, bundle, {
          bundleComponents: [{ productId: b, variantId: null, quantity: 5 }]
        })
      );
      expect(await snapshotOf(items[0]!.id)).toEqual(before);

      // The snapshot rows are append-only for the application role.
      await refused(
        inTenant(
          TENANT_A,
          (tx) => tx`
            UPDATE awcms_commerce_order_item_components SET quantity_per_bundle = 9
            WHERE order_item_id = ${items[0]!.id}
          `
        )
      );
      await refused(
        inTenant(
          TENANT_A,
          (tx) => tx`
            DELETE FROM awcms_commerce_order_item_components WHERE order_item_id = ${items[0]!.id}
          `
        )
      );

      // Cancel: the ORIGINAL component (a x 2) is put back, not the edited one.
      expect(await stockOf(a)).toBe(8);
      await inTenant(TENANT_A, (tx) =>
        cancelOrderByCustomer(
          tx,
          TENANT_A,
          mediaLibraryPortAdapter,
          order.orderCode,
          "+6281234567890",
          null
        )
      );
      expect(await stockOf(a)).toBe(10);
      expect(await stockOf(b)).toBe(10);
    }, 60000);

    test("a whole-bundle return restocks every component", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 10);
      const b = await seedProduct(TENANT_A, "5000.00", 10);
      const bundle = await seedBundle(TENANT_A, "20000.00", [
        { productId: a, quantity: 2 },
        { productId: b, quantity: 1 }
      ]);
      const order = await placed([{ productId: bundle, quantity: 3 }]);
      await getAdminSql()`
        UPDATE awcms_commerce_orders SET status = 'paid', payment_status = 'paid', paid_at = now()
        WHERE id = ${order.orderId}
      `;
      const items = await itemsOf(order.orderId);
      const result = await inTenant(TENANT_A, (tx) =>
        createReturn(
          tx,
          TENANT_A,
          STAFF,
          order.orderId,
          {
            idempotencyKey: crypto.randomUUID(),
            kind: "return",
            lines: [
              {
                orderItemId: items[0]!.id,
                quantity: 2,
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
      expect(result.kind).toBe("created");
      // sold 3 bundles: a 10-6=4, b 10-3=7; returned 2 bundles: +4 / +2
      expect(await stockOf(a)).toBe(8);
      expect(await stockOf(b)).toBe(9);
      expect(await stockOf(bundle)).toBe(0);
    }, 60000);

    test("a bundle is found by its own barcode with computed availability and the derived price", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 9);
      const bundle = await seedBundle(
        TENANT_A,
        "999.00",
        [{ productId: a, quantity: 3 }],
        { pricing: "derived", discount: "10.00" }
      );
      await getAdminSql()`UPDATE awcms_commerce_products SET barcode = '8991234567890' WHERE id = ${bundle}`;
      const hit = await inTenant(TENANT_A, (tx) =>
        lookupBarcode(tx, TENANT_A, "8991234567890")
      );
      expect(hit).toMatchObject({
        productId: bundle,
        stock: 3,
        price: "27000.00",
        sellable: true
      });
      // The component runs out: the bundle is no longer sellable at the till.
      await getAdminSql()`UPDATE awcms_commerce_products SET stock = 2 WHERE id = ${a}`;
      const out = await inTenant(TENANT_A, (tx) =>
        lookupBarcode(tx, TENANT_A, "8991234567890")
      );
      expect(out).toMatchObject({ stock: 0, sellable: false });
    }, 60000);

    test("a POS sale of a bundle sells the components and out-of-stock is PosCartChangedError", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 5);
      const bundle = await seedBundle(TENANT_A, "25000.00", [
        { productId: a, quantity: 2 }
      ]);
      const input: CreatePosOrderInput = {
        idempotencyKey: crypto.randomUUID(),
        customer: { name: null, phone: null },
        lines: [{ productId: bundle, variantId: null, quantity: 2 }],
        payment: { method: "cash", amountTendered: "100000.00" },
        tenders: null,
        allowDue: false,
        notes: null
      } as CreatePosOrderInput;
      const sold = await inTenant(TENANT_A, (tx) =>
        createPosOrder(tx, TENANT_A, STAFF, mediaLibraryPortAdapter, input, NOW)
      );
      expect(sold.kind).toBe("created");
      expect(await stockOf(a)).toBe(1);

      await expect(
        inTenant(TENANT_A, (tx) =>
          createPosOrder(
            tx,
            TENANT_A,
            STAFF,
            mediaLibraryPortAdapter,
            { ...input, idempotencyKey: crypto.randomUUID() },
            NOW
          )
        )
      ).rejects.toBeInstanceOf(PosCartChangedError);
      expect(await stockOf(a)).toBe(1);
    }, 60000);
  });

  // -------------------------------------------------------------------------
  describe("ledger mode", () => {
    test("a bundle order posts one sale per component with source <orderItemId>:c<position>, snapshot included", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 10);
      const shirt = await seedProduct(TENANT_A, "50000.00", 0);
      const small = await seedVariant(TENANT_A, shirt, 6, "S");
      const bundle = await seedBundle(TENANT_A, "70000.00", [
        { productId: a, quantity: 2 },
        { productId: shirt, variantId: small, quantity: 1 }
      ]);
      await goLedger();
      expect(
        await inTenant(TENANT_A, (tx) => readInventoryConfig(tx, TENANT_A))
      ).toMatchObject({ mode: "ledger" });

      const order = await placed([{ productId: bundle, quantity: 3 }]);
      const items = await itemsOf(order.orderId);
      expect(items).toHaveLength(1);

      const posted = await sales("sale");
      expect(posted).toHaveLength(2);
      expect(
        posted.map((m) => [
          m.source_type,
          m.source_id,
          m.source_line,
          m.quantity_delta
        ])
      ).toEqual(
        [
          ["commerce_order", order.orderId, `${items[0]!.id}:c1`, "-6"],
          ["commerce_order", order.orderId, `${items[0]!.id}:c2`, "-3"]
        ].sort((l, r) => {
          // sorted by item_ref, as `sales` orders them
          const refs = new Map([
            [`${items[0]!.id}:c1`, a],
            [`${items[0]!.id}:c2`, small]
          ]);
          return refs.get(l[2]!)! < refs.get(r[2]!)! ? -1 : 1;
        })
      );
      // No movement for the bundle itself.
      expect(posted.some((m) => m.item_ref === bundle)).toBe(false);

      expect(await onHand("commerce.product", a)).toBe("4");
      expect(await onHand("commerce.variant", small)).toBe("3");
      // The write-through cache followed.
      expect(await stockOf(a)).toBe(4);
      expect(await variantStockOf(small)).toBe(3);

      expect(await snapshotOf(items[0]!.id)).toHaveLength(2);
    }, 90000);

    test("six parallel orders for the last unit of a shared component never oversell", async () => {
      const shared = await seedProduct(TENANT_A, "10000.00", 1);
      const extra = await seedProduct(TENANT_A, "1000.00", 50);
      const x = await seedBundle(TENANT_A, "11000.00", [
        { productId: shared, quantity: 1 },
        { productId: extra, quantity: 1 }
      ]);
      const y = await seedBundle(TENANT_A, "10500.00", [
        { productId: extra, quantity: 2 },
        { productId: shared, quantity: 1 }
      ]);
      await goLedger();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          place([{ productId: index % 2 === 0 ? x : y, quantity: 1 }], {
            customer: shopper(index)
          })
        )
      );
      expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "cart_changed")).toHaveLength(5);
      expect(await onHand("commerce.product", shared)).toBe("0");
      // The refused orders left no component movement behind.
      const postedExtra = (await sales("sale")).filter(
        (m) => m.item_ref === extra
      );
      expect(postedExtra).toHaveLength(1);
    }, 90000);

    test("cancel and admin status change restock each component with source <orderItemId>:c<position>", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 10);
      const b = await seedProduct(TENANT_A, "5000.00", 10);
      const bundle = await seedBundle(TENANT_A, "20000.00", [
        { productId: a, quantity: 2 },
        { productId: b, quantity: 1 }
      ]);
      await goLedger();
      const order = await placed([{ productId: bundle, quantity: 2 }]);
      const items = await itemsOf(order.orderId);
      expect(await onHand("commerce.product", a)).toBe("6");

      await inTenant(TENANT_A, (tx) =>
        updateOrderStatusByAdmin(
          tx,
          TENANT_A,
          STAFF,
          order.orderId,
          "cancelled",
          null
        )
      );
      expect(await onHand("commerce.product", a)).toBe("10");
      expect(await onHand("commerce.product", b)).toBe("10");
      const restocks = await sales("sale_return");
      expect(
        restocks.map((m) => [m.source_type, m.source_line]).sort()
      ).toEqual([
        ["commerce_order_restock", `${items[0]!.id}:c1`],
        ["commerce_order_restock", `${items[0]!.id}:c2`]
      ]);
      expect(await stockOf(a)).toBe(10);
    }, 90000);

    test("the expiry job (worker role) restocks components through the ledger", async () => {
      if (!workerRoleActivated) return;
      const a = await seedProduct(TENANT_A, "10000.00", 10);
      const bundle = await seedBundle(TENANT_A, "20000.00", [
        { productId: a, quantity: 2 }
      ]);
      await goLedger();
      await placed([{ productId: bundle, quantity: 3 }]);
      expect(await onHand("commerce.product", a)).toBe("4");
      const result = await expireOrdersForTenant(
        getWorkerRoleSql(),
        TENANT_A,
        new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 30)
      );
      expect(result.expiredCount).toBe(1);
      expect(await onHand("commerce.product", a)).toBe("10");
    }, 90000);

    test("a whole-bundle return posts commerce_return sale_returns per component", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 10);
      const b = await seedProduct(TENANT_A, "5000.00", 10);
      const bundle = await seedBundle(TENANT_A, "20000.00", [
        { productId: a, quantity: 2 },
        { productId: b, quantity: 1 }
      ]);
      await goLedger();
      const order = await placed([{ productId: bundle, quantity: 3 }]);
      await getAdminSql()`
        UPDATE awcms_commerce_orders SET status = 'paid', payment_status = 'paid', paid_at = now()
        WHERE id = ${order.orderId}
      `;
      const items = await itemsOf(order.orderId);
      const result = await inTenant(TENANT_A, (tx) =>
        createReturn(
          tx,
          TENANT_A,
          STAFF,
          order.orderId,
          {
            idempotencyKey: crypto.randomUUID(),
            kind: "return",
            lines: [
              {
                orderItemId: items[0]!.id,
                quantity: 2,
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
      expect(result.kind).toBe("created");
      expect(await onHand("commerce.product", a)).toBe("8");
      expect(await onHand("commerce.product", b)).toBe("9");
      const restocks = (await sales("sale_return")).filter(
        (m) => m.source_type === "commerce_return"
      );
      expect(restocks).toHaveLength(2);
      expect(restocks.every((m) => /:c[12]$/.test(m.source_line))).toBe(true);
    }, 90000);

    test("a POS sale of a bundle posts component sales under the same commerce_order identity", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 5);
      const bundle = await seedBundle(TENANT_A, "25000.00", [
        { productId: a, quantity: 2 }
      ]);
      await goLedger();
      const sold = await inTenant(TENANT_A, (tx) =>
        createPosOrder(
          tx,
          TENANT_A,
          STAFF,
          mediaLibraryPortAdapter,
          {
            idempotencyKey: crypto.randomUUID(),
            customer: { name: null, phone: null },
            lines: [{ productId: bundle, variantId: null, quantity: 2 }],
            payment: { method: "cash", amountTendered: "100000.00" },
            tenders: null,
            allowDue: false,
            notes: null
          } as CreatePosOrderInput,
          NOW
        )
      );
      expect(sold.kind).toBe("created");
      expect(await onHand("commerce.product", a)).toBe("1");
      const posted = await sales("sale");
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        source_type: "commerce_order",
        quantity_delta: "-4"
      });
      expect(posted[0]!.source_line).toMatch(/:c1$/);
    }, 90000);
  });

  // -------------------------------------------------------------------------
  describe("tax (engine mode)", () => {
    test("a bundle line is taxed as ONE line by the bundle product's tax category", async () => {
      const a = await seedProduct(TENANT_A, "10000.00", 10);
      const b = await seedProduct(TENANT_A, "5000.00", 10);
      const bundle = await seedBundle(TENANT_A, "30000.00", [
        { productId: a, quantity: 2 },
        { productId: b, quantity: 2 }
      ]);
      expect(
        (
          await inTenant(TENANT_A, (tx) =>
            runTaxCutoverForTenant(tx, TENANT_A, { commit: true })
          )
        ).status
      ).toBe("cut_over");

      // The cutover publishes version 1 effective from the database server's
      // own UTC date, so the sale is placed on the real clock: the fixed
      // `NOW` above predates any version once the calendar moves past it.
      const outcome = await inTenant(TENANT_A, (tx) =>
        createOrderFromCart(
          tx,
          TENANT_A,
          mediaLibraryPortAdapter,
          orderInput([{ productId: bundle, quantity: 1 }]),
          new Date(),
          "corr-bundle"
        )
      );
      expect(outcome.kind).toBe("created");
      if (outcome.kind !== "created") return;
      // 11 % of the bundle's 30000.00, once - not of its components.
      expect(outcome.order.tax).toBe("3300.00");
      const snapshots = await inTenant(
        TENANT_A,
        async (tx) =>
          (await listSnapshots(tx, TENANT_A, { kind: "sale" })).snapshots
      );
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        taxTotal: "3300.00",
        netTotal: "30000.00"
      });
    }, 90000);
  });
});
