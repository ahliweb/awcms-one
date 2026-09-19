/**
 * `commerce` courier-rate integration (Issue #107, contract #106's D4) —
 * exercised against a REAL migrated database through
 * `tests/integration/harness.ts`, the same pattern
 * `commerce-orders.integration.test.ts` already follows. Gated on
 * `DATABASE_URL`; skips cleanly without one.
 *
 * Covers the acceptance list Issue #107 itself names: destination cache
 * (miss inserts, hit skips the provider), rate cache hit/miss with the
 * `log` provider, a quote with a destination, and order-creation validation
 * against the cache.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { createProduct } from "../../src/modules/commerce/application/product-directory";
import { buildCartQuote } from "../../src/modules/commerce/application/cart-quote-service";
import { createOrderFromCart } from "../../src/modules/commerce/application/order-directory";
import {
  findCachedRate,
  getCourierRates,
  resolveDestination
} from "../../src/modules/commerce/application/shipping-rate-directory";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { createLogShippingRateProvider } from "../../src/modules/commerce/infrastructure/log-shipping-rate-provider";
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
const ACTOR = "33333333-3333-3333-3333-333333333333";
const NOW = new Date("2026-09-16T10:00:00.000Z");

// A level-3 ("district"/kecamatan) `idn_admin_regions` code — RajaOngkir's
// own hierarchy is province/city/district/subdistrict, so "district code"
// throughout this module means level 3, not level 4 (village/kelurahan).
// Seeded directly below so this test does not depend on the full dataset
// import having run.
const DISTRICT_CODE = "99.99.99";

async function seedTenant(id: string, code: string): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedRegionDataset(): Promise<void> {
  const admin = getAdminSql();
  const datasetRows = (await admin`
    INSERT INTO awcms_idn_region_datasets
      (dataset_code, source_type, source_repository, source_path, source_commit_sha, source_file_sha256, row_count, status, activated_at)
    VALUES ('test-dataset', 'third_party_github_repository', 'example/repo', 'dataset.csv', 'deadbeef', 'deadbeef', 4, 'active', now())
    ON CONFLICT (dataset_code) DO UPDATE SET status = 'active', activated_at = now()
    RETURNING id
  `) as { id: string }[];
  const datasetId = datasetRows[0]!.id;

  await admin`
    INSERT INTO awcms_idn_admin_regions
      (dataset_id, code, code_compact, parent_code, level, region_type, official_name, normalized_name, full_path_name, source_row_hash)
    VALUES
      (${datasetId}, '99', '99', NULL, 1, 'province', 'Kalimantan Uji', 'kalimantan uji', 'Kalimantan Uji', 'h1'),
      (${datasetId}, '99.99', '9999', '99', 2, 'regency', 'Kota Uji', 'kota uji', 'Kalimantan Uji, Kota Uji', 'h2'),
      (${datasetId}, '99.99.99', '999999', '99.99', 3, 'district', 'Sukajadi Uji', 'sukajadi uji', 'Kalimantan Uji, Kota Uji, Sukajadi Uji', 'h3'),
      (${datasetId}, ${DISTRICT_CODE}, '999999999', '99.99.99', 4, 'village', 'Sukajadi Uji', 'sukajadi uji', 'Kalimantan Uji, Kota Uji, Sukajadi Uji, Sukajadi Uji', 'h4')
    ON CONFLICT (dataset_id, code) DO NOTHING
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
  sku: "SKU-COURIER",
  name: "Kopi Robusta",
  slug: "kopi-robusta-jw13",
  description: null,
  digitalNote: null,
  price: "25000.00",
  discountPercent: 0,
  stock: 10,
  label: null,
  labelColor: null,
  priceLevel2: null,
  priceLevel3: null,
  priceLevel4: null,
  costPrice: null,
  minPurchase: 1,
  weightGrams: 500,
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

async function enableCourier(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Uji",
    shipping: {
      selfPickup: true,
      courier: {
        enabled: true,
        originDestinationId: "origin-1",
        couriers: ["jne", "jnt"]
      }
    },
    payment: { manualQris: { active: true, mediaObjectId: null } }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, ACTOR, validated.value)
  );
}

const ADDRESS = {
  recipientName: "Budi",
  phone: "0812-0000-1111",
  provinceCode: "99",
  provinceName: "Kalimantan Uji",
  cityCode: "99.99",
  cityName: "Kota Uji",
  districtCode: DISTRICT_CODE,
  districtName: "Sukajadi Uji",
  postalCode: "70000",
  street: "Jl. Uji No. 1",
  latitude: null,
  longitude: null,
  notes: null
};

function orderInput(
  productId: string,
  overrides: Partial<CreateOrderInput> = {}
): CreateOrderInput {
  return {
    idempotencyKey: "11111111-2222-4333-8444-555555555556",
    customer: { name: "Budi", phone: "0812-0000-1111", email: null },
    address: ADDRESS,
    lines: [
      { productId, variantId: null, quantity: 1, serviceFormValues: null }
    ],
    shipping: { method: "courier", serviceId: "jne:REG" },
    payment: { method: "manual_qris" },
    voucherCode: null,
    insurance: false,
    notes: null,
    affiliateCode: null,
    ...overrides
  };
}

const ORIGINAL_ENV = { ...process.env };

suite("commerce shipping rates integration (Issue #107)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-a");
    await seedRegionDataset();
    process.env.COMMERCE_SHIPPING_RATE_PROVIDER = "log";
  }, 30000);

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test("resolveDestination: cache miss resolves via the provider and inserts; a second call hits the cache without calling the provider again", async () => {
    const provider = createLogShippingRateProvider();
    let searchCalls = 0;
    const spiedProvider = {
      ...provider,
      searchDestination: async (query: string) => {
        searchCalls += 1;
        return provider.searchDestination(query);
      }
    };

    const sql = getRuntimeSql();
    const first = await resolveDestination(
      sql,
      TENANT_A,
      spiedProvider,
      "log",
      DISTRICT_CODE
    );
    expect(first).not.toBeNull();
    expect(searchCalls).toBe(1);

    const second = await resolveDestination(
      sql,
      TENANT_A,
      spiedProvider,
      "log",
      DISTRICT_CODE
    );
    expect(second).toBe(first);
    expect(searchCalls).toBe(1);

    const rows = (await inTenant(
      TENANT_A,
      (tx) =>
        tx`SELECT destination_id FROM awcms_commerce_courier_destinations WHERE tenant_id = ${TENANT_A} AND district_code = ${DISTRICT_CODE}`
    )) as { destination_id: string }[];
    expect(rows).toHaveLength(1);
  });

  test("getCourierRates: first call fetches + caches, second call is a pure cache hit", async () => {
    const provider = createLogShippingRateProvider();
    let rateCalls = 0;
    const spiedProvider = {
      ...provider,
      getRates: async (params: Parameters<typeof provider.getRates>[0]) => {
        rateCalls += 1;
        return provider.getRates(params);
      }
    };

    const sql = getRuntimeSql();
    const first = await getCourierRates(
      sql,
      TENANT_A,
      {
        districtCode: DISTRICT_CODE,
        weightGrams: 1250,
        originId: "origin-1",
        couriers: ["jne", "jnt"]
      },
      spiedProvider,
      "log"
    );
    expect(first.available).toBe(true);
    if (!first.available) return;
    expect(first.options).toHaveLength(2);
    expect(rateCalls).toBe(1);

    const second = await getCourierRates(
      sql,
      TENANT_A,
      {
        districtCode: DISTRICT_CODE,
        weightGrams: 1250,
        originId: "origin-1",
        couriers: ["jne", "jnt"]
      },
      spiedProvider,
      "log"
    );
    expect(second.available).toBe(true);
    expect(rateCalls).toBe(1);

    // Cache is keyed by BUCKETED weight (100 g, min 1000 g) — 1250 g and
    // 1251 g both round up to the SAME 1300 g bucket, so this is still a
    // cache hit and still costs no extra provider call.
    const bucketed = await getCourierRates(
      sql,
      TENANT_A,
      {
        districtCode: DISTRICT_CODE,
        weightGrams: 1251,
        originId: "origin-1",
        couriers: ["jne", "jnt"]
      },
      spiedProvider,
      "log"
    );
    expect(bucketed.available).toBe(true);
    expect(rateCalls).toBe(1);
  });

  test("cart quote with a destination and courier enabled returns live courier options", async () => {
    const productId = await seedActiveProduct(TENANT_A);
    await enableCourier(TENANT_A);

    const quote = await inTenant(TENANT_A, (tx) =>
      buildCartQuote(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        {
          lines: [
            { productId, variantId: null, quantity: 1, serviceFormValues: null }
          ],
          shipping: null,
          voucherCode: null,
          insurance: false,
          destination: { districtCode: DISTRICT_CODE }
        },
        NOW,
        getRuntimeSql()
      )
    );

    const courierOptions = quote.shippingOptions.filter(
      (option) => option.method === "courier"
    );
    expect(courierOptions.length).toBeGreaterThan(0);
    expect(courierOptions.every((option) => option.available)).toBe(true);
  });

  test("order creation accepts a courier selection matching a cached rate, and rejects one that does not", async () => {
    const productId = await seedActiveProduct(TENANT_A);
    await enableCourier(TENANT_A);

    // Warm the cache the same way a real storefront quote would.
    await inTenant(TENANT_A, (tx) =>
      buildCartQuote(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        {
          lines: [
            { productId, variantId: null, quantity: 1, serviceFormValues: null }
          ],
          shipping: null,
          voucherCode: null,
          insurance: false,
          destination: { districtCode: DISTRICT_CODE }
        },
        NOW,
        getRuntimeSql()
      )
    );

    const accepted = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId),
        NOW
      )
    );
    expect(accepted.kind).toBe("created");
    if (accepted.kind === "created") {
      expect(accepted.order.shippingMethod).toBe("courier");
      expect(Number(accepted.order.shippingCost)).toBeGreaterThan(0);
    }

    const rejected = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderInput(productId, {
          idempotencyKey: "22222222-3333-4444-8555-666666666667",
          shipping: { method: "courier", serviceId: "unknown:XX" }
        }),
        NOW
      )
    );
    // Contract alignment (#109): a stale/unknown courier selection at order
    // time answers the SAME 409 CART_CHANGED every other price/stock/
    // shipping mismatch does — never a bespoke 400.
    expect(rejected.kind).toBe("cart_changed");
  });

  test("findCachedRate is null once the cache row has expired", async () => {
    const sql = getRuntimeSql();
    await getCourierRates(
      sql,
      TENANT_A,
      {
        districtCode: DISTRICT_CODE,
        weightGrams: 1000,
        originId: "origin-1",
        couriers: ["jne"]
      },
      createLogShippingRateProvider(),
      "log"
    );

    await inTenant(
      TENANT_A,
      (tx) =>
        tx`UPDATE awcms_commerce_shipping_rates SET expires_at = now() - interval '1 minute' WHERE tenant_id = ${TENANT_A}`
    );

    const destinationRows = (await inTenant(
      TENANT_A,
      (tx) =>
        tx`SELECT destination_id FROM awcms_commerce_courier_destinations WHERE tenant_id = ${TENANT_A} AND district_code = ${DISTRICT_CODE}`
    )) as { destination_id: string }[];
    const destinationId = destinationRows[0]!.destination_id;

    const cached = await inTenant(TENANT_A, (tx) =>
      findCachedRate(
        tx,
        TENANT_A,
        "log",
        "origin-1",
        destinationId,
        1000,
        "jne",
        "REG"
      )
    );
    expect(cached).toBeNull();
  });
});
