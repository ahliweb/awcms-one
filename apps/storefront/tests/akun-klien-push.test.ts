/**
 * The customer Web Push calls of `src/lib/akun-klien.ts` (issue #431, ADR-0048
 * section 6.1): the REQUEST each builds (path, method, bearer, body), the 401
 * session rule, the neutral 404, and the `Retry-After` header folded into the
 * error. Same minimal `window` stand-in `akun-klien.test.ts` uses.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ambilStatusPush,
  cabutPerangkatPush,
  cabutSemuaPerangkatPush,
  daftarkanPerangkatPush,
  ubahPreferensiPush
} from "../src/lib/akun-klien";
import { bacaSesi, simpanSesi } from "../src/lib/akun-sesi";
import type { SesiAkun } from "../src/lib/akun-kontrak";
import { petakanGalat } from "../src/lib/push-pelanggan";
import { TokoApiError } from "../src/lib/toko-permintaan";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ORIGIN = process.env.PUBLIC_AWCMS_ORIGIN;
const ORIGINAL_WINDOW = (globalThis as { window?: unknown }).window;
const BASE = "https://cms.example.com/api/v1/commerce/storefront/account/push";

let last: { url: string; init: RequestInit } | null = null;

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}): void {
  last = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    last = { url: String(url), init };
    if (status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as unknown as typeof fetch;
}

function installWindowStub(): void {
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<(event: Event) => void>>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key)
    },
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    addEventListener: (type: string, listener: (event: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    }
  };
}

const SESI: SesiAkun = {
  token: "cs_stub_7",
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

describe("the push requests", () => {
  test("ambilStatusPush: GET subscriptions with the bearer, cors, no credentials, no body", async () => {
    mockFetch(200, { success: true, data: { capability: {}, preferences: [], devices: [] } });
    await ambilStatusPush();

    expect(last?.url).toBe(`${BASE}/subscriptions`);
    expect(last?.init.method).toBe("GET");
    expect(last?.init.mode).toBe("cors");
    expect(last?.init.credentials).toBe("omit");
    expect(headersOf().Authorization).toBe("Bearer cs_stub_7");
    expect(headersOf()["Content-Type"]).toBeUndefined();
    expect(last?.init.body).toBeUndefined();
  });

  test("daftarkanPerangkatPush: POST with exactly endpoint, keys, consent - the token is only in the header", async () => {
    mockFetch(201, { success: true, data: { device: {}, preferences: [] } });
    await daftarkanPerangkatPush({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: "P", auth: "A" },
      consent: { purposes: ["order_updates"], textVersion: "draft-2026-10" }
    });

    expect(last?.url).toBe(`${BASE}/subscriptions`);
    expect(last?.init.method).toBe("POST");
    expect(headersOf().Authorization).toBe("Bearer cs_stub_7");
    expect(headersOf()["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(last?.init.body));
    expect(Object.keys(body).sort()).toEqual(["consent", "endpoint", "keys"]);
    expect(String(last?.init.body)).not.toContain("cs_stub_7");
    expect(last?.url).not.toContain("cs_stub_7");
  });

  test("cabutPerangkatPush: DELETE subscriptions/{id}, the id percent-encoded", async () => {
    mockFetch(204, undefined);
    await cabutPerangkatPush("a/b c");
    expect(last?.url).toBe(`${BASE}/subscriptions/a%2Fb%20c`);
    expect(last?.init.method).toBe("DELETE");
    expect(headersOf().Authorization).toBe("Bearer cs_stub_7");
  });

  test("cabutSemuaPerangkatPush: DELETE subscriptions", async () => {
    mockFetch(204, undefined);
    await cabutSemuaPerangkatPush();
    expect(last?.url).toBe(`${BASE}/subscriptions`);
    expect(last?.init.method).toBe("DELETE");
  });

  test("ubahPreferensiPush: PUT preferences; turning on carries the text version, turning off carries none", async () => {
    mockFetch(200, { success: true, data: { preferences: [] } });
    await ubahPreferensiPush({ order_updates: true }, "draft-2026-10");
    expect(last?.url).toBe(`${BASE}/preferences`);
    expect(last?.init.method).toBe("PUT");
    expect(JSON.parse(String(last?.init.body))).toEqual({ purposes: { order_updates: true }, textVersion: "draft-2026-10" });

    await ubahPreferensiPush({ order_updates: false });
    expect(JSON.parse(String(last?.init.body))).toEqual({ purposes: { order_updates: false } });
  });

  test("with no stored session nothing is sent", async () => {
    window.localStorage.removeItem("awcms-one:akun:v1");
    mockFetch(200, { success: true, data: {} });
    await expect(ambilStatusPush()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(last).toBeNull();
  });
});

describe("the push errors", () => {
  test("401 clears the stored session and maps to 'sign in again'", async () => {
    mockFetch(401, { success: false, error: { code: "UNAUTHENTICATED", message: "x" } });
    let caught: unknown;
    await ambilStatusPush().catch((error) => (caught = error));
    expect(bacaSesi()).toBeNull();
    expect(petakanGalat(caught).tindakan).toBe("masuk_ulang");
  });

  test("the neutral 404 keeps the session and maps to 'hide the control'", async () => {
    mockFetch(404, { success: false, error: { code: "NOT_FOUND", message: "Not found." } });
    let caught: unknown;
    await ambilStatusPush().catch((error) => (caught = error));
    expect(bacaSesi()).not.toBeNull();
    expect(petakanGalat(caught).tindakan).toBe("sembunyikan");
  });

  test("a 429 with only a Retry-After header (the push routes' shape) carries the seconds", async () => {
    mockFetch(429, { success: false, error: { code: "RATE_LIMITED", message: "Too many requests." } }, { "retry-after": "42" });
    let caught: unknown;
    await daftarkanPerangkatPush({
      endpoint: "https://fcm.googleapis.com/x",
      keys: { p256dh: "P", auth: "A" },
      consent: { purposes: ["order_updates"], textVersion: "v" }
    }).catch((error) => (caught = error));

    expect(caught).toBeInstanceOf(TokoApiError);
    expect((caught as TokoApiError).retryAfterSeconds).toBe(42);
    expect(petakanGalat(caught).pesan).toContain("42 detik");
  });

  test("a 429 whose header the browser cannot read (not exposed by CORS) still maps to a retry with no wait", async () => {
    mockFetch(429, { success: false, error: { code: "RATE_LIMITED", message: "Too many requests." } });
    let caught: unknown;
    await ubahPreferensiPush({ order_updates: false }).catch((error) => (caught = error));
    expect((caught as TokoApiError).retryAfterSeconds).toBeNull();
    expect(petakanGalat(caught)).toMatchObject({ tindakan: "coba_lagi", tunggu: null });
  });

  test("a body that already has details.retryAfter is not overwritten by the header", async () => {
    mockFetch(
      429,
      { success: false, error: { code: "RATE_LIMITED", message: "x", details: { retryAfter: 5 } } },
      { "retry-after": "99" }
    );
    let caught: unknown;
    await ambilStatusPush().catch((error) => (caught = error));
    expect((caught as TokoApiError).retryAfterSeconds).toBe(5);
  });

  test("a non-numeric Retry-After is ignored", async () => {
    mockFetch(429, { success: false, error: { code: "RATE_LIMITED", message: "x" } }, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" });
    let caught: unknown;
    await ambilStatusPush().catch((error) => (caught = error));
    expect((caught as TokoApiError).retryAfterSeconds).toBeNull();
  });
});
