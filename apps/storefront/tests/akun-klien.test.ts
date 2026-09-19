/**
 * `src/lib/akun-klien.ts` — the customer-account cross-origin client (issue
 * #88). Every assertion here is about the REQUEST this file builds (path,
 * method, `mode`/`credentials`, headers, Bearer presence) and the session
 * side effect a `401 UNAUTHENTICATED` triggers — never about what a real CMS
 * answers (`scripts/stub-awcms.mjs`'s own state machine covers that).
 *
 * `src/lib/akun-sesi.ts` reads `window.localStorage`/`window.dispatchEvent`,
 * and Bun's test runtime has no `window` at all (`bun -e "typeof window"` is
 * `"undefined"`) — this file installs a minimal in-memory stand-in on
 * `globalThis.window` for the duration of these tests, the smallest fake
 * that makes `bacaSesi`/`simpanSesi`/`hapusSesi` behave exactly as they do
 * in a real browser, without pulling in a DOM library this app does not
 * otherwise depend on.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ambilPercakapan,
  ambilPercakapanById,
  ambilProfil,
  buatPercakapan,
  keluar,
  kirimPesanPercakapan,
  mintaKode,
  ubahProfil,
  verifikasiKode
} from "../src/lib/akun-klien";
import { simpanSesi, hapusSesi as hapusSesiSungguhan } from "../src/lib/akun-sesi";
import type { SesiAkun } from "../src/lib/akun-kontrak";
import { TokoApiError } from "../src/lib/toko-permintaan";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ORIGIN = process.env.PUBLIC_AWCMS_ORIGIN;
const ORIGINAL_WINDOW = (globalThis as { window?: unknown }).window;

let lastRequest: { url: string; init: RequestInit } | null = null;

function mockFetch(status: number, body: unknown): void {
  lastRequest = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    lastRequest = { url: String(url), init };
    if (status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

/** A minimal `window` stand-in: an in-memory `localStorage` and a `dispatchEvent` that actually notifies listeners registered via the same object — everything `akun-sesi.ts` touches. */
function installWindowStub(): void {
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<(event: Event) => void>>();

  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      }
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

  (globalThis as { window?: unknown }).window = fakeWindow;
}

const AKUN = {
  id: "acc-1",
  name: "Budi Santoso",
  email: "budi@example.test",
  phone: "+6281234567890",
  level: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  historyFrom: "2026-01-01T00:00:00.000Z",
  marketingConsent: false
};

const SESI_VALID: SesiAkun = {
  token: "cs_stub_1",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  account: AKUN
};

beforeEach(() => {
  process.env.PUBLIC_AWCMS_ORIGIN = "https://cms.example.com";
  installWindowStub();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ORIGIN === undefined) delete process.env.PUBLIC_AWCMS_ORIGIN;
  else process.env.PUBLIC_AWCMS_ORIGIN = ORIGINAL_ORIGIN;
  (globalThis as { window?: unknown }).window = ORIGINAL_WINDOW;
});

describe("akun-klien: anonymous endpoints", () => {
  test("mintaKode POSTs to /account/otp/request, cors + credentials omit, Content-Type only", async () => {
    mockFetch(202, { success: true, data: { sent: true, expiresInSeconds: 600 } });
    await mintaKode({ email: "budi@example.test", purpose: "login" });

    expect(lastRequest?.url).toBe("https://cms.example.com/api/v1/commerce/storefront/account/otp/request");
    expect(lastRequest?.init.method).toBe("POST");
    expect(lastRequest?.init.mode).toBe("cors");
    expect(lastRequest?.init.credentials).toBe("omit");
    expect(Object.keys(lastRequest?.init.headers as Record<string, string>)).toEqual(["Content-Type"]);
  });

  test("verifikasiKode POSTs to /account/otp/verify with no Authorization header", async () => {
    mockFetch(200, { success: true, data: { token: "cs_stub_1", expiresAt: SESI_VALID.expiresAt, account: AKUN } });
    await verifikasiKode({ email: "budi@example.test", code: "123456", purpose: "login" });

    expect(lastRequest?.url).toBe("https://cms.example.com/api/v1/commerce/storefront/account/otp/verify");
    expect(Object.keys(lastRequest?.init.headers as Record<string, string>)).toEqual(["Content-Type"]);
  });
});

describe("akun-klien: bearer endpoints", () => {
  test("ambilProfil sends Authorization: Bearer <token> from the stored session, GET, no Content-Type", async () => {
    simpanSesi(SESI_VALID);
    mockFetch(200, { success: true, data: { account: AKUN } });

    await ambilProfil();

    expect(lastRequest?.url).toBe("https://cms.example.com/api/v1/commerce/storefront/account/me");
    expect(lastRequest?.init.method).toBe("GET");
    const headers = lastRequest?.init.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer cs_stub_1");
    expect(headers?.["Content-Type"]).toBeUndefined();
  });

  test("ubahProfil PATCHes with both Authorization and Content-Type", async () => {
    simpanSesi(SESI_VALID);
    mockFetch(200, { success: true, data: { account: { ...AKUN, name: "Budi S." } } });

    await ubahProfil({ name: "Budi S." });

    expect(lastRequest?.init.method).toBe("PATCH");
    const headers = lastRequest?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cs_stub_1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(lastRequest?.init.body))).toEqual({ name: "Budi S." });
  });

  test("calling a bearer endpoint with no session throws UNAUTHENTICATED before any fetch", async () => {
    hapusSesiSungguhan();
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    await expect(ambilProfil()).rejects.toThrow(TokoApiError);
    expect(fetchCalled).toBe(false);
  });

  test("a 401 UNAUTHENTICATED from the CMS clears the local session before rethrowing", async () => {
    simpanSesi(SESI_VALID);
    mockFetch(401, { success: false, error: { code: "UNAUTHENTICATED", message: "Sesi tidak valid." } });

    await expect(ambilProfil()).rejects.toThrow(TokoApiError);

    // The session is gone — a second call now fails BEFORE any fetch, the
    // same "no session" path the test above exercises directly.
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await expect(ambilProfil()).rejects.toThrow(TokoApiError);
    expect(fetchCalled).toBe(false);
  });

  test("keluar POSTs to /account/logout with Authorization and no body", async () => {
    simpanSesi(SESI_VALID);
    mockFetch(204, undefined);

    await keluar();

    expect(lastRequest?.url).toBe("https://cms.example.com/api/v1/commerce/storefront/account/logout");
    expect(lastRequest?.init.method).toBe("POST");
    expect(lastRequest?.init.body).toBeUndefined();
    const headers = lastRequest?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cs_stub_1");
  });

  test("ubahProfil PATCHes marketingConsent alone, without name", async () => {
    simpanSesi(SESI_VALID);
    mockFetch(200, { success: true, data: { account: { ...AKUN, marketingConsent: true } } });

    const { account } = await ubahProfil({ marketingConsent: true });

    expect(JSON.parse(String(lastRequest?.init.body))).toEqual({ marketingConsent: true });
    expect(account.marketingConsent).toBe(true);
  });
});

describe("akun-klien: issue #115 — via/phone OTP channel", () => {
  test("mintaKode sends via:\"whatsapp\" and phone (no email) for the WhatsApp login path", async () => {
    mockFetch(202, { success: true, data: { sent: true, expiresInSeconds: 600 } });
    await mintaKode({ phone: "+6281234567890", purpose: "login", via: "whatsapp" });

    expect(lastRequest?.url).toBe("https://cms.example.com/api/v1/commerce/storefront/account/otp/request");
    const sentBody = JSON.parse(String(lastRequest?.init.body));
    expect(sentBody).toEqual({ phone: "+6281234567890", purpose: "login", via: "whatsapp" });
  });

  test("mintaKode omits via for a plain e-mail request (server defaults to email)", async () => {
    mockFetch(202, { success: true, data: { sent: true, expiresInSeconds: 600 } });
    await mintaKode({ email: "budi@example.test", purpose: "login" });

    const sentBody = JSON.parse(String(lastRequest?.init.body));
    expect(sentBody.via).toBeUndefined();
    expect(sentBody.phone).toBeUndefined();
  });

  test("verifikasiKode sends phone (no email) for the WhatsApp login path", async () => {
    mockFetch(200, { success: true, data: { token: "cs_stub_1", expiresAt: SESI_VALID.expiresAt, account: AKUN } });
    await verifikasiKode({ phone: "+6281234567890", code: "123456", purpose: "login" });

    const sentBody = JSON.parse(String(lastRequest?.init.body));
    expect(sentBody).toEqual({ phone: "+6281234567890", code: "123456", purpose: "login" });
  });

  test("a 409 CHANNEL_UNAVAILABLE from mintaKode surfaces as an ordinary TokoApiError", async () => {
    mockFetch(409, {
      success: false,
      error: { code: "CHANNEL_UNAVAILABLE", message: "Kode via WhatsApp sedang tidak tersedia di toko ini." }
    });

    await expect(mintaKode({ phone: "+6281234567890", purpose: "login", via: "whatsapp" })).rejects.toMatchObject({
      code: "CHANNEL_UNAVAILABLE"
    });
  });
});

describe("akun-klien: issue #115 — conversations", () => {
  const PERCAKAPAN = {
    id: "conv-1",
    subject: "Pertanyaan",
    status: "open" as const,
    lastMessageAt: "2026-02-01T00:00:00.000Z",
    unreadForCustomer: 1
  };

  test("ambilPercakapan GETs /account/conversations with Authorization, no Content-Type", async () => {
    simpanSesi(SESI_VALID);
    mockFetch(200, { success: true, data: { items: [PERCAKAPAN], nextCursor: null } });

    const page = await ambilPercakapan();

    expect(lastRequest?.url).toBe("https://cms.example.com/api/v1/commerce/storefront/account/conversations");
    expect(lastRequest?.init.method).toBe("GET");
    const headers = lastRequest?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cs_stub_1");
    expect(headers["Content-Type"]).toBeUndefined();
    expect(page.items).toEqual([PERCAKAPAN]);
  });

  test("ambilPercakapan appends ?cursor= when given one", async () => {
    simpanSesi(SESI_VALID);
    mockFetch(200, { success: true, data: { items: [], nextCursor: null } });

    await ambilPercakapan("conv-1");

    expect(lastRequest?.url).toBe(
      "https://cms.example.com/api/v1/commerce/storefront/account/conversations?cursor=conv-1"
    );
  });

  test("buatPercakapan POSTs {subject, body} and returns {conversation, message}", async () => {
    simpanSesi(SESI_VALID);
    const message = { id: "msg-1", sender: "customer" as const, body: "Halo", createdAt: "2026-02-01T00:00:00.000Z" };
    mockFetch(201, { success: true, data: { conversation: PERCAKAPAN, message } });

    const result = await buatPercakapan({ subject: "Pertanyaan", body: "Halo" });

    expect(lastRequest?.init.method).toBe("POST");
    expect(JSON.parse(String(lastRequest?.init.body))).toEqual({ subject: "Pertanyaan", body: "Halo" });
    expect(result.conversation).toEqual(PERCAKAPAN);
    expect(result.message).toEqual(message);
  });

  test("ambilPercakapanById GETs /account/conversations/{id}", async () => {
    simpanSesi(SESI_VALID);
    mockFetch(200, { success: true, data: { conversation: PERCAKAPAN, messages: [] } });

    await ambilPercakapanById("conv-1");

    expect(lastRequest?.url).toBe(
      "https://cms.example.com/api/v1/commerce/storefront/account/conversations/conv-1"
    );
    expect(lastRequest?.init.method).toBe("GET");
  });

  test("kirimPesanPercakapan POSTs {body} to /account/conversations/{id}/messages", async () => {
    simpanSesi(SESI_VALID);
    const message = { id: "msg-2", sender: "customer" as const, body: "Balasan", createdAt: "2026-02-01T00:00:00.000Z" };
    mockFetch(201, { success: true, data: { message } });

    const result = await kirimPesanPercakapan("conv-1", "Balasan");

    expect(lastRequest?.url).toBe(
      "https://cms.example.com/api/v1/commerce/storefront/account/conversations/conv-1/messages"
    );
    expect(JSON.parse(String(lastRequest?.init.body))).toEqual({ body: "Balasan" });
    expect(result.message).toEqual(message);
  });

  test("a 409 CONVERSATION_CLOSED from kirimPesanPercakapan surfaces as an ordinary TokoApiError", async () => {
    simpanSesi(SESI_VALID);
    mockFetch(409, {
      success: false,
      error: { code: "CONVERSATION_CLOSED", message: "Percakapan ini telah ditutup." }
    });

    await expect(kirimPesanPercakapan("conv-1", "Balasan")).rejects.toMatchObject({
      code: "CONVERSATION_CLOSED"
    });
  });

  test("a 401 UNAUTHENTICATED from any conversations call clears the local session", async () => {
    simpanSesi(SESI_VALID);
    mockFetch(401, { success: false, error: { code: "UNAUTHENTICATED", message: "Sesi tidak valid." } });

    await expect(ambilPercakapan()).rejects.toThrow(TokoApiError);

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await expect(ambilPercakapan()).rejects.toThrow(TokoApiError);
    expect(fetchCalled).toBe(false);
  });
});
