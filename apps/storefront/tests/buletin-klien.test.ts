/**
 * `src/scripts/buletin.ts` — the newsletter double opt-in client (issue #50).
 * Assertions are about the REQUEST this file builds (path, method, mode/
 * credentials, headers, body) and the ERROR shape it produces, mirroring
 * `tests/toko-klien.test.ts`'s own scope for issue #30's sibling file — never
 * about what a real CMS answers, which is `apps/cms`'s own suite to own.
 *
 * This file runs under plain `bun test`, with no DOM at all (no shim is
 * registered anywhere in this workspace). `buletin.ts` only reaches
 * `document` inside its own `typeof document !== "undefined"` guard (see
 * that file's own docblock), so importing it here for the pure functions
 * never touches that branch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BuletinApiError,
  buletinErrorMessage,
  confirmNewsletterSubscription,
  subscribeToNewsletter,
  unsubscribeFromNewsletter
} from "../src/scripts/buletin";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ORIGIN = process.env.PUBLIC_AWCMS_ORIGIN;

let lastRequest: { url: string; init: RequestInit } | null = null;

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}): void {
  lastRequest = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    lastRequest = { url: String(url), init };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers }
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

describe("buletin: request builder", () => {
  test("subscribeToNewsletter POSTs to the configured origin's newsletter path, with locale id", async () => {
    mockFetch(200, { success: true, data: { message: "ok" } });
    await subscribeToNewsletter("pembaca@example.com");

    expect(lastRequest?.url).toBe("https://cms.example.com/api/v1/newsletter/subscribe");
    expect(lastRequest?.init.method).toBe("POST");
    expect(JSON.parse(String(lastRequest?.init.body))).toEqual({
      email: "pembaca@example.com",
      locale: "id"
    });
  });

  test("every request is cors + credentials omit, one Content-Type header", async () => {
    mockFetch(200, { success: true, data: { message: "ok" } });
    await subscribeToNewsletter("pembaca@example.com");

    expect(lastRequest?.init.mode).toBe("cors");
    expect(lastRequest?.init.credentials).toBe("omit");
    const headers = lastRequest?.init.headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual(["Content-Type"]);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("confirmNewsletterSubscription and unsubscribeFromNewsletter POST { token } to their own path", async () => {
    mockFetch(200, { success: true, data: { message: "ok" } });
    await confirmNewsletterSubscription("tok123");
    expect(lastRequest?.url).toBe("https://cms.example.com/api/v1/newsletter/confirm");
    expect(JSON.parse(String(lastRequest?.init.body))).toEqual({ token: "tok123" });

    mockFetch(200, { success: true, data: { message: "ok" } });
    await unsubscribeFromNewsletter("tok456");
    expect(lastRequest?.url).toBe("https://cms.example.com/api/v1/newsletter/unsubscribe");
    expect(JSON.parse(String(lastRequest?.init.body))).toEqual({ token: "tok456" });
  });
});

describe("buletin: the four acceptance paths", () => {
  test("success: a 200 envelope resolves with the response data (never shown verbatim — see buletinErrorMessage tests)", async () => {
    mockFetch(200, { success: true, data: { message: "If that address can be subscribed, a confirmation email is on its way." } });
    const result = await subscribeToNewsletter("baru@example.com");
    expect(result.message).toContain("confirmation email");
  });

  test("duplicate: the SAME 200 envelope answers an already-subscribed address — indistinguishable from success, by design", async () => {
    mockFetch(200, { success: true, data: { message: "If that address can be subscribed, a confirmation email is on its way." } });
    const result = await subscribeToNewsletter("sudah-langganan@example.com");
    expect(result.message).toBe("If that address can be subscribed, a confirmation email is on its way.");
  });

  test("invalid: a 400 VALIDATION_ERROR becomes a BuletinApiError mapped to Indonesian copy", async () => {
    mockFetch(400, {
      success: false,
      error: { code: "VALIDATION_ERROR", message: "A valid email address is required.", details: [{ field: "email", message: "email is not an address." }] }
    });

    try {
      await subscribeToNewsletter("bukan-email");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BuletinApiError);
      expect((error as BuletinApiError).code).toBe("VALIDATION_ERROR");
      expect(buletinErrorMessage(error)).toBe("Alamat email tidak valid. Periksa kembali penulisannya.");
    }
  });

  test("rate-limited: a 429 RATE_LIMITED reads its wait from the Retry-After HEADER, and maps to Indonesian copy naming it", async () => {
    // The real CMS routes call `fail(429, "RATE_LIMITED", "...", {}, undefined, { "retry-after": "42", vary: "Origin" })`
    // (apps/cms/src/modules/_shared/api-response.ts's `fail(status, code, message, meta, details, headers)`)
    // — `details` is `undefined`, never `{ retryAfter }`; the wait travels as a response HEADER.
    mockFetch(
      429,
      { success: false, error: { code: "RATE_LIMITED", message: "Too many subscription requests from this source. Try again later." } },
      { "retry-after": "42" }
    );

    try {
      await subscribeToNewsletter("cepat@example.com");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as BuletinApiError).code).toBe("RATE_LIMITED");
      expect((error as BuletinApiError).retryAfterSeconds).toBe(42);
      expect(buletinErrorMessage(error)).toBe("Terlalu banyak percobaan. Coba lagi dalam 42 detik.");
    }
  });

  test("a 429 with no Retry-After header still maps to a generic 'try again' Indonesian message", async () => {
    mockFetch(429, { success: false, error: { code: "RATE_LIMITED", message: "Too many requests." } });

    try {
      await subscribeToNewsletter("cepat@example.com");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as BuletinApiError).retryAfterSeconds).toBeNull();
      expect(buletinErrorMessage(error)).toBe("Terlalu banyak percobaan. Coba lagi sebentar lagi.");
    }
  });
});

describe("buletin: errors", () => {
  test("a network failure becomes a NETWORK_ERROR BuletinApiError, not a raw rejection — and its copy never asserts a connectivity cause", async () => {
    // NETWORK_ERROR is not only a real dropped connection: a cross-origin
    // 400/429 from these routes carries NO CORS grant (see
    // `buletinErrorMessage`'s own docblock), so the browser's `fetch()`
    // rejects before the JSON body is ever read — the SAME rejection this
    // mock produces. The copy therefore must not claim "check your
    // connection", because the real cause is usually a bad address, not a
    // dead network.
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    try {
      await subscribeToNewsletter("x@example.com");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BuletinApiError);
      expect((error as BuletinApiError).code).toBe("NETWORK_ERROR");
      const message = buletinErrorMessage(error);
      expect(message).toBe("Pendaftaran belum berhasil. Periksa alamat e-mail Anda atau coba lagi beberapa menit lagi.");
      expect(message).not.toMatch(/koneksi|internet|connection/i);
    }
  });

  test("NETWORK_ERROR in the 'token' context (confirm/unsubscribe) points at the link, not an e-mail field that page has none of", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    try {
      await confirmNewsletterSubscription("tok123");
      throw new Error("should have thrown");
    } catch (error) {
      const message = buletinErrorMessage(error, "token");
      expect(message).toBe("Permintaan belum berhasil. Periksa kembali tautan dari email Anda atau coba lagi beberapa menit lagi.");
      expect(message).not.toMatch(/koneksi|internet|connection|alamat e-mail/i);
    }
  });

  test("a non-JSON response becomes an INVALID_RESPONSE BuletinApiError", async () => {
    globalThis.fetch = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;

    try {
      await subscribeToNewsletter("x@example.com");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as BuletinApiError).code).toBe("INVALID_RESPONSE");
    }
  });

  test("retryAfterSeconds is null for anything but RATE_LIMITED", async () => {
    mockFetch(400, { success: false, error: { code: "VALIDATION_ERROR", message: "bad" } });
    try {
      await subscribeToNewsletter("x");
    } catch (error) {
      expect((error as BuletinApiError).retryAfterSeconds).toBeNull();
    }
  });

  test("an unset PUBLIC_AWCMS_ORIGIN throws before any fetch happens", async () => {
    delete process.env.PUBLIC_AWCMS_ORIGIN;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    await expect(subscribeToNewsletter("x@example.com")).rejects.toThrow(/PUBLIC_AWCMS_ORIGIN/);
    expect(fetchCalled).toBe(false);
  });
});

describe("buletinErrorMessage", () => {
  test("every string it returns is Indonesian — never the server's raw English message", () => {
    const validation = new BuletinApiError("A valid email address is required.", 400, "VALIDATION_ERROR");
    const rateLimited = new BuletinApiError("Too many requests.", 429, "RATE_LIMITED", undefined, 5);
    const network = new BuletinApiError("network down", 0, "NETWORK_ERROR");
    const unknownCode = new BuletinApiError("some server text", 500, "SOME_UNDOCUMENTED_CODE");

    for (const error of [validation, rateLimited, network, unknownCode]) {
      const message = buletinErrorMessage(error);
      expect(message).not.toBe(error.message);
    }
  });

  test("a plain non-BuletinApiError value also gets a safe Indonesian fallback", () => {
    expect(buletinErrorMessage(new Error("boom"))).toBe("Terjadi kesalahan yang tidak terduga. Coba lagi nanti.");
    expect(buletinErrorMessage("boom")).toBe("Terjadi kesalahan yang tidak terduga. Coba lagi nanti.");
  });
});
