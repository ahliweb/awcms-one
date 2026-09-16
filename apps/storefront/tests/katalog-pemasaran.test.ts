import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  findFlashSaleForProduct,
  getActiveFlashSales,
  getActivePopup,
  getActiveSliders,
  getActiveTestimonials,
  getPublicVouchers,
  getStoreSettings,
  isGoogleMapsEmbedUrl,
  resetPemasaranCacheForTests,
  type FlashSale
} from "../src/lib/awcms/pemasaran";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_API_URL = process.env.AWCMS_API_URL;
const ORIGINAL_API_TOKEN = process.env.AWCMS_API_TOKEN;

function mockFetch(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

function mockFetchCounting(status: number, body: unknown): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return () => calls;
}

beforeEach(() => {
  process.env.AWCMS_API_URL = "http://awcms.test";
  process.env.AWCMS_API_TOKEN = "test-token";
  resetPemasaranCacheForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_API_URL === undefined) delete process.env.AWCMS_API_URL;
  else process.env.AWCMS_API_URL = ORIGINAL_API_URL;
  if (ORIGINAL_API_TOKEN === undefined) delete process.env.AWCMS_API_TOKEN;
  else process.env.AWCMS_API_TOKEN = ORIGINAL_API_TOKEN;
  resetPemasaranCacheForTests();
});

const NOT_FOUND_BODY = { success: false, error: { code: "NOT_FOUND", message: "no such route" } };

describe("pemasaran: 404 tolerance — degrades, never fails the build", () => {
  test("getActiveSliders -> [] on 404", async () => {
    mockFetch(404, NOT_FOUND_BODY);
    expect(await getActiveSliders()).toEqual([]);
  });

  test("getActiveFlashSales -> [] on 404", async () => {
    mockFetch(404, NOT_FOUND_BODY);
    expect(await getActiveFlashSales()).toEqual([]);
  });

  test("getPublicVouchers -> [] on 404", async () => {
    mockFetch(404, NOT_FOUND_BODY);
    expect(await getPublicVouchers()).toEqual([]);
  });

  test("getActiveTestimonials -> [] on 404", async () => {
    mockFetch(404, NOT_FOUND_BODY);
    expect(await getActiveTestimonials()).toEqual([]);
  });

  test("getActivePopup -> null on 404", async () => {
    mockFetch(404, NOT_FOUND_BODY);
    expect(await getActivePopup()).toBeNull();
  });

  test("getStoreSettings -> defaults (with fallback customer levels) on 404", async () => {
    mockFetch(404, NOT_FOUND_BODY);
    const settings = await getStoreSettings();
    expect(settings.faqs).toEqual([]);
    expect(settings.mapsEmbedUrl).toBeNull();
    expect(settings.customerLevels).toEqual([
      { level: 1, name: "Pelanggan Umum" },
      { level: 2, name: "Reseller" },
      { level: 3, name: "Agen" },
      { level: 4, name: "Distributor" }
    ]);
  });
});

describe("pemasaran: anything other than 404 is NOT tolerated", () => {
  test("a 500 throws rather than degrading", async () => {
    mockFetch(500, { success: false, error: { code: "INTERNAL", message: "boom" } });
    await expect(getActiveSliders()).rejects.toThrow();
  });

  test("a 403 throws rather than degrading (unlike site identity's 403/404 rule — this contract tolerates 404 ONLY)", async () => {
    mockFetch(403, { success: false, error: { code: "FORBIDDEN", message: "no" } });
    await expect(getActiveSliders()).rejects.toThrow();
  });
});

describe("pemasaran: a genuine success response passes through untouched", () => {
  test("getActiveSliders", async () => {
    const sliders = [
      {
        id: "s1",
        title: "Promo",
        subtitle: null,
        image: { url: "https://x/y.jpg", alt: "Alt", width: 100, height: 100 },
        linkUrl: "/produk",
        buttonText: "Lihat",
        sortOrder: 1
      }
    ];
    mockFetch(200, { success: true, data: sliders });
    expect(await getActiveSliders()).toEqual(sliders);
  });

  test("getActivePopup: data: null is a normal '200, no active popup' — not the 404-tolerance path", async () => {
    mockFetch(200, { success: true, data: null });
    expect(await getActivePopup()).toBeNull();
  });
});

describe("pemasaran: each resource is fetched (and memoized) at most once per build", () => {
  test("getActiveSliders", async () => {
    const calls = mockFetchCounting(200, { success: true, data: [] });
    await getActiveSliders();
    await getActiveSliders();
    expect(calls()).toBe(1);
  });
});

describe("pemasaran: isGoogleMapsEmbedUrl", () => {
  test("accepts a genuine Google Maps embed URL", () => {
    expect(isGoogleMapsEmbedUrl("https://www.google.com/maps/embed?pb=abc123")).toBe(true);
  });

  test("rejects null/undefined, a malformed URL, and an arbitrary origin trying to look like one", () => {
    expect(isGoogleMapsEmbedUrl(null)).toBe(false);
    expect(isGoogleMapsEmbedUrl("not a url")).toBe(false);
    expect(isGoogleMapsEmbedUrl("https://evil.example.com/maps/embed")).toBe(false);
    expect(isGoogleMapsEmbedUrl("javascript:alert(1)")).toBe(false);
    expect(isGoogleMapsEmbedUrl("http://www.google.com/maps/embed")).toBe(false);
  });
});

describe("pemasaran: findFlashSaleForProduct", () => {
  const sale: FlashSale = {
    id: "sale-1",
    name: "Flash Sale",
    slug: "flash-sale",
    startsAt: "2026-09-18T01:00:00.000Z",
    endsAt: "2026-09-18T13:00:00.000Z",
    status: "active",
    products: [
      {
        productId: "p1",
        variantId: null,
        salePrice: "8000.00",
        originalPrice: "10000.00",
        quota: 10,
        sold: 1,
        sortOrder: 1,
        product: { id: "p1", slug: "p1", name: "P1", image: null }
      },
      {
        productId: "p2",
        variantId: "v2",
        salePrice: "5000.00",
        originalPrice: "6000.00",
        quota: 5,
        sold: 0,
        sortOrder: 2,
        product: { id: "p2", slug: "p2", name: "P2", image: null }
      }
    ]
  };

  test("a product-level entry (variantId: null) matches regardless of the queried variant", () => {
    expect(findFlashSaleForProduct([sale], "p1", null)?.entry.productId).toBe("p1");
    expect(findFlashSaleForProduct([sale], "p1", "some-variant")?.entry.productId).toBe("p1");
  });

  test("a variant-specific entry matches only that variant", () => {
    expect(findFlashSaleForProduct([sale], "p2", "v2")?.entry.productId).toBe("p2");
    expect(findFlashSaleForProduct([sale], "p2", "other-variant")).toBeNull();
    expect(findFlashSaleForProduct([sale], "p2", null)).toBeNull();
  });

  test("no match returns null", () => {
    expect(findFlashSaleForProduct([sale], "unknown", null)).toBeNull();
  });
});
