/**
 * `commerce` courier-rate domain tests (Issue #107, contract #106's D4).
 * Pure — no database, no network. Covers `domain/weight-bucket.ts`,
 * `domain/courier-service-id.ts`, `domain/cart-quote.ts`'s courier
 * integration (`buildShippingOptions`/`quoteCart`), and
 * `infrastructure/rajaongkir-provider.ts`/`log-shipping-rate-provider.ts`
 * against a mocked `fetch`.
 */
import { describe, expect, test, mock, afterEach } from "bun:test";

import {
  computeWeightBucketGrams,
  MINIMUM_BILLABLE_GRAMS
} from "../src/modules/commerce/domain/weight-bucket";
import {
  formatCourierServiceId,
  parseCourierServiceId
} from "../src/modules/commerce/domain/courier-service-id";
import {
  buildShippingOptions,
  type CartQuoteCourierContext
} from "../src/modules/commerce/domain/cart-quote";
import { createLogShippingRateProvider } from "../src/modules/commerce/infrastructure/log-shipping-rate-provider";
import {
  createRajaOngkirProvider,
  ShippingProviderCallFailedError
} from "../src/modules/commerce/infrastructure/rajaongkir-provider";
import type { StoreSettingsData } from "../src/modules/commerce/domain/store-settings-validation";

function baseSettings(courierEnabled: boolean): StoreSettingsData {
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
      type: "percentage" as const,
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
      courier: {
        enabled: courierEnabled,
        originDestinationId: "origin-1",
        couriers: ["jne", "jnt"]
      }
    },
    payment: {
      manualBank: { active: false, accounts: [] },
      manualQris: { active: false, mediaObjectId: null },
      downPayment: { active: false, percent: 0 },
      tax: { active: false, percent: 0 },
      insurance: { active: false, ratePercent: "0.0", minFee: "0.00" }
    },
    orders: { expiryHours: 24 },
    promoSection: { active: false, items: [] },
    meta: {
      home: { title: null, description: null },
      contact: { title: null, description: null }
    }
  };
}

// ---------------------------------------------------------------------------
// weight-bucket
// ---------------------------------------------------------------------------

describe("computeWeightBucketGrams", () => {
  test("rounds up to the next 100 g", () => {
    expect(computeWeightBucketGrams(1250)).toBe(1300);
    expect(computeWeightBucketGrams(1300)).toBe(1300);
    expect(computeWeightBucketGrams(1301)).toBe(1400);
  });

  test("floors at the 1000 g minimum billable weight", () => {
    expect(computeWeightBucketGrams(10)).toBe(MINIMUM_BILLABLE_GRAMS);
    expect(computeWeightBucketGrams(0)).toBe(MINIMUM_BILLABLE_GRAMS);
    expect(computeWeightBucketGrams(999)).toBe(MINIMUM_BILLABLE_GRAMS);
  });

  test("negative/non-finite input is treated as 0, never thrown", () => {
    expect(computeWeightBucketGrams(-50)).toBe(MINIMUM_BILLABLE_GRAMS);
    expect(computeWeightBucketGrams(Number.NaN)).toBe(MINIMUM_BILLABLE_GRAMS);
  });
});

// ---------------------------------------------------------------------------
// courier-service-id
// ---------------------------------------------------------------------------

describe("courier-service-id", () => {
  test("formats and parses round-trip", () => {
    const id = formatCourierServiceId("jne", "REG");
    expect(id).toBe("jne:REG");
    expect(parseCourierServiceId(id)).toEqual({
      courier: "jne",
      service: "REG"
    });
  });

  test("rejects a serviceId with no separator, or an empty side", () => {
    expect(parseCourierServiceId("jne")).toBeNull();
    expect(parseCourierServiceId(":REG")).toBeNull();
    expect(parseCourierServiceId("jne:")).toBeNull();
    expect(parseCourierServiceId("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cart-quote.ts's courier integration (buildShippingOptions)
// ---------------------------------------------------------------------------

describe("buildShippingOptions — courier", () => {
  test("feature off: single disabled placeholder, no note", () => {
    const options = buildShippingOptions(baseSettings(false), null);
    const courier = options.find((option) => option.method === "courier")!;
    expect(courier.available).toBe(false);
    expect(courier.name).toBe("Kurir (segera)");
    expect(courier.note ?? null).toBeNull();
  });

  test("enabled but no destination: disabled placeholder asking for one", () => {
    const context: CartQuoteCourierContext = {
      enabled: true,
      destinationProvided: false,
      options: [],
      unavailableReason: null
    };
    const options = buildShippingOptions(baseSettings(true), context);
    const courier = options.find((option) => option.method === "courier")!;
    expect(courier.available).toBe(false);
    expect(courier.note).toMatch(/tujuan/i);
  });

  test("enabled + destination but no resolved options: shows the resolver's own reason", () => {
    const context: CartQuoteCourierContext = {
      enabled: true,
      destinationProvided: true,
      options: [],
      unavailableReason: "Tujuan belum dikenali kurir"
    };
    const options = buildShippingOptions(baseSettings(true), context);
    const courier = options.find((option) => option.method === "courier")!;
    expect(courier.available).toBe(false);
    expect(courier.note).toBe("Tujuan belum dikenali kurir");
  });

  test("enabled + destination + resolved rates: one available option per rate", () => {
    const context: CartQuoteCourierContext = {
      enabled: true,
      destinationProvided: true,
      options: [
        {
          serviceId: "jne:REG",
          courier: "jne",
          service: "REG",
          name: "JNE REG",
          cost: "18000",
          etd: "2-3"
        },
        {
          serviceId: "jnt:EZ",
          courier: "jnt",
          service: "EZ",
          name: "J&T EZ",
          cost: "15000.5",
          etd: "3-4"
        }
      ],
      unavailableReason: null
    };
    const options = buildShippingOptions(baseSettings(true), context);
    const courierOptions = options.filter(
      (option) => option.method === "courier"
    );
    expect(courierOptions).toHaveLength(2);
    expect(courierOptions[0]).toMatchObject({
      serviceId: "jne:REG",
      name: "JNE REG",
      cost: "18000.00",
      available: true,
      etd: "2-3"
    });
    expect(courierOptions[1]?.cost).toBe("15000.50");
  });
});

// ---------------------------------------------------------------------------
// infrastructure/log-shipping-rate-provider.ts
// ---------------------------------------------------------------------------

describe("createLogShippingRateProvider", () => {
  test("returns deterministic fixture rates, one per requested courier", async () => {
    const provider = createLogShippingRateProvider();
    const rates = await provider.getRates({
      originId: "origin-1",
      destinationId: "dest-1",
      weightGrams: 2000,
      couriers: ["jne", "jnt"]
    });
    expect(rates).toHaveLength(2);
    expect(rates[0]?.cost).toBe("18000.00");
    expect(rates.every((rate) => rate.service === "REG")).toBe(true);
  });

  test("searchDestination echoes the query as a synthetic candidate", async () => {
    const provider = createLogShippingRateProvider();
    const candidates = await provider.searchDestination("Sukajadi");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.districtName).toBe("Sukajadi");
  });
});

// ---------------------------------------------------------------------------
// infrastructure/rajaongkir-provider.ts — mocked fetch (Komerce API v2 shape)
// ---------------------------------------------------------------------------

describe("createRajaOngkirProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("searchDestination maps the documented response shape", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 12345,
                label: "Sukajadi, Bandung, Jawa Barat",
                province_name: "Jawa Barat",
                city_name: "Bandung",
                district_name: "Sukajadi",
                subdistrict_name: null,
                zip_code: "40164"
              }
            ]
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    const provider = createRajaOngkirProvider({ apiKey: "test-key" });
    const candidates = await provider.searchDestination("Sukajadi Bandung");

    expect(candidates).toEqual([
      {
        id: "12345",
        label: "Sukajadi, Bandung, Jawa Barat",
        provinceName: "Jawa Barat",
        cityName: "Bandung",
        districtName: "Sukajadi",
        subdistrictName: null,
        zipCode: "40164"
      }
    ]);
  });

  test("getRates maps the documented calculate/domestic-cost shape and normalizes cost", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                name: "JNE",
                code: "jne",
                service: "REG",
                description: "Reguler",
                cost: 18000,
                etd: "2-3"
              }
            ]
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    const provider = createRajaOngkirProvider({ apiKey: "test-key" });
    const rates = await provider.getRates({
      originId: "1",
      destinationId: "2",
      weightGrams: 1000,
      couriers: ["jne"]
    });

    expect(rates).toEqual([
      {
        courier: "jne",
        service: "REG",
        name: "JNE",
        cost: "18000.00",
        etd: "2-3"
      }
    ]);
  });

  test("a non-2xx response fails the call (and trips the breaker, not swallowed)", async () => {
    globalThis.fetch = mock(
      async () => new Response("", { status: 500 })
    ) as unknown as typeof fetch;

    const provider = createRajaOngkirProvider({ apiKey: "test-key" });
    await expect(provider.searchDestination("x")).rejects.toBeInstanceOf(
      ShippingProviderCallFailedError
    );
  });

  test("getRates with no couriers requested short-circuits without calling fetch", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = createRajaOngkirProvider({ apiKey: "test-key" });
    const rates = await provider.getRates({
      originId: "1",
      destinationId: "2",
      weightGrams: 1000,
      couriers: []
    });

    expect(rates).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
