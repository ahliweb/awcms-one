/**
 * Browser-level coverage of the `toko` booking pages (issue #386, ADR-0045,
 * `docs/booking-ux-flows.md` sections 2, 3, 6 and 7), against a REAL built
 * static site (`global-setup.ts`) and the booking half of the stub CMS
 * (`scripts/stub-booking.mjs`): search and availability with a server quote,
 * the signed-out detour through `/masuk`, the hold with its countdown, payment
 * handoff, the hold-expired states (the local clock reaching zero, and the
 * server expiring a hold under a live page), the shopper's own reservations,
 * the feature switched off, and the refusals (a lost race, the live-hold
 * ceiling, a retry that must reuse its Idempotency-Key).
 *
 * Every state that carries content is also scanned with axe (WCAG 2.1 A/AA,
 * serious and critical fail) and measured for horizontal overflow at 360px -
 * the generic key-page specs only see a page's static shell.
 *
 * Commerce-only: the pages are `toko` group routes, so this file skips cleanly
 * on a `berita` or `landing` run (which build neither the pages nor the
 * booking endpoints).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { isGroupActive } from "../../src/config/profil";
import booking from "../fixtures/awcms/booking.json";
import { PREVIEW_PORT, STUB_PORT } from "./ports";

test.describe.configure({ mode: "serial" });
test.skip(!isGroupActive("toko"), "The booking pages are only built for the toko profile group.");

const PREVIEW = `http://localhost:${PREVIEW_PORT}`;
const STUB = `http://localhost:${STUB_PORT}`;
const API = `${STUB}/api/v1/commerce/storefront`;
const SESSION_KEY = "awcms-one:akun:v1";
const [R1, R2] = booking.resourceIds as [string, string];
const OFFERING = booking.offering.offeringId;
const RUPIAH = (digits: string) => new RegExp(`Rp[\\s\\u00a0]?${digits.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

/** Days from today (UTC, as the stub counts them) as `YYYY-MM-DD`. */
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

type Sesi = { token: string; expiresAt: string; account: Record<string, unknown> };

async function stubControl(body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${STUB}/stub/booking/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(response.ok).toBe(true);
}

async function api<T>(path: string, init: { method?: string; body?: unknown; token?: string; key?: string } = {}): Promise<{ status: number; data: T }> {
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      origin: PREVIEW,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.key ? { "idempotency-key": init.key } : {})
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const payload = (await response.json()) as { data: T };
  return { status: response.status, data: payload.data };
}

/** A real OTP login against the stub, returning the session the storefront would have stored. */
async function login(email = "budi@example.test"): Promise<Sesi> {
  await api("/account/otp/request", { method: "POST", body: { email, purpose: "login" } });
  const verified = await api<Sesi>("/account/otp/verify", { method: "POST", body: { email, code: "123456", purpose: "login" } });
  expect(verified.status).toBe(200);
  return verified.data;
}

/** A second, freshly registered account (its list must be empty while Budi's is not). */
async function register(email: string, name: string, phone: string): Promise<Sesi> {
  await api("/account/otp/request", { method: "POST", body: { email, purpose: "register", name, phone } });
  const verified = await api<Sesi>("/account/otp/verify", { method: "POST", body: { email, code: "123456", purpose: "register" } });
  expect(verified.status).toBe(200);
  return verified.data;
}

async function signedIn(page: Page, sesi: Sesi): Promise<void> {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [SESSION_KEY, JSON.stringify(sesi)]
  );
}

async function scan(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    `axe serious/critical on ${label}`
  ).toEqual([]);
}

async function noOverflow360(page: Page, label: string): Promise<void> {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 800 });
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect(scrollWidth, `${label} at 360px overflows horizontally`).toBeLessThanOrEqual(innerWidth);
  if (original) await page.setViewportSize(original);
}

const stayQuery = (from: number, to: number, resource = R1) =>
  `?o=${OFFERING}&r=${resource}&in=${day(from)}&out=${day(to)}&n=2`;

test.beforeEach(async () => {
  await stubControl({ reset: true });
});

test.afterAll(async () => {
  await stubControl({ reset: true });
});

test.describe("search and availability (/booking)", () => {
  test("a free range shows the SERVER's nights, price, total, deposit and balance; a date change clears the old figures at once", async ({ page }) => {
    await page.goto("/booking");
    await expect(page.locator("[data-booking-form]")).toBeVisible();
    await expect(page.locator("[data-offering-select] option")).toHaveCount(1);
    await expect(page.locator("#booking-layanan")).toContainText("Kamar Deluxe Tepi Sungai");
    // Nothing is computed before the dates exist, and "Lanjut" is disabled.
    await expect(page.locator("[data-continue]")).toBeDisabled();

    await page.locator("#booking-masuk").fill(day(5));
    await page.locator("#booking-keluar").fill(day(7));
    await expect(page.locator("[data-quote-list]")).toBeVisible();
    await expect(page.locator("[data-quote-stay]")).toContainText("2 malam");
    await expect(page.locator("[data-quote-unit]")).toHaveText(RUPIAH("450.000"));
    await expect(page.locator("[data-quote-total]")).toHaveText(RUPIAH("900.000"));
    await expect(page.locator("[data-quote-deposit]")).toHaveText(RUPIAH("270.000"));
    await expect(page.locator("[data-quote-balance]")).toHaveText(RUPIAH("630.000"));
    await expect(page.locator("[data-quote-note]")).toContainText("Poin tidak dapat dipakai bersama uang muka");
    await expect(page.locator("[data-timezone-hint]")).toContainText("Zona waktu properti: WIB");
    await expect(page.locator("[data-continue]")).toBeEnabled();
    await scan(page, "/booking with a quote");
    await noOverflow360(page, "/booking with a quote");

    // Three nights: the old figures are removed immediately, then the server's new ones appear.
    await page.locator("#booking-keluar").fill(day(8));
    await expect(page.locator("[data-quote-list]")).toBeHidden();
    await expect(page.locator("[data-continue]")).toBeDisabled();
    await expect(page.locator("[data-quote-stay]")).toContainText("3 malam");
    await expect(page.locator("[data-quote-total]")).toHaveText(RUPIAH("1.350.000"));
  });

  test("the first resource being blocked does not make the stay unavailable: the next free resource is offered", async ({ page }) => {
    const blocked = booking.firstResourceBlockedOffsetDays;
    await page.goto(`/booking${stayQuery(blocked, blocked + 2, R1).replace(`r=${R1}&`, "")}`);
    await expect(page.locator("[data-quote-list]")).toBeVisible();
    const sesi = await login();
    await signedIn(page, sesi);
    await page.reload();
    await expect(page.locator("[data-continue]")).toBeEnabled();
    await page.locator("[data-continue]").click();
    await expect(page).toHaveURL(new RegExp(`/booking/pesan\\?.*r=${R2}`));
  });

  test("a full range says 'Penuh' in text and leaves 'Lanjut' disabled; it is never an empty success", async ({ page }) => {
    const full = booking.fullOffsetDays;
    await page.goto(`/booking?o=${OFFERING}&in=${day(full)}&out=${day(full + 1)}&n=2`);
    await expect(page.locator("[data-full]")).toBeVisible();
    await expect(page.locator("[data-full]")).toContainText("Penuh");
    await expect(page.locator("[data-full]")).toContainText("Tidak ada kamar kosong untuk tanggal ini. Coba tanggal lain.");
    await expect(page.locator("[data-quote-list]")).toBeHidden();
    await expect(page.locator("[data-continue]")).toBeDisabled();
    await scan(page, "/booking full");
  });

  test("an impossible range is an inline error tied to its field, in the words of the spec", async ({ page }) => {
    await page.goto("/booking");
    await page.locator("#booking-masuk").fill(day(6));
    await page.locator("#booking-keluar").fill(day(6));
    const error = page.locator('[data-error-for="checkOutDate"]');
    await expect(error).toHaveText("Tanggal keluar harus setelah tanggal masuk.");
    await expect(page.locator("#booking-keluar")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#booking-keluar")).toHaveAttribute("aria-describedby", /booking-keluar-galat/);
    await expect(page.locator("[data-continue]")).toBeDisabled();
  });

  test("signed out, 'Lanjut' goes through /masuk and, after a real OTP sign-in, returns to the same stay", async ({ page }) => {
    await page.goto(`/booking?o=${OFFERING}&in=${day(10)}&out=${day(12)}&n=2`);
    await expect(page.locator("[data-continue]")).toBeEnabled();
    await page.locator("[data-continue]").click();
    await expect(page).toHaveURL(/\/masuk\?kembali=/);
    expect(decodeURIComponent(new URL(page.url()).searchParams.get("kembali") ?? "")).toContain(`/booking/pesan?o=${OFFERING}`);

    await page.locator("#masuk-email").fill("budi@example.test");
    await page.locator("[data-kirim-kode]").click();
    await page.locator("#masuk-code").fill("123456");
    await page.locator("[data-verifikasi]").click();
    await page.waitForURL(/\/booking\/pesan\?/);
    await expect(page.locator('[data-view="form"]')).toBeVisible();
    await expect(page.locator("[data-sum-stay]")).toContainText("2 malam");
    expect(new URL(page.url()).searchParams.get("in")).toBe(day(10));
  });

  test("with the booking feature off the page says so instead of showing a broken form", async ({ page }) => {
    await stubControl({ featureOff: true });
    await page.goto("/booking");
    await expect(page.locator("[data-unavailable]")).toBeVisible();
    await expect(page.locator("[data-unavailable]")).toContainText("Pemesanan tidak tersedia");
    await expect(page.locator("[data-booking-form]")).toBeHidden();

    const sesi = await login();
    await signedIn(page, sesi);
    await page.goto(`/booking/pesan${stayQuery(5, 7)}`);
    await expect(page.locator('[data-view="tidak-tersedia"]')).toBeVisible();
  });
});

test.describe("the hold (/booking/pesan)", () => {
  test("the form shows the server quote; holding it starts a countdown from the server's clock, announced at thresholds and never per tick; a reload recovers the hold", async ({ page }) => {
    const sesi = await login();
    await signedIn(page, sesi);
    await page.goto(`/booking/pesan${stayQuery(5, 7)}`);

    await expect(page.locator('[data-view="form"]')).toBeVisible();
    await expect(page.locator("[data-sum-stay]")).toContainText("2 malam");
    await expect(page.locator("[data-sum-total]")).toHaveText(RUPIAH("900.000"));
    await expect(page.locator("[data-guest-line]")).toContainText("Budi Santoso");
    await expect(page.locator('input[name="payment.method"]')).toHaveCount(4);
    await page.getByLabel(/Uang muka/).check();
    await expect(page.locator("[data-points-note]")).toBeVisible();
    await scan(page, "/booking/pesan form");
    await noOverflow360(page, "/booking/pesan form");

    await page.locator("[data-submit]").click();
    await expect(page.locator('[data-view="tahan"]')).toBeVisible();
    await expect(page.locator("[data-hold-heading]")).toBeFocused();

    const countdown = page.locator("[data-countdown]");
    await expect(countdown).toContainText("Kamar ditahan untuk Anda selama 14:");
    // The ticking digits are not in a live region: neither the element nor an ancestor announces.
    expect(
      await countdown.evaluate((el) => !!el.closest('[aria-live], [role="status"], [role="alert"]'))
    ).toBe(false);
    await expect(page.locator("[data-announce]")).toHaveText("Kamar ditahan selama 15 menit.");

    // The remaining time decreases on its own clock.
    const first = await countdown.innerText();
    await page.waitForTimeout(2200);
    expect(await countdown.innerText()).not.toBe(first);

    await expect(page.locator("[data-hold-total]")).toHaveText(RUPIAH("900.000"));
    await expect(page.locator("[data-hold-deposit-label]")).toHaveText("Uang muka yang harus dibayar sekarang");
    await expect(page.locator("[data-hold-deposit]")).toHaveText(RUPIAH("270.000"));
    await expect(page.locator("[data-hold-balance]")).toHaveText(RUPIAH("630.000"));
    await expect(page.locator("[data-hold-order]")).not.toBeEmpty();
    await scan(page, "/booking/pesan hold");
    await noOverflow360(page, "/booking/pesan hold");

    // A reload of the same stay recovers THIS hold instead of offering a second one.
    const order = await page.locator("[data-hold-order]").innerText();
    await page.reload();
    await expect(page.locator('[data-view="tahan"]')).toBeVisible();
    await expect(page.locator("[data-hold-order]")).toHaveText(order);
    const { data } = await api<{ items: unknown[] }>("/booking/reservations", { token: sesi.token });
    expect(data.items).toHaveLength(1);
  });

  test("a hold that runs out on the page ends in the expired state, announced as an alert, with the same dates prefilled to start again", async ({ page }) => {
    await stubControl({ holdSeconds: 3 });
    const sesi = await login();
    await signedIn(page, sesi);
    await page.goto(`/booking/pesan${stayQuery(6, 8)}`);
    await page.getByLabel(/Transfer bank/).check();
    await page.locator("[data-submit]").click();
    await expect(page.locator('[data-view="tahan"]')).toBeVisible();

    await expect(page.locator('[data-view="habis"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-expired-heading]")).toBeFocused();
    await expect(page.locator("[data-expired-text]")).toHaveText("Waktu penahanan habis. Kamar dilepas. Pilih tanggal lagi.");
    await expect(page.locator("[data-announce-urgent]")).toContainText("Waktu penahanan habis");
    await expect(page.locator('[data-view="form"]')).toBeHidden();
    await scan(page, "/booking/pesan expired");

    await page.locator("[data-restart]").click();
    await expect(page).toHaveURL(/\/booking\?/);
    await expect(page.locator("#booking-masuk")).toHaveValue(day(6));
    await expect(page.locator("#booking-keluar")).toHaveValue(day(8));
    await expect(page.locator("[data-quote-total]")).toHaveText(RUPIAH("900.000"));
  });

  test("the SERVER is authoritative: a hold it expired under a live page becomes the expired state when the page regains the network", async ({ page }) => {
    const sesi = await login();
    await signedIn(page, sesi);
    await page.goto(`/booking/pesan${stayQuery(7, 9)}`);
    await page.getByLabel(/QRIS/).check();
    await page.locator("[data-submit]").click();
    await expect(page.locator('[data-view="tahan"]')).toBeVisible();
    await expect(page.locator("[data-countdown]")).toContainText("14:");

    await stubControl({ expireAll: true });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator('[data-view="habis"]')).toBeVisible();
  });

  test("a gateway payment confirms the reservation: the page shows the server's confirmation, and the list shows it paid", async ({ page }) => {
    const sesi = await login();
    await signedIn(page, sesi);
    await page.goto(`/booking/pesan${stayQuery(8, 10)}`);
    await page.getByLabel(/Bayar penuh sekarang \(online\)/).check();
    await page.locator("[data-submit]").click();
    await expect(page.locator('[data-view="tahan"]')).toBeVisible();
    await expect(page.locator("[data-hold-deposit-label]")).toHaveText("Bayar penuh sekarang");
    await expect(page.locator("[data-pay]")).toHaveText("Bayar sekarang");
    await page.locator("[data-pay]").click();

    // The stub's own hosted page: pay, then it returns to the order tracking page.
    await page.waitForURL(/\/stub\/gateway\//);
    await page.getByRole("button", { name: /Bayar \(simulasi\)/ }).click();
    await page.waitForURL(/\/pesanan\?kode=/);

    await page.goto(`/booking/pesan${stayQuery(8, 10)}`);
    await expect(page.locator('[data-view="berhasil"]')).toBeVisible();
    await expect(page.locator("[data-success-text]")).toHaveText("Pembayaran diterima. Reservasi Anda terkonfirmasi.");
    await expect(page.locator("[data-success-heading]")).toBeFocused();

    await page.goto("/akun/reservasi");
    const row = page.locator("[data-list] li").first();
    await expect(row).toContainText("Terkonfirmasi");
    await expect(row).toContainText("Lunas");
  });

  test("a deposit goes through the gateway as a deposit session; the confirmation names the balance still due", async ({ page }) => {
    const sesi = await login();
    await signedIn(page, sesi);
    await page.goto(`/booking/pesan${stayQuery(11, 13)}`);
    await page.getByLabel(/Uang muka/).check();
    await page.locator("[data-submit]").click();
    await expect(page.locator("[data-pay]")).toHaveText("Bayar uang muka sekarang");
    await page.locator("[data-pay]").click();
    await page.waitForURL(/\/stub\/gateway\//);
    await page.getByRole("button", { name: /Bayar \(simulasi\)/ }).click();
    await page.waitForURL(/\/pesanan\?kode=/);

    await page.goto(`/booking/pesan${stayQuery(11, 13)}`);
    await expect(page.locator('[data-view="berhasil"]')).toBeVisible();
    await expect(page.locator("[data-success-text]")).toContainText("Uang muka diterima. Reservasi Anda terkonfirmasi.");
    await expect(page.locator("[data-success-text]")).toContainText(RUPIAH("630.000"));

    await page.goto("/akun/reservasi");
    await expect(page.locator("[data-list] li").first()).toContainText("Uang muka dibayar, sisa");
    await scan(page, "/akun/reservasi confirmed");
  });

  test("losing the race for the room is told plainly, the form keeps its place, and the way back keeps the dates", async ({ page }) => {
    const sesi = await login();
    await signedIn(page, sesi);
    await page.goto(`/booking/pesan${stayQuery(14, 16)}`);
    await expect(page.locator('[data-view="form"]')).toBeVisible();

    // Another guest takes the same room first.
    const taken = await api("/booking/reservations", {
      method: "POST",
      key: "rival-1",
      body: {
        offeringId: OFFERING,
        resourceId: R1,
        stay: { checkInDate: day(14), checkOutDate: day(16) },
        partySize: 1,
        guest: { name: "Tamu Lain", phone: "081200000001" },
        payment: { method: "manual_bank" }
      }
    });
    expect(taken.status).toBe(201);

    await page.locator("[data-submit]").click();
    const error = page.locator("[data-submit-error]");
    await expect(error).toBeVisible();
    await expect(error).toContainText("Maaf, kamar untuk tanggal ini baru saja terisi. Silakan pilih tanggal lain.");
    await expect(error).toBeFocused();
    await expect(page.locator('[data-view="form"]')).toBeVisible();
    await expect(page.locator("[data-error-change-dates]")).toHaveAttribute("href", new RegExp(`in=${day(14)}`));
    // No raw code is ever shown.
    await expect(error).not.toContainText("SLOT_UNAVAILABLE");
    await scan(page, "/booking/pesan refusal");
  });

  test("a retry after a dropped connection reuses the same Idempotency-Key and creates ONE reservation", async ({ page }) => {
    const sesi = await login();
    await signedIn(page, sesi);
    const keys: string[] = [];
    let attempts = 0;
    await page.route("**/booking/reservations", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      attempts += 1;
      if (attempts === 1) return route.abort("connectionreset");
      return route.continue();
    });
    await page.goto(`/booking/pesan${stayQuery(17, 19)}`);
    await page.getByLabel(/Transfer bank/).check();
    await page.locator("[data-submit]").click();
    await expect(page.locator("[data-submit-error]")).toContainText("Terjadi gangguan. Coba lagi.");
    await page.locator("[data-submit]").click();
    await expect(page.locator('[data-view="tahan"]')).toBeVisible();

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    const { data } = await api<{ items: unknown[] }>("/booking/reservations", { token: sesi.token });
    expect(data.items).toHaveLength(1);
  });

  test("the live-hold ceiling is a calm 'try again later', not a stack or a code", async ({ page }) => {
    const sesi = await login();
    for (let index = 0; index < booking.maxLiveHolds; index += 1) {
      const made = await api("/booking/reservations", {
        method: "POST",
        token: sesi.token,
        key: `fill-${index}`,
        body: {
          offeringId: OFFERING,
          resourceId: R1,
          stay: { checkInDate: day(22 + index * 3), checkOutDate: day(23 + index * 3) },
          partySize: 1,
          payment: { method: "manual_bank" }
        }
      });
      expect(made.status).toBe(201);
    }
    await signedIn(page, sesi);
    await page.goto(`/booking/pesan${stayQuery(30, 31)}`);
    await page.getByLabel(/Transfer bank/).check();
    await page.locator("[data-submit]").click();
    await expect(page.locator("[data-submit-error]")).toContainText("Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.");
    await expect(page.locator("[data-submit-error]")).not.toContainText("HOLD_LIMIT_EXCEEDED");
  });

  test("with no stay in the address, or no session, the page says what to do instead of showing a form", async ({ page }) => {
    await page.goto("/booking/pesan");
    await expect(page.locator('[data-view="kosong"]')).toBeVisible();
    await expect(page.locator('[data-view="kosong"]')).toContainText("Tidak ada pemesanan yang sedang berjalan.");
    await scan(page, "/booking/pesan empty");

    await page.goto(`/booking/pesan${stayQuery(5, 7)}`);
    await expect(page.locator('[data-view="masuk"]')).toBeVisible();
    await expect(page.locator("[data-login-link]")).toHaveAttribute("href", /\/masuk\?kembali=%2Fbooking%2Fpesan/);
    await scan(page, "/booking/pesan signed out");
  });
});

test.describe("own reservations (/akun/reservasi)", () => {
  async function hold(sesi: Sesi, from: number, to: number, method = "manual_bank", key = `own-${from}`) {
    const made = await api<{ orderCode: string }>("/booking/reservations", {
      method: "POST",
      token: sesi.token,
      key,
      body: {
        offeringId: OFFERING,
        resourceId: R1,
        stay: { checkInDate: day(from), checkOutDate: day(to) },
        partySize: 2,
        payment: { method }
      }
    });
    expect(made.status).toBe(201);
    return made.data.orderCode;
  }

  test("signed out it asks for a sign-in; with a dead token the session is cleared on the 401", async ({ page }) => {
    await page.goto("/akun/reservasi");
    await expect(page.locator("[data-guest-view]")).toBeVisible();

    await signedIn(page, {
      token: "cs_stub_dead",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      account: {
        id: "acc-x",
        name: "X",
        email: "x@example.test",
        phone: "+6281200000000",
        level: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        historyFrom: "2026-01-01T00:00:00.000Z",
        marketingConsent: false
      }
    });
    await page.goto("/akun/reservasi");
    await expect(page.locator("[data-guest-view]")).toBeVisible();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY)).toBeNull();
  });

  test("it lists only the signed-in shopper's reservations, newest first, with the server's status, payment state and balance", async ({ page }) => {
    const budi = await login();
    const older = await hold(budi, 40 - 30, 40 - 28, "dp", "older");
    const newer = await hold(budi, 12, 15, "manual_qris", "newer");

    await signedIn(page, budi);
    await page.goto("/akun/reservasi");
    const rows = page.locator("[data-list] li");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(newer);
    await expect(rows.nth(1)).toContainText(older);

    const first = rows.first();
    await expect(first).toContainText("Kamar Deluxe Tepi Sungai");
    await expect(first).toContainText("3 malam");
    await expect(first).toContainText("Menunggu pembayaran uang muka");
    await expect(first).toContainText("Menunggu pembayaran");
    await expect(first).toContainText(RUPIAH("1.350.000"));
    await expect(first.locator("[data-hold-left]")).toContainText("Kamar ditahan, sisa waktu");
    // The countdown text is plain: it sits in no live region.
    expect(await first.locator("[data-hold-left]").evaluate((el) => !!el.closest('[aria-live], [role="status"], [role="alert"]'))).toBe(false);
    await expect(first.getByRole("link", { name: "Detail pesanan" })).toHaveAttribute("href", new RegExp(`/akun/pesanan\\?kode=${newer}`));
    // A deposit order offers to pay the deposit; a manual one offers no gateway button.
    await expect(rows.nth(1).getByRole("button", { name: "Bayar uang muka" })).toBeVisible();
    await expect(first.getByRole("button")).toHaveCount(0);
    await scan(page, "/akun/reservasi list");
    await noOverflow360(page, "/akun/reservasi list");

    // Another account sees none of it.
    const siti = await register("siti.booking@example.test", "Siti Rahma", "081299990001");
    const other = await browserPage(page, siti);
    await other.goto("/akun/reservasi");
    await expect(other.locator("[data-empty]")).toBeVisible();
    await expect(other.locator("[data-empty]")).toContainText("Anda belum punya reservasi.");
    await expect(other.locator("[data-list] li")).toHaveCount(0);
    await other.context().close();
  });

  test("a hold the server expires moves from 'Menunggu' to 'Penahanan habis' on the page without a reload", async ({ page }) => {
    const budi = await login();
    await hold(budi, 9, 11);
    await signedIn(page, budi);
    await page.goto("/akun/reservasi");
    await expect(page.locator("[data-list] li").first()).toContainText("Menunggu pembayaran uang muka");

    await stubControl({ expireAll: true });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator("[data-list] li").first()).toContainText("Penahanan habis", { timeout: 15_000 });
    await expect(page.locator("[data-announce]")).toContainText("Penahanan habis");
    await expect(page.locator("[data-list] li").first().locator("[data-hold-left]")).toHaveCount(0);
  });
});

/** A second browser context holding another account's session (same built site). */
async function browserPage(page: Page, sesi: Sesi): Promise<Page> {
  const context = await page.context().browser()!.newContext({ baseURL: PREVIEW });
  const other = await context.newPage();
  await signedIn(other, sesi);
  return other;
}
