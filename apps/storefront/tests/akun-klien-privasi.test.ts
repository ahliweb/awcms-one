/**
 * The data-subject calls of `src/lib/akun-klien.ts` (issue #529, ADR-0055 D3):
 * the REQUEST each builds (path, method, bearer, body, `Idempotency-Key`), the
 * 401 session rule and the refusal read off a `409`. Same minimal `window`
 * stand-in `akun-klien-push.test.ts` uses.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eksporDataSaya, hapusDataSaya, mintaKodePrivasi } from "../src/lib/akun-klien";
import { bacaSesi, simpanSesi } from "../src/lib/akun-sesi";
import type { SesiAkun } from "../src/lib/akun-kontrak";
import { bacaPenolakan } from "../src/lib/privasi-kontrak";
import { TokoApiError } from "../src/lib/toko-permintaan";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ORIGIN = process.env.PUBLIC_AWCMS_ORIGIN;
const ORIGINAL_WINDOW = (globalThis as { window?: unknown }).window;
const BASE = "https://cms.example.com/api/v1/commerce/storefront/account/privacy";

let last: { url: string; init: RequestInit } | null = null;

function mockFetch(status: number, body: unknown): void {
  last = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    last = { url: String(url), init };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function installWindowStub(): void {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key)
    },
    dispatchEvent: () => true,
    addEventListener: () => {}
  };
}

const SESI: SesiAkun = {
  token: "cs_stub_9",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  account: {
    id: "acc-1",
    name: "Budi",
    email: "budi@example.test",
    phone: "+6281234567890",
    level: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    historyFrom: "2026-01-01T00:00:00.000Z",
    marketingConsent: false
  }
};

const headersOf = (): Record<string, string> => (last?.init.headers ?? {}) as Record<string, string>;

beforeEach(() => {
  process.env.PUBLIC_AWCMS_ORIGIN = "https://cms.example.com";
  installWindowStub();
  simpanSesi(SESI);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ORIGIN === undefined) delete process.env.PUBLIC_AWCMS_ORIGIN;
  else process.env.PUBLIC_AWCMS_ORIGIN = ORIGINAL_ORIGIN;
  (globalThis as { window?: unknown }).window = ORIGINAL_WINDOW;
});

describe("the privacy requests", () => {
  test("mintaKodePrivasi: POST privacy/otp with only the type, bearer and cors without credentials", async () => {
    mockFetch(200, { success: true, data: { sent: true, expiresInSeconds: 600 } });
    await mintaKodePrivasi("export");

    expect(last?.url).toBe(`${BASE}/otp`);
    expect(last?.init.method).toBe("POST");
    expect(last?.init.mode).toBe("cors");
    expect(last?.init.credentials).toBe("omit");
    expect(headersOf().Authorization).toBe("Bearer cs_stub_9");
    expect(JSON.parse(String(last?.init.body))).toEqual({ type: "export" });
  });

  test("eksporDataSaya: POST privacy/export with only the code, and no Idempotency-Key (the code is single use)", async () => {
    mockFetch(200, { success: true, data: { bundle: { version: 1 } } });
    const result = await eksporDataSaya("123456");

    expect(last?.url).toBe(`${BASE}/export`);
    expect(JSON.parse(String(last?.init.body))).toEqual({ code: "123456" });
    expect(headersOf()["Idempotency-Key"]).toBeUndefined();
    expect(result.bundle).toEqual({ version: 1 });
    expect(String(last?.init.body)).not.toContain("cs_stub_9");
  });

  test("hapusDataSaya: POST privacy/erasure with the code and the Idempotency-Key header", async () => {
    mockFetch(200, { success: true, data: { erased: true } });
    const key = "0123456789abcdef0123";
    await hapusDataSaya("654321", key);

    expect(last?.url).toBe(`${BASE}/erasure`);
    expect(last?.init.method).toBe("POST");
    expect(headersOf()["Idempotency-Key"]).toBe(key);
    expect(JSON.parse(String(last?.init.body))).toEqual({ code: "654321" });
  });

  test("a 401 clears the stored session, like every other bearer call", async () => {
    mockFetch(401, { success: false, error: { code: "UNAUTHENTICATED", message: "x" } });
    await expect(eksporDataSaya("123456")).rejects.toBeInstanceOf(TokoApiError);
    expect(bacaSesi()).toBeNull();
  });

  test("a call with no stored session fails before the network", async () => {
    (globalThis as { window?: unknown }).window = undefined;
    installWindowStub();
    mockFetch(200, {});
    await expect(mintaKodePrivasi("erasure")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(last).toBeNull();
  });

  test("a 409 ERASURE_REFUSED carries its refusals through to bacaPenolakan", async () => {
    mockFetch(409, {
      success: false,
      error: {
        code: "ERASURE_REFUSED",
        message: "m",
        details: { refusals: [{ code: "OPEN_ORDER", message: "x" }, { code: "BOGUS", message: "y" }] }
      }
    });
    let caught: unknown;
    try {
      await hapusDataSaya("654321", "0123456789abcdef0123");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TokoApiError);
    expect(bacaPenolakan(caught)).toEqual(["OPEN_ORDER"]);
    // A refusal is not a session problem: the session stays.
    expect(bacaSesi()).not.toBeNull();
  });
});
