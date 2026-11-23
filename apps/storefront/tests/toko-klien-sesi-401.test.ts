/**
 * Issue #570: a 401 on the optional-bearer calls (`createOrder`,
 * `createGatewaySession`, `submitReview`) clears the stored session when, and
 * only when, a bearer was sent. Guest checkout (no bearer) is unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { simpanSesi } from "../src/lib/akun-sesi";
import type { SesiAkun } from "../src/lib/akun-kontrak";
import {
  createGatewaySession,
  createOrder,
  submitReview,
  TokoApiError,
  type CreateOrderRequest,
  type ReviewRequest
} from "../src/lib/toko-klien";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_WINDOW = (globalThis as { window?: unknown }).window;
const ORIGINAL_ORIGIN = process.env.PUBLIC_AWCMS_ORIGIN;
const KEY = "awcms-one:akun:v1";

function installWindowStub(): void {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key)
    },
    dispatchEvent: () => true,
    addEventListener: () => undefined
  };
}

function mockFetch(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

const unauthenticated = {
  success: false,
  error: { code: "UNAUTHENTICATED", message: "expired" }
};
const SESI: SesiAkun = {
  token: "cs_stub_1",
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

const ORDER = {} as CreateOrderRequest;
const REVIEW = {} as ReviewRequest;

const CALLS: Array<[string, (bearer?: string) => Promise<unknown>, unknown]> = [
  ["createOrder", (b) => createOrder(ORDER, b), { code: "O1" }],
  ["createGatewaySession", (b) => createGatewaySession("O1", "+6281", b), { redirectUrl: "https://pay.example" }],
  ["submitReview", (b) => submitReview(REVIEW, b), { id: "r1", status: "pending" }]
];

beforeEach(() => {
  process.env.PUBLIC_AWCMS_ORIGIN = "https://cms.example.com";
  installWindowStub();
  simpanSesi(SESI);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  (globalThis as { window?: unknown }).window = ORIGINAL_WINDOW;
  if (ORIGINAL_ORIGIN === undefined) delete process.env.PUBLIC_AWCMS_ORIGIN;
  else process.env.PUBLIC_AWCMS_ORIGIN = ORIGINAL_ORIGIN;
});

describe.each(CALLS)("%s", (_name, call, okData) => {
  test("bearer sent + 401 UNAUTHENTICATED clears the stored session and rethrows", async () => {
    mockFetch(401, unauthenticated);
    const error = await call(SESI.token).catch((e) => e);
    expect(error).toBeInstanceOf(TokoApiError);
    expect((error as TokoApiError).code).toBe("UNAUTHENTICATED");
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test("no bearer + 401 leaves the stored session untouched", async () => {
    mockFetch(401, unauthenticated);
    const error = await call(undefined).catch((e) => e);
    expect((error as TokoApiError).code).toBe("UNAUTHENTICATED");
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
  });

  test("bearer sent + another error code keeps the session", async () => {
    mockFetch(409, {
      success: false,
      error: { code: "CART_CHANGED", message: "x" }
    });
    await call(SESI.token).catch(() => undefined);
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
  });

  test("success is unchanged and keeps the session", async () => {
    mockFetch(200, { success: true, data: okData });
    expect(await call(SESI.token)).toEqual(okData);
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
  });
});
