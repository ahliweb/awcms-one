import { describe, expect, test } from "bun:test";

import {
  DEFAULT_COMMERCE_FEATURES,
  FeatureDisabledError,
  assertFeatureEnabled,
  isCommerceFeatureEnabled,
  resolveCommerceFeatures
} from "../src/modules/commerce/domain/commerce-features";
import {
  quoteCart,
  type CartQuoteContext,
  type CartQuoteProductSnapshot
} from "../src/modules/commerce/domain/cart-quote";
import type { StoreSettingsData } from "../src/modules/commerce/domain/store-settings-validation";
import { toPublicRecord } from "../src/modules/commerce/application/store-settings-directory";

// ---------------------------------------------------------------------------
// resolveCommerceFeatures / assertFeatureEnabled — Issue #118
// ---------------------------------------------------------------------------

describe("resolveCommerceFeatures", () => {
  test("defaults every flag to true when settings are absent", () => {
    expect(resolveCommerceFeatures(undefined)).toEqual(
      DEFAULT_COMMERCE_FEATURES
    );
    expect(resolveCommerceFeatures(null)).toEqual(DEFAULT_COMMERCE_FEATURES);
    expect(resolveCommerceFeatures({})).toEqual(DEFAULT_COMMERCE_FEATURES);
  });

  test("resolves each flag independently — a partial stored object still yields every OTHER flag's default (the migration-free upgrade path)", () => {
    const resolved = resolveCommerceFeatures({ features: { pos: false } });
    expect(resolved).toEqual({
      pos: false,
      inbox: true,
      campaigns: true,
      gateway: true,
      courier: true
    });
  });

  test("a non-boolean stored value for a key falls back to that key's default rather than propagating garbage", () => {
    const resolved = resolveCommerceFeatures({
      features: { inbox: "nope" as unknown as boolean }
    });
    expect(resolved.inbox).toBe(true);
  });

  test("every flag can be turned off", () => {
    const resolved = resolveCommerceFeatures({
      features: {
        pos: false,
        inbox: false,
        campaigns: false,
        gateway: false,
        courier: false
      }
    });
    expect(resolved).toEqual({
      pos: false,
      inbox: false,
      campaigns: false,
      gateway: false,
      courier: false
    });
  });
});

describe("assertFeatureEnabled", () => {
  test("does not throw when the feature is enabled", () => {
    expect(() =>
      assertFeatureEnabled(DEFAULT_COMMERCE_FEATURES, "inbox")
    ).not.toThrow();
  });

  test("throws a typed FeatureDisabledError naming the feature when disabled", () => {
    const features = resolveCommerceFeatures({
      features: { campaigns: false }
    });
    try {
      assertFeatureEnabled(features, "campaigns");
      throw new Error("expected assertFeatureEnabled to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FeatureDisabledError);
      expect((error as FeatureDisabledError).feature).toBe("campaigns");
    }
  });

  test("isCommerceFeatureEnabled is a plain boolean read with no throw", () => {
    const features = resolveCommerceFeatures({ features: { courier: false } });
    expect(isCommerceFeatureEnabled(features, "courier")).toBe(false);
    expect(isCommerceFeatureEnabled(features, "gateway")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tiered pricing at quote — Issue #118 (ADR-0016 D6)
// ---------------------------------------------------------------------------

function product(
  overrides: Partial<CartQuoteProductSnapshot> = {}
): CartQuoteProductSnapshot {
  return {
    id: "product-1",
    slug: "mie-gacoan",
    name: "Mie Gacoan",
    sku: "GC",
    price: "10000.00",
    priceLevel2: "9000.00",
    priceLevel3: "8000.00",
    priceLevel4: null,
    discountPercent: 0,
    stock: 100,
    status: "active",
    minPurchase: 1,
    weightGrams: 350,
    withInsurance: false,
    insuranceRequired: false,
    allowDp: false,
    allowFreeShipping: true,
    serviceForm: null,
    imageUrl: null,
    imageAlt: null,
    ...overrides
  };
}

function defaultSettings(): StoreSettingsData {
  return {
    schemaVersion: 1,
    storeName: "Toko",
    tagline: null,
    logoMediaObjectId: null,
    faviconMediaObjectId: null,
    address: null,
    phone: null,
    whatsapp: null,
    email: null,
    mapsEmbedUrl: null,
    faqs: [],
    social: {
      facebook: null,
      instagram: null,
      tiktok: null,
      x: null,
      youtube: null,
      linkedin: null
    },
    customerLevels: [1, 2, 3, 4].map((level) => ({
      level,
      name: `Level ${level}`,
      type: "percentage",
      value: "0.00"
    })),
    shipping: {
      alternativeServices: [],
      selfPickup: true,
      courierEnabled: false,
      pinpointEnabled: false,
      freeShipping: { active: false, minOrder: "0.00", maxDiscount: "0.00" },
      originCityName: null,
      originSubdistrictName: null,
      courier: { enabled: false, originDestinationId: null, couriers: [] }
    },
    payment: {
      manualBank: { active: false, accounts: [] },
      manualQris: { active: true, mediaObjectId: null },
      downPayment: { active: false, percent: 0 },
      tax: { active: false, percent: 0 },
      insurance: { active: false, ratePercent: "0.0", minFee: "0.00" },
      gateway: { enabled: false }
    },
    orders: { expiryHours: 24 },
    promoSection: { active: false, items: [] },
    meta: {
      home: { title: null, description: null },
      contact: { title: null, description: null }
    }
  };
}

function baseContext(): CartQuoteContext {
  return {
    products: new Map([["product-1", product()]]),
    variants: new Map(),
    flashSales: new Map(),
    storeSettings: defaultSettings(),
    voucher: null,
    now: new Date("2026-09-19T00:00:00Z")
  };
}

describe("quoteCart — tiered pricing (Issue #118)", () => {
  const line = {
    productId: "product-1",
    variantId: null,
    quantity: 1,
    serviceFormValues: null
  };

  test("an anonymous quote (no customerLevel) prices at the ordinary retail price", () => {
    const result = quoteCart(
      { lines: [line], shipping: null, insurance: false },
      baseContext()
    );
    expect(result.lines[0]!.unitPrice).toBe("10000.00");
  });

  test("level 1 prices identically to anonymous", () => {
    const result = quoteCart(
      { lines: [line], shipping: null, insurance: false, customerLevel: 1 },
      baseContext()
    );
    expect(result.lines[0]!.unitPrice).toBe("10000.00");
  });

  test("level 2 uses price_level_2", () => {
    const result = quoteCart(
      { lines: [line], shipping: null, insurance: false, customerLevel: 2 },
      baseContext()
    );
    expect(result.lines[0]!.unitPrice).toBe("9000.00");
  });

  test("level 3 uses price_level_3", () => {
    const result = quoteCart(
      { lines: [line], shipping: null, insurance: false, customerLevel: 3 },
      baseContext()
    );
    expect(result.lines[0]!.unitPrice).toBe("8000.00");
  });

  test("level 4 falls back to the ordinary price when price_level_4 is null", () => {
    const result = quoteCart(
      { lines: [line], shipping: null, insurance: false, customerLevel: 4 },
      baseContext()
    );
    expect(result.lines[0]!.unitPrice).toBe("10000.00");
  });

  test("a discount still applies on top of the tier price", () => {
    const context = baseContext();
    context.products = new Map([
      ["product-1", product({ discountPercent: 10 })]
    ]);
    const result = quoteCart(
      { lines: [line], shipping: null, insurance: false, customerLevel: 2 },
      context
    );
    // 9000.00 at 10% off = 8100.00
    expect(result.lines[0]!.unitPrice).toBe("8100.00");
  });

  test("an active flash sale still wins over a tier price", () => {
    const context = baseContext();
    context.flashSales = new Map([
      [
        "product-1:",
        {
          flashSaleId: "fs-1",
          productId: "product-1",
          variantId: null,
          salePrice: "5000.00",
          quota: 10,
          sold: 0
        }
      ]
    ]);
    const result = quoteCart(
      { lines: [line], shipping: null, insurance: false, customerLevel: 2 },
      context
    );
    expect(result.lines[0]!.unitPrice).toBe("5000.00");
  });

  test("a variant price override still wins over a tier price", () => {
    const context = baseContext();
    context.variants = new Map([
      [
        "variant-1",
        {
          id: "variant-1",
          productId: "product-1",
          value: "Large",
          sku: "GC-L",
          price: "12000.00",
          stock: 10,
          weightGrams: 400
        }
      ]
    ]);
    const result = quoteCart(
      {
        lines: [{ ...line, variantId: "variant-1" }],
        shipping: null,
        insurance: false,
        customerLevel: 2
      },
      context
    );
    expect(result.lines[0]!.unitPrice).toBe("12000.00");
  });
});

// ---------------------------------------------------------------------------
// Public store-settings composition — Issue #118
// ---------------------------------------------------------------------------

const noopMediaPort = {
  resolveMediaReferences: async () => new Map(),
  isMediaReferenceSafe: async () => false
};

describe("toPublicRecord — feature composition (Issue #118)", () => {
  test("inboxEnabled/campaignsEnabled mirror the raw feature flags", async () => {
    const settings = defaultSettings();
    const record = await toPublicRecord(
      {} as never,
      "tenant-1",
      settings,
      noopMediaPort as never,
      false,
      false,
      false,
      resolveCommerceFeatures({
        features: { inbox: false, campaigns: true }
      })
    );
    expect(record.inboxEnabled).toBe(false);
    expect(record.campaignsEnabled).toBe(true);
  });

  test("whatsappOtpEnabled reflects the provider-configured parameter, independent of features", async () => {
    const settings = defaultSettings();
    const record = await toPublicRecord(
      {} as never,
      "tenant-1",
      settings,
      noopMediaPort as never,
      false,
      false,
      false,
      DEFAULT_COMMERCE_FEATURES,
      true
    );
    expect(record.whatsappOtpEnabled).toBe(true);
  });

  test("gatewayEnabled requires features.gateway on top of the store setting and provider configuration", async () => {
    const settings = defaultSettings();
    settings.payment.gateway.enabled = true;

    const withFeatureOff = await toPublicRecord(
      {} as never,
      "tenant-1",
      settings,
      noopMediaPort as never,
      false,
      false,
      true,
      resolveCommerceFeatures({ features: { gateway: false } })
    );
    expect(withFeatureOff.payment.gatewayEnabled).toBe(false);

    const withFeatureOn = await toPublicRecord(
      {} as never,
      "tenant-1",
      settings,
      noopMediaPort as never,
      false,
      false,
      true,
      DEFAULT_COMMERCE_FEATURES
    );
    expect(withFeatureOn.payment.gatewayEnabled).toBe(true);
  });

  test("courierEnabled requires features.courier on top of the store setting and provider configuration", async () => {
    const settings = defaultSettings();
    settings.shipping.courier.enabled = true;

    const withFeatureOff = await toPublicRecord(
      {} as never,
      "tenant-1",
      settings,
      noopMediaPort as never,
      false,
      true,
      false,
      resolveCommerceFeatures({ features: { courier: false } })
    );
    expect(withFeatureOff.shipping.courierEnabled).toBe(false);

    const withFeatureOn = await toPublicRecord(
      {} as never,
      "tenant-1",
      settings,
      noopMediaPort as never,
      false,
      true,
      false,
      DEFAULT_COMMERCE_FEATURES
    );
    expect(withFeatureOn.shipping.courierEnabled).toBe(true);
  });
});
