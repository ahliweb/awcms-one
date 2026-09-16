/**
 * `src/lib/toko-klien.ts` — the anonymous cross-origin commerce client
 * (issue #30). Every assertion here is about the REQUEST this file builds
 * (path, method, body, `mode`/`credentials`, headers) and the ERROR shape
 * it produces — never about what a real CMS answers, which is the CMS
 * agent's own (#29) test suite to own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cancelOrder,
  createOrder,
  getOrder,
  quoteCart,
  submitPaymentConfirmation,
  submitReview,
  TokoApiError,
  type CreateOrderRequest,
  type QuoteRequest
} from "../src/lib/toko-klien";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ORIGIN = process.env.PUBLIC_AWCMS_ORIGIN;

let lastRequest: { url: string; init: RequestInit } | null = null;

function mockFetch(status: number, body: unknown): void {
  lastRequest = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    lastRequest = { url: String(url), init };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.PUBLIC_AWCMS_ORIGIN = "https://cms.example.com";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ORIGIN === undefined) delete process.env.PUBLIC_AWCMS_ORIGIN;
  else process.env.PUBLIC_AWCMS_ORIGIN = ORIGINAL_ORIGIN;
});

const QUOTE_REQUEST: QuoteRequest = {
  lines: [{ productId: "p1", variantId: null, quantity: 2, serviceFormValues: null }],
  shipping: null,
  voucherCode: null,
  insurance: false
};

describe("toko-klien: request builder", () => {
  test("quoteCart POSTs to the configured origin's storefront path", async () => {
    mockFetch(200, { success: true, data: { quotedAt: "2026-09-16T00:00:00.000Z" } });
    await quoteCart(QUOTE_REQUEST);

    expect(lastRequest?.url).toBe("https://cms.example.com/api/v1/commerce/storefront/cart/quote");
    expect(lastRequest?.init.method).toBe("POST");
  });

  test("every request is cors + credentials omit — never a cookie, never a wider mode", async () => {
    mockFetch(200, { success: true, data: {} });
    await quoteCart(QUOTE_REQUEST);

    expect(lastRequest?.init.mode).toBe("cors");
    expect(lastRequest?.init.credentials).toBe("omit");
  });

  test("the ONLY header sent is Content-Type — no Authorization, no custom header", async () => {
    mockFetch(200, { success: true, data: {} });
    await quoteCart(QUOTE_REQUEST);

    const headers = lastRequest?.init.headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual(["Content-Type"]);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("the body is the request object, JSON-encoded verbatim", async () => {
    mockFetch(200, { success: true, data: {} });
    await quoteCart(QUOTE_REQUEST);

    expect(JSON.parse(String(lastRequest?.init.body))).toEqual(QUOTE_REQUEST);
  });

  test("getOrder is a GET with the phone in the query string, no body", async () => {
    mockFetch(200, { success: true, data: { orderCode: "X" } });
    await getOrder("BJM-1", "0812 3456 7890");

    expect(lastRequest?.init.method).toBe("GET");
    expect(lastRequest?.init.body).toBeUndefined();
    expect(lastRequest?.url).toBe(
      "https://cms.example.com/api/v1/commerce/storefront/orders/BJM-1?phone=0812%203456%207890"
    );
  });

  test("cancelOrder/submitPaymentConfirmation/submitReview all hit their own documented path", async () => {
    mockFetch(200, { success: true, data: {} });
    await cancelOrder("BJM-1", { phone: "0812", reason: null });
    expect(lastRequest?.url).toContain("/orders/BJM-1/cancel");

    mockFetch(201, { success: true, data: {} });
    await submitPaymentConfirmation("BJM-1", {
      phone: "0812",
      method: "manual_qris",
      amount: "1000.00",
      bankName: null,
      accountName: null,
      transferredAt: "2026-09-16T00:00:00.000Z",
      proofMediaObjectId: null
    });
    expect(lastRequest?.url).toContain("/orders/BJM-1/payment-confirmations");

    mockFetch(201, { success: true, data: { id: "r1", status: "pending" } });
    await submitReview({ orderCode: "BJM-1", phone: "0812", productId: "p1", rating: 5, body: "Mantap" });
    expect(lastRequest?.url).toContain("/reviews");
  });

  test("an order code with special characters is percent-encoded in the path", async () => {
    mockFetch(200, { success: true, data: {} });
    await getOrder("BJM 1/2", "0812");
    expect(lastRequest?.url).toContain("/orders/BJM%201%2F2");
  });
});

describe("toko-klien: errors", () => {
  test("a failure envelope becomes a TokoApiError carrying code/message/details", async () => {
    mockFetch(400, {
      success: false,
      error: { code: "VALIDATION_ERROR", message: "bad input", details: [{ field: "customer.phone", message: "required" }] }
    });

    await expect(quoteCart(QUOTE_REQUEST)).rejects.toThrow(TokoApiError);

    try {
      await quoteCart(QUOTE_REQUEST);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(TokoApiError);
      const apiError = error as TokoApiError;
      expect(apiError.code).toBe("VALIDATION_ERROR");
      expect(apiError.status).toBe(400);
      expect(apiError.fieldErrors).toEqual([{ field: "customer.phone", message: "required" }]);
    }
  });

  test("fieldErrors is empty for a non-VALIDATION_ERROR code", async () => {
    mockFetch(404, { success: false, error: { code: "NOT_FOUND", message: "Not found." } });
    try {
      await getOrder("X", "0812");
    } catch (error) {
      expect((error as TokoApiError).fieldErrors).toEqual([]);
    }
  });

  test("freshQuote surfaces details.quote on CART_CHANGED, null otherwise", async () => {
    const quote = { subtotal: "1.00" };
    mockFetch(409, { success: false, error: { code: "CART_CHANGED", message: "changed", details: { quote } } });
    try {
      await createOrder({} as CreateOrderRequest);
    } catch (error) {
      expect((error as TokoApiError).freshQuote).toEqual(quote as never);
    }

    mockFetch(404, { success: false, error: { code: "NOT_FOUND", message: "Not found." } });
    try {
      await getOrder("X", "0812");
    } catch (error) {
      expect((error as TokoApiError).freshQuote).toBeNull();
    }
  });

  test("retryAfterSeconds surfaces details.retryAfter on RATE_LIMITED, null otherwise", async () => {
    mockFetch(429, {
      success: false,
      error: { code: "RATE_LIMITED", message: "slow down", details: { retryAfter: 30 } }
    });
    try {
      await quoteCart(QUOTE_REQUEST);
    } catch (error) {
      expect((error as TokoApiError).retryAfterSeconds).toBe(30);
    }
  });

  test("a network failure becomes a NETWORK_ERROR TokoApiError, not a raw rejection", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    try {
      await quoteCart(QUOTE_REQUEST);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(TokoApiError);
      expect((error as TokoApiError).code).toBe("NETWORK_ERROR");
    }
  });

  test("a non-JSON response becomes an INVALID_RESPONSE TokoApiError", async () => {
    globalThis.fetch = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;

    try {
      await quoteCart(QUOTE_REQUEST);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as TokoApiError).code).toBe("INVALID_RESPONSE");
    }
  });

  test("success:true still unwraps to just `data`, never the envelope", async () => {
    mockFetch(200, { success: true, data: { subtotal: "1.00" } });
    const quote = await quoteCart(QUOTE_REQUEST);
    expect(quote).toEqual({ subtotal: "1.00" } as never);
  });
});

describe("toko-klien: PUBLIC_AWCMS_ORIGIN is required", () => {
  test("an unset origin throws before any fetch happens, naming the variable", async () => {
    delete process.env.PUBLIC_AWCMS_ORIGIN;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    await expect(quoteCart(QUOTE_REQUEST)).rejects.toThrow(/PUBLIC_AWCMS_ORIGIN/);
    expect(fetchCalled).toBe(false);
  });
});
