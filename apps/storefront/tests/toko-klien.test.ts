/**
 * `src/lib/toko-klien.ts` — the anonymous cross-origin commerce client
 * (issue #30). Every assertion here is about the REQUEST this file builds
 * (path, method, body, `mode`/`credentials`, headers) and the ERROR shape
 * it produces — never about what a real CMS answers, which is the CMS
 * agent's own (#29) test suite to own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ambilKetersediaanBooking,
  ambilKuotaBooking,
  ambilTawaranBooking,
  cancelOrder,
  createGatewaySession,
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

  test("createGatewaySession POSTs to the documented path with {phone} when given a phone, no Authorization", async () => {
    mockFetch(201, {
      success: true,
      data: { redirectUrl: "https://gateway.example/pay/1", expiresAt: "2026-09-19T00:00:00.000Z", providerRef: "ref-1" }
    });

    const session = await createGatewaySession("BJM-1", "0812");

    expect(lastRequest?.url).toContain("/orders/BJM-1/payment-gateway/sessions");
    expect(lastRequest?.init.method).toBe("POST");
    expect(JSON.parse(String(lastRequest?.init.body))).toEqual({ phone: "0812" });
    expect((lastRequest?.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(session.redirectUrl).toBe("https://gateway.example/pay/1");
  });

  test("createGatewaySession sends no phone field, and Authorization: Bearer, when a bearer token is given instead", async () => {
    mockFetch(201, {
      success: true,
      data: { redirectUrl: "https://gateway.example/pay/2", expiresAt: "2026-09-19T00:00:00.000Z", providerRef: "ref-2" }
    });

    await createGatewaySession("BJM-2", null, "cs_stub_1");

    expect(JSON.parse(String(lastRequest?.init.body))).toEqual({});
    expect((lastRequest?.init.headers as Record<string, string>).Authorization).toBe("Bearer cs_stub_1");
  });

  test("a 409 PAYMENT_NOT_APPLICABLE / 503 GATEWAY_UNAVAILABLE from the session endpoint surface as TokoApiError", async () => {
    mockFetch(409, { success: false, error: { code: "PAYMENT_NOT_APPLICABLE", message: "not a gateway order" } });
    await expect(createGatewaySession("BJM-3", "0812")).rejects.toMatchObject({ code: "PAYMENT_NOT_APPLICABLE" });

    mockFetch(503, { success: false, error: { code: "GATEWAY_UNAVAILABLE", message: "gateway down" } });
    await expect(createGatewaySession("BJM-3", "0812")).rejects.toMatchObject({ code: "GATEWAY_UNAVAILABLE" });
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

describe("toko-klien: the booking reads (issue #386)", () => {
  const OFFERING = "11111111-1111-4111-8111-111111111111";
  const RESOURCE = "22222222-2222-4222-8222-222222222222";

  test("offerings is a plain cors GET with no header and no body; a session token adds Authorization only", async () => {
    mockFetch(200, { success: true, data: { items: [] } });
    await ambilTawaranBooking();
    expect(lastRequest?.url).toBe("https://cms.example.com/api/v1/commerce/storefront/booking/offerings");
    expect(lastRequest?.init.method).toBe("GET");
    expect(lastRequest?.init.mode).toBe("cors");
    expect(lastRequest?.init.credentials).toBe("omit");
    expect(lastRequest?.init.headers).toBeUndefined();
    expect(lastRequest?.init.body).toBeUndefined();

    await ambilTawaranBooking("cs_stub_1");
    expect(lastRequest?.init.headers).toEqual({ Authorization: "Bearer cs_stub_1" });
  });

  test("availability puts the ids and the two dates in the query and nothing else", async () => {
    mockFetch(200, { success: true, data: { mode: "stay", available: true } });
    await ambilKetersediaanBooking({ offeringId: OFFERING, resourceId: RESOURCE, checkInDate: "2026-11-01", checkOutDate: "2026-11-03" });
    const url = new URL(String(lastRequest?.url));
    expect(url.pathname).toBe("/api/v1/commerce/storefront/booking/availability");
    expect([...url.searchParams.keys()].sort()).toEqual(["checkInDate", "checkOutDate", "offeringId", "resourceId"]);
    expect(url.searchParams.get("checkInDate")).toBe("2026-11-01");
    expect(lastRequest?.init.headers).toBeUndefined();
  });

  test("the quote sends dates only - never a night count or an amount - and an optional bearer", async () => {
    mockFetch(200, { success: true, data: { nights: 2, total: "900000.00" } });
    const result = await ambilKuotaBooking({ offeringId: OFFERING, checkInDate: "2026-11-01", checkOutDate: "2026-11-03" }, "cs_stub_1");
    const url = new URL(String(lastRequest?.url));
    expect(url.pathname).toBe("/api/v1/commerce/storefront/booking/quote");
    expect([...url.searchParams.keys()].sort()).toEqual(["checkInDate", "checkOutDate", "offeringId"]);
    expect(lastRequest?.init.headers).toEqual({ Authorization: "Bearer cs_stub_1" });
    // The server's figures come back untouched.
    expect(result.nights).toBe(2);
    expect(result.total).toBe("900000.00");
  });

  test("a 404 (feature off) and a 400 surface as TokoApiError with their code", async () => {
    mockFetch(404, { success: false, error: { code: "NOT_FOUND", message: "Not found." } });
    await expect(ambilTawaranBooking()).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    mockFetch(400, { success: false, error: { code: "VALIDATION_ERROR", message: "bad", details: [{ field: "checkOutDate", message: "x" }] } });
    const error = await ambilKuotaBooking({ offeringId: OFFERING, checkInDate: "a", checkOutDate: "b" }).catch((e) => e);
    expect(error).toBeInstanceOf(TokoApiError);
    expect(error.fieldErrors).toEqual([{ field: "checkOutDate", message: "x" }]);
  });

  test("createGatewaySession asks for a deposit or balance by purpose and still sends no amount; `full` is never sent", async () => {
    mockFetch(201, { success: true, data: { redirectUrl: "https://gateway.example/pay/9", expiresAt: "2026-10-19T00:00:00.000Z", providerRef: "r" } });
    await createGatewaySession("BJM-9", null, "cs_stub_1", "deposit");
    expect(JSON.parse(String(lastRequest?.init.body))).toEqual({ purpose: "deposit" });
    await createGatewaySession("BJM-9", null, "cs_stub_1", "balance");
    expect(JSON.parse(String(lastRequest?.init.body))).toEqual({ purpose: "balance" });
    await createGatewaySession("BJM-9", null, "cs_stub_1", "full");
    expect(JSON.parse(String(lastRequest?.init.body))).toEqual({});
    await createGatewaySession("BJM-9", "0812");
    expect(JSON.parse(String(lastRequest?.init.body))).toEqual({ phone: "0812" });
  });
});
