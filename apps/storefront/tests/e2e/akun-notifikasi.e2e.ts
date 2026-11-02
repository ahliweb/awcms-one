/**
 * Browser-level coverage of customer Web Push on the storefront (issue #431,
 * ADR-0048 section 7; TS-E1, TS-E2, TS-E3, TS-E5), against a REAL built static
 * site (`global-setup.ts` builds with `PUBLIC_CUSTOMER_PUSH=1`) and the push half
 * of the stub CMS (`scripts/stub-push.mjs`).
 *
 * ## What is real and what is faked - read this before trusting a green run
 *
 * REAL: the built pages and scripts, the storefront server's headers (the worker
 * file, its `Cache-Control`, the CSP), every request to the stub CMS, the
 * stub's state machine, the DOM, focus, keyboard and axe.
 *
 * FAKED: the browser's push stack. A headless Chromium cannot reach FCM, so
 * `PushManager.subscribe` would fail; `installPushMock` replaces
 * `Notification`, `PushManager` and `navigator.serviceWorker` with a small
 * in-page implementation (state kept in `sessionStorage`, so it survives the
 * navigations a sign-out involves). What it proves is that the PAGE does the
 * right things in the right order with those APIs. What it CANNOT prove - a real
 * subscription reaching a real push service, a banner on a lock screen, the
 * worker's behaviour inside a real browser, iOS - is the physical-device UAT
 * (ADR-0048 D8), recorded in `docs/pengujian.md`; the worker's own logic is
 * unit-tested in `tests/push-pekerja.test.ts` by running its source.
 *
 * Browsers cannot run in the agent sandbox that wrote this file: it runs on the
 * trusted host with `bun run test:e2e` (and as part of `bun run ci:e2e`).
 *
 * Commerce-only: the settings page is a `toko` route, so the file skips cleanly
 * on a `berita` or `landing` run.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { isGroupActive } from "../../src/config/profil";
import { PUSH_MARKER_KEY, PUSH_SETTINGS_PATH, PUSH_WORKER_PATH } from "../../src/lib/push-konfig";
import { PREVIEW_PORT, STUB_PORT } from "./ports";

test.describe.configure({ mode: "serial" });
test.skip(!isGroupActive("toko"), "The push settings page is only built for the toko profile group.");

const PREVIEW = `http://localhost:${PREVIEW_PORT}`;
const STUB = `http://localhost:${STUB_PORT}`;
const API = `${STUB}/api/v1/commerce/storefront`;
const SESSION_KEY = "awcms-one:akun:v1";

type Sesi = { token: string; expiresAt: string; account: { id: string } & Record<string, unknown> };

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

async function pushControl(body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${STUB}/stub/push/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(response.ok).toBe(true);
}

async function api<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<{ status: number; data: T }> {
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      origin: PREVIEW,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {})
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as { data: T }) : { data: undefined as T };
  return { status: response.status, data: payload.data };
}

async function login(email = "budi@example.test"): Promise<Sesi> {
  await api("/account/otp/request", { method: "POST", body: { email, purpose: "login" } });
  const verified = await api<Sesi>("/account/otp/verify", { method: "POST", body: { email, code: "123456", purpose: "login" } });
  expect(verified.status).toBe(200);
  return verified.data;
}

let registered = 0;
async function register(): Promise<Sesi> {
  registered += 1;
  const email = `push-${Date.now()}-${registered}@example.test`;
  await api("/account/otp/request", { method: "POST", body: { email, purpose: "register", name: "Siti Pembeli", phone: `+62812000${String(registered).padStart(5, "0")}` } });
  const verified = await api<Sesi>("/account/otp/verify", { method: "POST", body: { email, code: "123456", purpose: "register" } });
  expect(verified.status).toBe(200);
  return verified.data;
}

type PushState = {
  devices: Array<{ id: string; current: boolean; endpointMasked: string }>;
  preferences: Array<{ purpose: string; enabled: boolean }>;
};

async function serverState(token: string): Promise<PushState> {
  const { data } = await api<PushState>("/account/push/subscriptions", { token });
  return data;
}

/**
 * Seeds the stored session ONCE per tab (a `sessionStorage` flag survives the
 * navigations of the tab): an init script that re-wrote it on every load would
 * resurrect a session the page just cleared, or overwrite the one a sign-in
 * just stored.
 */
async function signedIn(page: Page, sesi: Sesi): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      if (window.sessionStorage.getItem("__seeded")) return;
      window.sessionStorage.setItem("__seeded", "1");
      window.localStorage.setItem(key as string, value as string);
    },
    [SESSION_KEY, JSON.stringify(sesi)]
  );
}

// ---------------------------------------------------------------------------
// The in-page push stack
// ---------------------------------------------------------------------------

type MockOptions = {
  permission?: "default" | "granted" | "denied";
  /** What the prompt answers when the page asks. */
  answer?: "granted" | "denied" | "default";
  /** Pretend there is no Push API at all (a Safari tab, an embedded web view). */
  noPush?: boolean;
  /** iOS "launched from the Home Screen". */
  standalone?: boolean;
  subscribeFails?: boolean;
};

type MockLog = {
  permission: string;
  permissionRequests: number;
  subscribes: number;
  unsubscribes: number;
  registers: Array<{ url: string; scope: string }>;
  unregisters: number;
  subscription: null | { endpoint: string };
};

async function installPushMock(page: Page, options: MockOptions = {}): Promise<void> {
  await page.addInitScript((opts: MockOptions) => {
    const KEY = "__pushMock";
    const raw = window.sessionStorage.getItem(KEY);
    const state: any = raw
      ? JSON.parse(raw)
      : { permission: opts.permission ?? "default", permissionRequests: 0, subscribes: 0, unsubscribes: 0, registers: [], unregisters: 0, subscription: null, registered: false };
    const save = () => window.sessionStorage.setItem(KEY, JSON.stringify(state));
    save();

    if (opts.standalone) Object.defineProperty(navigator, "standalone", { value: true, configurable: true });

    class FakeNotification {
      static get permission() {
        return state.permission;
      }
      static requestPermission() {
        state.permissionRequests += 1;
        state.permission = opts.answer ?? "granted";
        save();
        return Promise.resolve(state.permission);
      }
    }
    (window as any).Notification = FakeNotification;

    if (opts.noPush) {
      delete (window as any).PushManager;
      Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true });
      return;
    }

    (window as any).PushManager = function PushManager() {};

    const bytes = (text: string) => new TextEncoder().encode(text).buffer;
    const makeSubscription = (applicationServerKey: Uint8Array) => ({
      endpoint: state.subscription.endpoint,
      options: { applicationServerKey },
      getKey: (name: string) => bytes(`${name}-${state.subscription.endpoint.slice(-6)}`),
      unsubscribe: () => {
        state.unsubscribes += 1;
        state.subscription = null;
        save();
        return Promise.resolve(true);
      }
    });
    let key: Uint8Array = new Uint8Array(65);
    const registration = {
      pushManager: {
        getSubscription: () => Promise.resolve(state.subscription ? makeSubscription(key) : null),
        subscribe: (o: { applicationServerKey: Uint8Array }) => {
          state.subscribes += 1;
          if (opts.subscribeFails) {
            save();
            return Promise.reject(Object.assign(new Error("Registration failed - push service error"), { name: "AbortError" }));
          }
          key = o.applicationServerKey;
          state.subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${state.subscribes}-${Date.now().toString(36)}` };
          save();
          return Promise.resolve(makeSubscription(key));
        }
      },
      unregister: () => {
        state.unregisters += 1;
        state.registered = false;
        save();
        return Promise.resolve(true);
      }
    };
    Object.defineProperty(navigator, "serviceWorker", {
      value: {
        register: (url: string, o: { scope: string }) => {
          state.registers.push({ url, scope: o.scope });
          state.registered = true;
          save();
          return Promise.resolve(registration);
        },
        getRegistration: () => Promise.resolve(state.registered ? registration : undefined),
        get ready() {
          return Promise.resolve(registration);
        }
      },
      configurable: true
    });
  }, options);
}

async function mockLog(page: Page): Promise<MockLog> {
  return page.evaluate(() => JSON.parse(window.sessionStorage.getItem("__pushMock") ?? "{}") as MockLog);
}

// ---------------------------------------------------------------------------
// Other helpers
// ---------------------------------------------------------------------------

async function scan(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `axe serious/critical on ${label}`).toEqual([]);
}

async function noOverflow360(page: Page, label: string): Promise<void> {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 800 });
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${label} at 360px overflows horizontally`).toBeLessThanOrEqual(innerWidth);
  if (original) await page.setViewportSize(original);
}

const CORS = (extra: Record<string, string> = {}) => ({
  "access-control-allow-origin": PREVIEW,
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-expose-headers": "retry-after",
  vary: "Origin",
  ...extra
});

/** Answers the page's push registration with `status`/`code` (and handles the CORS preflight). */
async function failRegistration(page: Page, status: number, code: string, headers: Record<string, string> = {}): Promise<void> {
  await page.route("**/account/push/subscriptions", async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS() });
    if (request.method() !== "POST") return route.continue();
    return route.fulfill({
      status,
      headers: CORS({ "content-type": "application/json", ...headers }),
      body: JSON.stringify({ success: false, error: { code, message: "English operator message" } })
    });
  });
}

const status = (page: Page) => page.locator("[data-notif-status]");
const panel = (page: Page, name: string) => page.locator(`[data-panel="${name}"]`);

async function chooseAndEnable(page: Page, purposes: string[] = ["order_updates"]): Promise<void> {
  for (const purpose of purposes) await page.locator(`#notif-tujuan-${purpose}`).check();
  await page.locator("[data-notif-aktifkan]").click();
}

test.beforeEach(async () => {
  await pushControl({ reset: true });
});

test.afterAll(async () => {
  await pushControl({ reset: true });
});

// ---------------------------------------------------------------------------
// The service worker file
// ---------------------------------------------------------------------------

test.describe("the worker file as the storefront server serves it", () => {
  test("a fixed first-party URL, revalidated every time, under the unchanged first-party CSP", async ({ request }) => {
    const response = await request.get(PUSH_WORKER_PATH);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("javascript");
    expect(response.headers()["cache-control"]).toBe("public, max-age=0, must-revalidate");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");

    const csp = response.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("worker-src"); // falls back to 'self'
    expect(csp).toMatch(/script-src 'self'(;|$)/); // no third-party script origin

    const body = await response.text();
    expect(body).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(body).not.toMatch(/Bearer|localStorage|cs_/);
  });
});

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

test.describe("the settings page by state", () => {
  test("signed out: asks to sign in, never prompts", async ({ page }) => {
    await installPushMock(page, { permission: "default" });
    await page.goto(PUSH_SETTINGS_PATH);
    await expect(panel(page, "tamu")).toBeVisible();
    await expect(page.locator("[data-notif-form]")).toBeHidden();
    expect((await mockLog(page)).permissionRequests).toBe(0);
  });

  test("the CMS flag off (the neutral 404): the control is hidden and the inbox is offered", async ({ page }) => {
    await pushControl({ mode: "off" });
    await signedIn(page, await login());
    await installPushMock(page);
    await page.goto(PUSH_SETTINGS_PATH);
    await expect(panel(page, "disembunyikan")).toBeVisible();
    await expect(page.locator("[data-notif-form]")).toBeHidden();
    await expect(panel(page, "perangkat")).toBeHidden();

    // ...and the /akun card stays hidden.
    await page.goto("/akun");
    await expect(page.locator("[data-account-view]")).toBeVisible();
    await expect(page.locator("[data-notif-kartu]")).toBeHidden();
  });

  for (const [mode, text] of [
    ["not_configured", "belum menyiapkan layanan notifikasi"],
    ["origin_not_supported", "tidak tersedia untuk alamat situs"]
  ] as const) {
    test(`capability disabled (${mode}) explains why and offers no opt-in`, async ({ page }) => {
      await pushControl({ mode });
      await signedIn(page, await login());
      await installPushMock(page);
      await page.goto(PUSH_SETTINGS_PATH);
      await expect(panel(page, "server_nonaktif")).toBeVisible();
      await expect(panel(page, "server_nonaktif")).toContainText(text);
      await expect(page.locator("[data-notif-form]")).toBeHidden();
    });
  }

  test("signed in, supported, permission default: the consent text, its version and three UNTICKED purposes - no prompt on load", async ({ page }) => {
    await signedIn(page, await login());
    await installPushMock(page, { permission: "default" });
    await page.goto(PUSH_SETTINGS_PATH);

    await expect(panel(page, "aktifkan")).toBeVisible();
    await expect(page.locator("[data-notif-versi]")).toHaveText("draft-2026-10");
    await expect(page.locator("[data-notif-teks]")).toContainText("Layar kunci hanya menampilkan teks umum");
    await expect(page.locator("[data-notif-teks]")).toContainText("tidak mengirim promosi");
    const boxes = page.locator("[data-notif-tujuan] input[type=checkbox]");
    await expect(boxes).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) await expect(boxes.nth(index)).not.toBeChecked();
    await expect(page.locator("[data-notif-aktifkan]")).toBeEnabled();

    expect((await mockLog(page)).permissionRequests).toBe(0);
    expect((await mockLog(page)).subscribes).toBe(0);
  });

  test("permission denied: how to re-enable in system settings (the page cannot), no prompt", async ({ page }) => {
    await signedIn(page, await login());
    await installPushMock(page, { permission: "denied" });
    await page.goto(PUSH_SETTINGS_PATH);
    await expect(panel(page, "izin_ditolak")).toBeVisible();
    await expect(panel(page, "izin_ditolak")).toContainText("tidak bisa mengubah izin");
    await expect(page.locator("[data-notif-form]")).toBeHidden();
    expect((await mockLog(page)).permissionRequests).toBe(0);
  });

  test("a browser without the Push API (an embedded web view): unsupported, inbox only", async ({ page }) => {
    await signedIn(page, await login());
    await installPushMock(page, { noPush: true });
    await page.goto(PUSH_SETTINGS_PATH);
    await expect(panel(page, "tidak_didukung")).toBeVisible();
    await expect(page.locator("[data-notif-form]")).toBeHidden();
  });
});

test.describe("iPhone", () => {
  test.use({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    hasTouch: true
  });

  test("a Safari tab (not installed) gets the Add to Home Screen guide for 16.4+ and no prompt", async ({ page }) => {
    await signedIn(page, await login());
    await installPushMock(page, { noPush: true, permission: "default" });
    await page.goto(PUSH_SETTINGS_PATH);

    await expect(panel(page, "ios_pasang")).toBeVisible();
    await expect(panel(page, "ios_pasang")).toContainText("16.4");
    await expect(panel(page, "ios_pasang")).toContainText("Tambahkan ke Layar Utama");
    await expect(page.locator("[data-notif-form]")).toBeHidden();
    expect((await mockLog(page)).permissionRequests).toBe(0);
    await scan(page, "the iOS install guide");
    await noOverflow360(page, "the iOS install guide");
  });

  test("the installed app (standalone) gets the opt-in, and enabling works end to end", async ({ page }) => {
    const sesi = await login();
    await signedIn(page, sesi);
    await installPushMock(page, { standalone: true, permission: "default" });
    await page.goto(PUSH_SETTINGS_PATH);

    await expect(panel(page, "aktifkan")).toBeVisible();
    await chooseAndEnable(page, ["order_updates", "payment_updates"]);
    await expect(panel(page, "aktif")).toBeVisible();
    expect((await serverState(sesi.token)).devices).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Turning on
// ---------------------------------------------------------------------------

test.describe("turning notifications on", () => {
  test("choosing nothing shows an error and asks the browser nothing (TS-E2)", async ({ page }) => {
    await signedIn(page, await login());
    await installPushMock(page, { permission: "default" });
    await page.goto(PUSH_SETTINGS_PATH);

    await page.locator("[data-notif-aktifkan]").click();
    await expect(page.locator("[data-notif-tujuan-galat]")).toHaveText("Pilih minimal satu jenis notifikasi.");
    await expect(page.locator("#notif-tujuan-order_updates")).toBeFocused();
    const log = await mockLog(page);
    expect(log.permissionRequests).toBe(0);
    expect(log.subscribes).toBe(0);
  });

  test("a click after choosing: ONE prompt, the worker at its fixed URL and scope, a subscription, the server device, and focus on the status", async ({ page }) => {
    const sesi = await login();
    await signedIn(page, sesi);
    await installPushMock(page, { permission: "default" });
    await page.goto(PUSH_SETTINGS_PATH);

    await chooseAndEnable(page, ["order_updates", "support_replies"]);

    await expect(panel(page, "aktif")).toBeVisible();
    await expect(status(page)).toHaveText("Notifikasi diaktifkan di perangkat ini.");
    await expect(status(page)).toBeFocused();

    const log = await mockLog(page);
    expect(log.permissionRequests).toBe(1);
    expect(log.subscribes).toBe(1);
    expect(log.registers).toEqual([{ url: PUSH_WORKER_PATH, scope: "/" }]);

    const server = await serverState(sesi.token);
    expect(server.devices).toHaveLength(1);
    expect(server.devices[0]!.current).toBe(true);
    expect(server.preferences.filter((p) => p.enabled).map((p) => p.purpose).sort()).toEqual(["order_updates", "support_replies"]);

    // The marker is the device id - and nothing secret.
    const marker = await page.evaluate((key) => window.localStorage.getItem(key), PUSH_MARKER_KEY);
    expect(JSON.parse(marker!)).toMatchObject({ deviceId: server.devices[0]!.id, accountId: sesi.account.id });
    expect(marker).not.toContain(sesi.token);
    expect(marker).not.toContain("fcm.googleapis.com");

    // The device is listed and marked.
    await expect(page.locator("[data-notif-perangkat] .akun-badge-utama")).toHaveText("Perangkat ini");
  });

  test("the whole flow is keyboard-operable", async ({ page }) => {
    await signedIn(page, await login());
    await installPushMock(page, { permission: "granted" });
    await page.goto(PUSH_SETTINGS_PATH);

    await page.locator("#notif-tujuan-payment_updates").focus();
    await page.keyboard.press("Space");
    await expect(page.locator("#notif-tujuan-payment_updates")).toBeChecked();
    await page.locator("[data-notif-aktifkan]").focus();
    await page.keyboard.press("Enter");
    await expect(panel(page, "aktif")).toBeVisible();
    // Granted already: no second prompt.
    expect((await mockLog(page)).permissionRequests).toBe(0);
  });

  test("the prompt answered 'denied' leaves nothing enrolled and says why", async ({ page }) => {
    const sesi = await login();
    await signedIn(page, sesi);
    await installPushMock(page, { permission: "default", answer: "denied" });
    await page.goto(PUSH_SETTINGS_PATH);

    await chooseAndEnable(page);
    await expect(page.locator("[data-notif-galat]")).toBeVisible();
    await expect(page.locator("[data-notif-galat-pesan]")).toContainText("Izin notifikasi tidak diberikan");
    expect((await serverState(sesi.token)).devices).toHaveLength(0);
    expect((await mockLog(page)).subscribes).toBe(0);
  });

  test("the browser's push service failing is reported and enrols nothing", async ({ page }) => {
    const sesi = await login();
    await signedIn(page, sesi);
    await installPushMock(page, { permission: "granted", subscribeFails: true });
    await page.goto(PUSH_SETTINGS_PATH);

    await chooseAndEnable(page);
    await expect(page.locator("[data-notif-galat-pesan]")).toContainText("tidak bisa dihubungi");
    await expect(page.locator("[data-notif-coba-lagi]")).toBeVisible();
    expect((await serverState(sesi.token)).devices).toHaveLength(0);
  });

  test("DEVICE_LIMIT: the new subscription is rolled back, the message says so and focus goes to the device list", async ({ page }) => {
    const sesi = await login();
    for (let index = 0; index < 5; index += 1) {
      const result = await api("/account/push/subscriptions", {
        method: "POST",
        token: sesi.token,
        body: {
          endpoint: `https://fcm.googleapis.com/fcm/send/other-${index}`,
          keys: { p256dh: "P", auth: "A" },
          consent: { purposes: ["order_updates"], textVersion: "draft-2026-10" }
        }
      });
      expect(result.status).toBe(201);
    }
    await signedIn(page, sesi);
    await installPushMock(page, { permission: "granted" });
    await page.goto(PUSH_SETTINGS_PATH);
    await expect(page.locator("[data-notif-perangkat] li")).toHaveCount(5);

    await chooseAndEnable(page);
    await expect(page.locator("[data-notif-galat-pesan]")).toContainText("Hapus salah satu perangkat");
    await expect(page.locator("#notif-perangkat-judul")).toBeFocused();

    const log = await mockLog(page);
    expect(log.subscribes).toBe(1);
    expect(log.unsubscribes).toBe(1); // rolled back
    expect(log.subscription).toBeNull();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), PUSH_MARKER_KEY)).toBeNull();
    expect((await serverState(sesi.token)).devices).toHaveLength(5);
  });

  const failures: Array<[string, number, string, Record<string, string>, string]> = [
    ["ENDPOINT_NOT_ALLOWED", 422, "ENDPOINT_NOT_ALLOWED", {}, "belum didukung"],
    ["ORIGIN_NOT_ALLOWED", 422, "ORIGIN_NOT_ALLOWED", {}, "alamat resmi toko"],
    ["PUSH_UNAVAILABLE", 409, "PUSH_UNAVAILABLE", {}, "sedang tidak tersedia"],
    ["ACCOUNT_BLOCKED", 403, "ACCOUNT_BLOCKED", {}, "diblokir"],
    ["ACCOUNT_NOT_VERIFIED", 403, "ACCOUNT_NOT_VERIFIED", {}, "Verifikasi alamat e-mail"],
    ["429 with Retry-After", 429, "RATE_LIMITED", { "retry-after": "42" }, "42 detik"],
    ["413", 413, "PAYLOAD_TOO_LARGE", {}, "Muat ulang halaman"],
    ["415", 415, "UNSUPPORTED_MEDIA_TYPE", {}, "Muat ulang halaman"]
  ];
  for (const [name, httpStatus, code, headers, text] of failures) {
    test(`${name}: a plain Indonesian message, never the server's English text, and the new subscription is rolled back`, async ({ page }) => {
      await signedIn(page, await login());
      await installPushMock(page, { permission: "granted" });
      await failRegistration(page, httpStatus, code, headers);
      await page.goto(PUSH_SETTINGS_PATH);

      await chooseAndEnable(page);
      await expect(page.locator("[data-notif-galat-pesan]")).toContainText(text);
      await expect(page.locator("[data-notif-galat-pesan]")).not.toContainText("English operator message");
      await expect(page.locator("[data-notif-galat]")).toBeFocused();
      expect((await mockLog(page)).subscription).toBeNull();
    });
  }

  test("a lost connection on registration offers a retry and enrols nothing", async ({ page }) => {
    await signedIn(page, await login());
    await installPushMock(page, { permission: "granted" });
    await page.route("**/account/push/subscriptions", (route) => {
      const method = route.request().method();
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS() });
      return method === "POST" ? route.abort("failed") : route.continue();
    });
    await page.goto(PUSH_SETTINGS_PATH);

    await chooseAndEnable(page);
    await expect(page.locator("[data-notif-galat-pesan]")).toContainText("Tidak bisa terhubung ke toko");
    await expect(page.locator("[data-notif-coba-lagi]")).toBeVisible();
    expect((await mockLog(page)).subscription).toBeNull();
  });

  test("a 401 on registration clears the session and offers to sign in again", async ({ page }) => {
    await signedIn(page, await login());
    await installPushMock(page, { permission: "granted" });
    await failRegistration(page, 401, "UNAUTHENTICATED");
    await page.goto(PUSH_SETTINGS_PATH);

    await chooseAndEnable(page);
    await expect(panel(page, "tamu")).toBeVisible();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Managing
// ---------------------------------------------------------------------------

test.describe("managing preferences and devices", () => {
  async function enrolled(page: Page): Promise<Sesi> {
    const sesi = await login();
    await signedIn(page, sesi);
    await installPushMock(page, { permission: "default" });
    await page.goto(PUSH_SETTINGS_PATH);
    await chooseAndEnable(page, ["order_updates"]);
    await expect(panel(page, "aktif")).toBeVisible();
    return sesi;
  }

  test("a purpose switch saves on change, announces it, and reverts when the save fails", async ({ page }) => {
    const sesi = await enrolled(page);

    await page.locator("#notif-pref-payment_updates").check();
    await expect(status(page)).toHaveText("Pembaruan pembayaran diaktifkan.");
    expect((await serverState(sesi.token)).preferences.find((p) => p.purpose === "payment_updates")?.enabled).toBe(true);

    await page.locator("#notif-pref-payment_updates").uncheck();
    await expect(status(page)).toHaveText("Pembaruan pembayaran dimatikan.");
    expect((await serverState(sesi.token)).preferences.find((p) => p.purpose === "payment_updates")?.enabled).toBe(false);

    await page.route("**/account/push/preferences", (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS() });
      return route.fulfill({
        status: 429,
        headers: CORS({ "content-type": "application/json", "retry-after": "30" }),
        body: JSON.stringify({ success: false, error: { code: "RATE_LIMITED", message: "x" } })
      });
    });
    await page.locator("#notif-pref-support_replies").check();
    await expect(page.locator("[data-notif-galat-pesan]")).toContainText("30 detik");
    await expect(page.locator("#notif-pref-support_replies")).not.toBeChecked();
  });

  test("turning THIS device off revokes it on the server and unsubscribes the browser", async ({ page }) => {
    const sesi = await enrolled(page);

    await page.locator("[data-notif-nonaktifkan]").click();
    await expect(panel(page, "aktifkan")).toBeVisible();
    await expect(status(page)).toHaveText("Notifikasi dimatikan di perangkat ini.");

    expect((await serverState(sesi.token)).devices).toHaveLength(0);
    const log = await mockLog(page);
    expect(log.unsubscribes).toBe(1);
    expect(log.unregisters).toBe(1);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), PUSH_MARKER_KEY)).toBeNull();
  });

  test("another device can be removed from the list without touching this browser", async ({ page }) => {
    const sesi = await enrolled(page);
    await api("/account/push/subscriptions", {
      method: "POST",
      token: (await login("budi@example.test")).token,
      body: {
        endpoint: "https://updates.push.services.mozilla.com/wpush/v2/other",
        keys: { p256dh: "P", auth: "A" },
        consent: { purposes: ["order_updates"], textVersion: "draft-2026-10" }
      }
    });
    await page.reload();
    await expect(page.locator("[data-notif-perangkat] li")).toHaveCount(2);

    const others = page.locator("[data-notif-perangkat] li", { hasNot: page.locator(".akun-badge-utama") });
    await others.getByRole("button", { name: /Hapus/ }).click();
    await expect(page.locator("[data-notif-perangkat] li")).toHaveCount(1);
    await expect(status(page)).toHaveText("Perangkat dihapus dari daftar notifikasi.");
    expect((await mockLog(page)).unsubscribes).toBe(0);
    expect((await serverState(sesi.token)).devices.some((d) => d.current)).toBe(true);
  });

  test("axe and 360px: the opt-in state and the active state", async ({ page }) => {
    const sesi = await login();
    await signedIn(page, sesi);
    await installPushMock(page, { permission: "default" });
    await page.goto(PUSH_SETTINGS_PATH);
    await expect(panel(page, "aktifkan")).toBeVisible();
    await scan(page, "the opt-in state");
    await noOverflow360(page, "the opt-in state");

    await chooseAndEnable(page, ["order_updates"]);
    await expect(panel(page, "aktif")).toBeVisible();
    await scan(page, "the active state");
    await noOverflow360(page, "the active state");
  });
});

// ---------------------------------------------------------------------------
// Sign-out and account switch (TS-E1)
// ---------------------------------------------------------------------------

test.describe("sign-out and account switch", () => {
  async function enrolledOnAccount(page: Page): Promise<{ sesi: Sesi; deviceId: string }> {
    const sesi = await login();
    await signedIn(page, sesi);
    await installPushMock(page, { permission: "default" });
    await page.goto(PUSH_SETTINGS_PATH);
    await chooseAndEnable(page, ["order_updates"]);
    await expect(panel(page, "aktif")).toBeVisible();
    const server = await serverState(sesi.token);
    return { sesi, deviceId: server.devices[0]!.id };
  }

  test("signing out revokes on the server BEFORE the session is cleared, then unsubscribes and forgets", async ({ page }) => {
    const { sesi } = await enrolledOnAccount(page);
    const seen: string[] = [];
    page.on("request", (request) => {
      if (/\/account\/(logout|push\/subscriptions)/.test(request.url()) && request.method() !== "OPTIONS") {
        seen.push(`${request.method()} ${new URL(request.url()).pathname.split("/account/")[1]}`);
      }
    });

    await page.goto("/akun");
    await page.locator("[data-keluar]").click();
    await expect(page.locator("[data-guest-view]")).toBeVisible();

    // The device DELETE precedes the logout POST.
    const revoke = seen.findIndex((entry) => entry.startsWith("DELETE push/subscriptions/"));
    const logout = seen.findIndex((entry) => entry === "POST logout");
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(logout).toBeGreaterThan(revoke);

    expect(await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY)).toBeNull();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), PUSH_MARKER_KEY)).toBeNull();
    const log = await mockLog(page);
    expect(log.subscription).toBeNull();
    expect(log.unsubscribes).toBe(1);

    // The old token is dead and the account has no device left.
    const again = await login();
    expect((await serverState(again.token)).devices).toHaveLength(0);
    expect((await api("/account/push/subscriptions", { token: sesi.token })).status).toBe(401);
  });

  test("a sign-out that cannot be confirmed clears NOTHING silently: it says so, offers retry, and keeps the subscription", async ({ page }) => {
    await enrolledOnAccount(page);
    await page.goto("/akun");

    let blocked = true;
    await page.route("**/account/logout", (route) => {
      if (route.request().method() === "OPTIONS") return route.continue();
      return blocked ? route.abort("failed") : route.continue();
    });

    await page.locator("[data-keluar]").click();
    await expect(page.locator("[data-keluar-gagal]")).toBeVisible();
    await expect(page.locator("[data-keluar-gagal]")).toContainText("belum bisa dikonfirmasi");
    await expect(page.locator("[data-keluar-gagal]")).toBeFocused();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY)).not.toBeNull();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), PUSH_MARKER_KEY)).not.toBeNull();
    expect((await mockLog(page)).unsubscribes).toBe(0);

    // Retry once the connection is back.
    blocked = false;
    await page.locator("[data-keluar-ulang]").click();
    await expect(page.locator("[data-guest-view]")).toBeVisible();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY)).toBeNull();
    expect((await mockLog(page)).unsubscribes).toBe(1);
  });

  test("'sign out on this device only' stops this browser receiving even though the server was never reached", async ({ page }) => {
    await enrolledOnAccount(page);
    await page.goto("/akun");
    await page.route("**/account/logout", (route) => (route.request().method() === "OPTIONS" ? route.continue() : route.abort("failed")));

    await page.locator("[data-keluar]").click();
    await expect(page.locator("[data-keluar-gagal]")).toBeVisible();
    await page.locator("[data-keluar-lokal]").click();

    await expect(page.locator("[data-guest-view]")).toBeVisible();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY)).toBeNull();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), PUSH_MARKER_KEY)).toBeNull();
    const log = await mockLog(page);
    expect(log.subscription).toBeNull();
    expect(log.unsubscribes).toBe(1);
  });

  test("signing in as ANOTHER account over a stored session logs the old one out first and leaves no inherited subscription", async ({ page }) => {
    const { sesi: first } = await enrolledOnAccount(page);
    const second = await register();

    await page.goto("/masuk");
    await page.locator("#masuk-email").fill(String((second.account as { email?: string }).email));
    await page.locator("[data-kirim-kode]").click();
    await page.locator("#masuk-code").fill("123456");
    await page.locator("[data-verifikasi]").click();
    await page.waitForURL(/\/akun$/);

    // The old session is dead on the server and its device is gone...
    expect((await api("/account/push/subscriptions", { token: first.token })).status).toBe(401);
    expect((await serverState((await login()).token)).devices).toHaveLength(0);
    // ...this browser holds no subscription and no marker, and the new account was NOT silently enrolled.
    const log = await mockLog(page);
    expect(log.subscription).toBeNull();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), PUSH_MARKER_KEY)).toBeNull();
    const stored = JSON.parse((await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY))!) as Sesi;
    expect(stored.account.id).not.toBe(first.account.id);
    expect((await serverState(stored.token)).devices).toHaveLength(0);

    // The settings page offers the opt-in again - one tap, never automatic.
    await page.goto(PUSH_SETTINGS_PATH);
    await expect(panel(page, "aktifkan")).toBeVisible();
    expect((await mockLog(page)).permissionRequests).toBe(1); // only the first account's original prompt
  });

  test("a session that ends by itself (a 401 elsewhere) makes the next page stop this browser receiving", async ({ page }) => {
    const { sesi } = await enrolledOnAccount(page);
    // The server ends the session; the next account call clears it locally.
    await api("/account/logout", { method: "POST", token: sesi.token });
    await page.goto("/akun");
    await expect(page.locator("[data-guest-view]")).toBeVisible();
    await expect.poll(async () => (await mockLog(page)).subscription).toBeNull();
    await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), PUSH_MARKER_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The /akun card
// ---------------------------------------------------------------------------

test.describe("the /akun card", () => {
  test("appears only when the CMS reports the capability, and links to the settings page", async ({ page }) => {
    await signedIn(page, await login());
    await installPushMock(page);
    await page.goto("/akun");
    await expect(page.locator("[data-notif-kartu]")).toBeVisible();
    await page.locator("[data-notif-kartu] a").click();
    await expect(page).toHaveURL(new RegExp(`${PUSH_SETTINGS_PATH}$`));
  });
});
