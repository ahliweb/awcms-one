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
 * Issue #387 adds the reservation detail with its deposit state and the cancellation
 * and refund view (`/akun/reservasi?kode=`): the refund the SERVER quotes is what the
 * dialog shows, the quote is asked for again on confirm, a changed figure is shown
 * and re-confirmed instead of acted on, the refusals (409, 422, 429, a dropped
 * connection) read in the words of the UX spec, and the dialog is keyboard-complete.
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
    await expect(first.getByRole("link", { name: "Detail reservasi" })).toHaveAttribute("href", new RegExp(`/akun/reservasi\\?kode=${newer}`));
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


// ---------------------------------------------------------------------------
// Issue #387 - the reservation detail (Surface B) and the cancellation (Surface C)
// ---------------------------------------------------------------------------

test.describe("reservation detail and cancellation (/akun/reservasi?kode=)", () => {
  /** A held reservation of 2 nights starting `from` days out (so the stub's policy windows pick the refund share). */
  async function hold(sesi: Sesi, from: number, method = "dp", key = `det-${from}-${method}`): Promise<string> {
    const made = await api<{ orderCode: string }>("/booking/reservations", {
      method: "POST",
      token: sesi.token,
      key,
      body: {
        offeringId: OFFERING,
        resourceId: R1,
        stay: { checkInDate: day(from), checkOutDate: day(from + 2) },
        partySize: 2,
        payment: { method }
      }
    });
    expect(made.status).toBe(201);
    return made.data.orderCode;
  }

  /** The deposit through the stub's own gateway page, the way the provider would confirm it. */
  async function payDeposit(sesi: Sesi, orderCode: string): Promise<void> {
    const session = await api<{ redirectUrl: string }>(`/orders/${orderCode}/payment-gateway/sessions`, {
      method: "POST",
      token: sesi.token,
      body: { purpose: "deposit" }
    });
    expect(session.status).toBe(201);
    const paid = await fetch(`${session.data.redirectUrl}/pay`, { method: "POST", redirect: "manual" });
    expect(paid.status).toBe(302);
  }

  async function confirmed(sesi: Sesi, from: number, key?: string): Promise<string> {
    const code = await hold(sesi, from, "dp", key);
    await payDeposit(sesi, code);
    return code;
  }

  async function open(page: Page, sesi: Sesi, code: string): Promise<void> {
    await signedIn(page, sesi);
    await page.goto(`/akun/reservasi?kode=${code}`);
    await expect(page.locator("[data-detail]")).toBeVisible();
  }

  const dialog = (page: Page) => page.locator("[data-cancel-dialog]");

  async function openDialog(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Batalkan reservasi" }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator("[data-cancel-dl]")).toBeVisible();
  }

  type Seen = { quoteGets: number; cancelPosts: { body: unknown; key: string | null }[] };
  function watch(page: Page): Seen {
    const seen: Seen = { quoteGets: 0, cancelPosts: [] };
    page.on("request", (request) => {
      const url = request.url();
      if (request.method() === "GET" && url.includes("/cancellation-quote")) seen.quoteGets += 1;
      if (request.method() === "POST" && url.endsWith("/cancel")) {
        seen.cancelPosts.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] ?? null });
      }
    });
    return seen;
  }

  async function reservation(sesi: Sesi, code: string) {
    const got = await api<{ status: string; refund: { finalRefund: string; adjusted: boolean } | null }>(`/booking/reservations/${code}`, { token: sesi.token });
    return got.data;
  }

  test("the order view shows the deposit state from the server's figures, and follows a payment without a reload", async ({ page }) => {
    const budi = await login();
    const code = await hold(budi, 9, "dp", "view-1");
    await signedIn(page, budi);
    await page.goto("/akun/reservasi");
    await page.locator("[data-list] li").first().getByRole("link", { name: "Detail reservasi" }).click();
    await expect(page.locator("[data-detail]")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/akun/reservasi\\?kode=${code}`));

    await expect(page.locator("[data-detail-heading]")).toHaveText("Kamar Deluxe Tepi Sungai");
    await expect(page.locator("[data-detail-stay]")).toContainText("2 malam");
    await expect(page.locator("[data-detail-pills]")).toContainText("Menunggu pembayaran uang muka");
    const money = page.locator("[data-detail-money]");
    await expect(money.locator('[data-row="total"]')).toContainText(RUPIAH("900.000"));
    await expect(money.locator('[data-row="uangMuka"] dt')).toHaveText("Uang muka yang harus dibayar sekarang");
    await expect(money.locator('[data-row="uangMuka"] dd')).toContainText(RUPIAH("270.000"));
    await expect(money.locator('[data-row="dibayar"] dd')).toContainText(RUPIAH("0"));
    await expect(money.locator('[data-row="sisa"] dd')).toContainText(RUPIAH("900.000"));
    await expect(page.getByRole("button", { name: "Bayar uang muka" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Batalkan reservasi" })).toBeVisible();
    // The ticking hold is plain text, in no live region.
    await expect(page.locator("[data-detail-hold]")).toContainText("Kamar ditahan, sisa waktu");
    expect(await page.locator("[data-detail-hold]").evaluate((el) => !!el.closest('[aria-live], [role="status"], [role="alert"]'))).toBe(false);
    // Nothing in the view offers a security deposit or a points control on a deposit order.
    await expect(page.locator("[data-detail]")).not.toContainText(/jaminan/i);
    await scan(page, "/akun/reservasi?kode= (held, deposit due)");
    await noOverflow360(page, "/akun/reservasi?kode= (held)");

    // The provider confirms the deposit elsewhere; coming back to the tab re-reads the server.
    await payDeposit(budi, code);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator("[data-detail-pills]")).toContainText("Terkonfirmasi", { timeout: 15_000 });
    await expect(page.locator("[data-announce]")).toContainText("Terkonfirmasi");
    await expect(page.locator("[data-detail-pills]")).toContainText("Uang muka dibayar, sisa");
    await expect(money.locator('[data-row="uangMuka"] dt')).toHaveText("Uang muka");
    await expect(money.locator('[data-row="dibayar"] dd')).toContainText(RUPIAH("270.000"));
    await expect(money.locator('[data-row="sisa"] dd')).toContainText(RUPIAH("630.000"));
    await expect(page.locator("[data-detail-payment-note]")).toContainText("Uang muka diterima. Reservasi Anda terkonfirmasi.");
    await expect(page.locator("[data-detail-payment-note]")).toContainText(RUPIAH("630.000"));
    await expect(page.locator("[data-detail-hold]")).toBeHidden();
    // The balance is paid through the same tender, and the pay-the-deposit button is gone.
    await expect(page.getByRole("button", { name: "Bayar sisa pembayaran" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Bayar uang muka" })).toHaveCount(0);
    await scan(page, "/akun/reservasi?kode= (confirmed, balance due)");
  });

  test("an order paid in full says 'Bayar penuh' and 'Lunas'; an unknown, foreign or malformed code is the one neutral not-found", async ({ page }) => {
    const budi = await login();
    const code = await hold(budi, 9, "gateway", "full-1");
    const session = await api<{ redirectUrl: string }>(`/orders/${code}/payment-gateway/sessions`, { method: "POST", token: budi.token, body: {} });
    await fetch(`${session.data.redirectUrl}/pay`, { method: "POST", redirect: "manual" });
    await open(page, budi, code);
    await expect(page.locator('[data-row="pembayaran"] dd')).toHaveText("Bayar penuh");
    await expect(page.locator('[data-row="uangMuka"]')).toHaveCount(0);
    await expect(page.locator('[data-row="sisa"] dd')).toHaveText("Lunas");
    await expect(page.locator("[data-detail-pills]")).toContainText("Lunas");

    // Not-found is neutral and the same for all three.
    const siti = await register("siti.detail@example.test", "Siti Detail", "081299990002");
    const stranger = await browserPage(page, siti);
    for (const path of [`/akun/reservasi?kode=${code}`, "/akun/reservasi?kode=NOPE-0000-0000", "/akun/reservasi?kode=a%20b"]) {
      const target = path.includes("a%20b") || path.includes("NOPE") ? page : stranger;
      await target.goto(path);
      await expect(target.locator("[data-detail-notfound]")).toBeVisible();
      await expect(target.locator("[data-detail-notfound]")).toContainText("Pemesanan tidak ditemukan.");
      await expect(target.locator("[data-detail]")).toBeHidden();
    }
    await scan(stranger, "/akun/reservasi?kode= (not found)");
    await stranger.context().close();
  });

  test("signed out the detail asks for a sign-in; a dead token clears the session on the 401", async ({ page }) => {
    await page.goto("/akun/reservasi?kode=BJM-0000-0001");
    await expect(page.locator("[data-guest-view]")).toBeVisible();
    await expect(page.locator("[data-detail]")).toBeHidden();

    await signedIn(page, {
      token: "cs_stub_dead",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      account: { id: "acc-x", name: "X", email: "x@example.test", phone: "+6281200000000", level: 1, createdAt: "2026-01-01T00:00:00.000Z", historyFrom: "2026-01-01T00:00:00.000Z", marketingConsent: false }
    });
    await page.goto("/akun/reservasi?kode=BJM-0000-0001");
    await expect(page.locator("[data-guest-view]")).toBeVisible();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY)).toBeNull();
  });

  test("the dialog shows the SERVER's quote before anything is cancelled, and Escape closes it without cancelling and returns focus to the opener", async ({ page }) => {
    const budi = await login();
    const code = await confirmed(budi, 4);
    const seen = watch(page);
    await open(page, budi, code);

    const opener = page.getByRole("button", { name: "Batalkan reservasi" });
    await opener.click();
    await expect(dialog(page)).toBeVisible();
    // The safe choice holds the focus; the confirm button waits for the quote.
    await expect(page.getByRole("button", { name: "Tidak, tetap pesan" })).toBeFocused();
    await expect(page.locator("[data-cancel-dl]")).toBeVisible();
    await expect(page.locator("[data-cancel-confirm]")).toBeEnabled();
    await expect(dialog(page)).toHaveAttribute("aria-labelledby", "batal-judul");
    await expect(page.locator("#batal-judul")).toHaveText("Batalkan reservasi ini?");

    // Every figure is the server's own quote.
    const quote = await api<{ amountPaid: string; computedRefund: string; refundablePercent: string }>(`/booking/reservations/${code}/cancellation-quote`, { token: budi.token });
    expect(quote.data).toMatchObject({ amountPaid: "270000.00", computedRefund: "135000.00", refundablePercent: "50.00" });
    const dl = page.locator("[data-cancel-dl]");
    await expect(dl).toContainText("Sudah dibayar");
    await expect(dl).toContainText(RUPIAH("270.000"));
    await expect(dl).toContainText("Dana yang dikembalikan");
    await expect(dl).toContainText(RUPIAH("135.000"));
    await expect(dl).toContainText("Ditahan sesuai kebijakan");
    await expect(dl).toContainText("dana kembali 50%");
    await expect(dl).toContainText("Dikembalikan ke metode pembayaran asal");
    await expect(page.locator("[data-cancel-confirm]")).toHaveText("Ya, batalkan dan ajukan pengembalian");

    await scan(page, "cancellation dialog (quote shown)");
    // The dialog fits the 360px viewport and the page does not scroll sideways under it.
    await page.setViewportSize({ width: 360, height: 800 });
    const box = await dialog(page).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });

    // Tab never lands on the page behind the modal (it may leave the document for the browser chrome, which reads as `body`);
    // Escape closes it, cancels nothing, and focus returns to the opener.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest("dialog"))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await expect(opener).toBeFocused();
    expect(seen.cancelPosts).toHaveLength(0);
    expect((await reservation(budi, code)).status).toBe("confirmed");

    // "Tidak, tetap pesan" does the same.
    await opener.click();
    await expect(page.locator("[data-cancel-dl]")).toBeVisible();
    await page.getByRole("button", { name: "Tidak, tetap pesan" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(opener).toBeFocused();
    expect((await reservation(budi, code)).status).toBe("confirmed");
  });

  test("confirming asks the server for the quote AGAIN, sends only the figure it saw with one Idempotency-Key, and shows the recorded refund", async ({ page }) => {
    const budi = await login();
    const code = await confirmed(budi, 4);
    const seen = watch(page);
    await open(page, budi, code);
    await openDialog(page);
    expect(seen.quoteGets).toBe(1);

    await page.locator("[data-cancel-confirm]").click();
    await expect(dialog(page)).toBeHidden();
    // Re-fetched on confirm: the second GET happened before the one POST.
    expect(seen.quoteGets).toBe(2);
    expect(seen.cancelPosts).toHaveLength(1);
    expect(seen.cancelPosts[0].body).toEqual({ acknowledgedRefund: "135000.00" });
    expect(seen.cancelPosts[0].key).toMatch(/\S{8,}/);

    // The confirmation: polite status region, focus on its heading, the recorded figure.
    const result = page.locator("[data-detail-result]");
    await expect(result).toContainText("Reservasi dibatalkan");
    await expect(result).toContainText(`Pengembalian dana ${"Rp"}`);
    await expect(result).toContainText(RUPIAH("135.000"));
    await expect(result.getByRole("heading", { name: "Reservasi dibatalkan" })).toBeFocused();
    await expect(page.locator("[data-detail-pills]")).toContainText("Dibatalkan");
    await expect(page.locator("[data-detail-refund]")).toContainText("sedang diproses");
    await expect(page.locator("[data-detail-refund]")).toContainText(RUPIAH("135.000"));
    await expect(page.getByRole("button", { name: "Batalkan reservasi" })).toHaveCount(0);
    await expect(page.locator("[data-detail-cancel-reason]")).toHaveText("Reservasi ini sudah dibatalkan.");
    await expect(page.locator('[data-row="sisa"]')).toHaveCount(0);
    const recorded = await reservation(budi, code);
    expect(recorded).toMatchObject({ status: "cancelled", refund: { finalRefund: "135000.00" } });
    await scan(page, "/akun/reservasi?kode= (cancelled, refund processing)");

    // Once the ledger shows the refund returned, the line says so.
    await stubControl({ settleRefund: true });
    await page.reload();
    await expect(page.locator("[data-detail-refund]")).toContainText("selesai");
    await expect(page.locator("[data-detail-pills]")).toContainText("Dikembalikan sebagian");
    await expect(page.locator('[data-row="dikembalikan"] dd')).toContainText(RUPIAH("135.000"));
  });

  test("a figure that changed while the dialog was open is shown and re-confirmed - nothing is cancelled against a number the shopper did not see", async ({ page }) => {
    const budi = await login();
    const code = await confirmed(budi, 4);
    const seen = watch(page);
    await open(page, budi, code);
    await openDialog(page);
    await expect(page.locator("[data-cancel-dl]")).toContainText(RUPIAH("135.000"));

    // The policy window moves under the open dialog.
    await stubControl({ percentOverride: 0 });
    await page.locator("[data-cancel-confirm]").click();

    await expect(page.locator("[data-cancel-status]")).toContainText("Jumlah pengembalian dana berubah. Tidak ada yang dibatalkan.");
    await expect(page.locator("[data-cancel-dl]")).toContainText("Dana yang dikembalikan");
    await expect(page.locator("[data-cancel-dl]")).not.toContainText(RUPIAH("135.000"));
    await expect(page.locator("[data-cancel-confirm]")).toHaveText("Ya, batalkan tanpa pengembalian");
    await expect(page.locator("[data-cancel-retained]")).toContainText(RUPIAH("270.000"));
    await expect(dialog(page)).toBeVisible();
    expect(seen.cancelPosts).toHaveLength(0);
    expect((await reservation(budi, code)).status).toBe("confirmed");
    await scan(page, "cancellation dialog (changed figure)");

    // A fresh confirmation acts on the NEW figure, with a key of its own.
    await page.locator("[data-cancel-confirm]").click();
    await expect(dialog(page)).toBeHidden();
    expect(seen.cancelPosts).toHaveLength(1);
    expect(seen.cancelPosts[0].body).toEqual({ acknowledgedRefund: "0.00" });
    await expect(page.locator("[data-detail-result]")).toContainText("Tidak ada pengembalian dana.");
    await expect(page.locator("[data-detail-refund]")).toContainText("Tidak ada pengembalian dana.");
  });

  test("when the SERVER refuses the acknowledged figure (409 QUOTE_CHANGED) nothing is cancelled and the dialog shows the new figure for a fresh confirmation", async ({ page }) => {
    const budi = await login();
    const code = await confirmed(budi, 4);
    const seen = watch(page);
    await open(page, budi, code);
    await openDialog(page);

    // The confirm-time quote still says 50%; the stub then moves the window before the cancel is processed.
    await stubControl({ driftAfterQuote: 0 });
    await page.locator("[data-cancel-confirm]").click();
    await expect(page.locator("[data-cancel-error]")).toContainText("Jumlah pengembalian dana berubah. Tidak ada yang dibatalkan.");
    await expect(page.locator("[data-cancel-dl]")).not.toContainText(RUPIAH("135.000"));
    await expect(page.locator("[data-cancel-confirm]")).toHaveText("Ya, batalkan tanpa pengembalian");
    await expect(page.locator("[data-cancel-confirm]")).toBeEnabled();
    expect(seen.cancelPosts).toHaveLength(1);
    expect(seen.cancelPosts[0].body).toEqual({ acknowledgedRefund: "135000.00" });
    expect((await reservation(budi, code)).status).toBe("confirmed");

    await page.locator("[data-cancel-confirm]").click();
    await expect(dialog(page)).toBeHidden();
    expect(seen.cancelPosts).toHaveLength(2);
    expect(seen.cancelPosts[1].body).toEqual({ acknowledgedRefund: "0.00" });
    // A new figure takes a new Idempotency-Key.
    expect(seen.cancelPosts[1].key).not.toBe(seen.cancelPosts[0].key);
    expect((await reservation(budi, code)).status).toBe("cancelled");
  });

  test("a zero refund says so before confirming; a hold with nothing paid cancels plainly", async ({ page }) => {
    const budi = await login();
    const near = await confirmed(budi, 1);
    await open(page, budi, near);
    await openDialog(page);
    await expect(page.locator("[data-cancel-dl]")).toContainText("dana kembali 0%");
    await expect(page.locator("[data-cancel-retained]")).toHaveText(/Tidak ada pengembalian: .*270\.000 ditahan sesuai kebijakan/);
    await expect(page.locator("[data-cancel-confirm]")).toHaveText("Ya, batalkan tanpa pengembalian");
    await page.getByRole("button", { name: "Tidak, tetap pesan" }).click();

    const unpaid = await hold(budi, 14, "dp", "unpaid-1");
    await page.goto(`/akun/reservasi?kode=${unpaid}`);
    await expect(page.locator("[data-detail]")).toBeVisible();
    await openDialog(page);
    await expect(page.locator("[data-cancel-confirm]")).toHaveText("Ya, batalkan reservasi");
    await expect(page.locator("[data-cancel-retained]")).toBeHidden();
    await page.locator("[data-cancel-confirm]").click();
    await expect(page.locator("[data-detail-result]")).toContainText("Reservasi dibatalkan. Tidak ada pengembalian dana.");
  });

  test("no resolved policy: the spec's sentence, a way to contact the store, and no self-service cancel", async ({ page }) => {
    const budi = await login();
    const code = await confirmed(budi, 4);
    const seen = watch(page);
    await stubControl({ noPolicy: true });
    await open(page, budi, code);
    await openDialog(page);
    await expect(page.locator("[data-cancel-error]")).toContainText("Kebijakan pembatalan belum ditetapkan. Hubungi kami sebelum membatalkan.");
    await expect(page.locator("[data-cancel-confirm]")).toBeDisabled();
    await expect(page.locator("[data-cancel-wa]")).toBeVisible();
    await expect(page.locator("[data-cancel-wa]")).toHaveAttribute("href", /wa\.me\//);
    expect(seen.cancelPosts).toHaveLength(0);
    await scan(page, "cancellation dialog (no policy)");
  });

  test("refusals read in the words of the spec: 429 waits and a retry succeeds, 422 reloads, 409 INVALID_STATE closes the loop", async ({ page }) => {
    const budi = await login();
    const code = await confirmed(budi, 4);
    const seen = watch(page);
    await open(page, budi, code);
    await openDialog(page);

    await stubControl({ refuseNextCancel: { status: 429, code: "RATE_LIMITED" } });
    await page.locator("[data-cancel-confirm]").click();
    await expect(page.locator("[data-cancel-error]")).toContainText("Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.");
    await expect(dialog(page)).toBeVisible();

    await stubControl({ refuseNextCancel: { status: 422, code: "UNPROCESSABLE" } });
    await page.locator("[data-cancel-confirm]").click();
    await expect(page.locator("[data-cancel-error]")).toContainText("Permintaan pembatalan tidak dapat diproses. Muat ulang halaman, lalu coba lagi.");
    expect((await reservation(budi, code)).status).toBe("confirmed");

    await stubControl({ refuseNextCancel: { status: 409, code: "INVALID_STATE" } });
    await page.locator("[data-cancel-confirm]").click();
    await expect(page.locator("[data-cancel-error]")).toContainText("Reservasi ini tidak dapat dibatalkan lagi.");
    await expect(page.locator("[data-cancel-confirm]")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Tutup" })).toBeVisible();
    await scan(page, "cancellation dialog (refused)");
    await page.getByRole("button", { name: "Tutup" }).click();
    await expect(dialog(page)).toBeHidden();

    // After the refusals the same reservation can still be cancelled once it is allowed again.
    await openDialog(page);
    await page.locator("[data-cancel-confirm]").click();
    await expect(page.locator("[data-detail-result]")).toContainText("Reservasi dibatalkan");
    expect(seen.cancelPosts.length).toBeGreaterThanOrEqual(4);
  });

  test("a quote that cannot be computed keeps the confirm button disabled and offers a retry; 429 on the quote reads as 'wait'", async ({ page }) => {
    const budi = await login();
    const code = await confirmed(budi, 4);
    await open(page, budi, code);

    await stubControl({ refuseNextQuote: { status: 429, code: "RATE_LIMITED" } });
    await page.getByRole("button", { name: "Batalkan reservasi" }).click();
    await expect(page.locator("[data-cancel-error]")).toContainText("Terlalu banyak percobaan");
    await expect(page.locator("[data-cancel-confirm]")).toBeDisabled();
    await expect(page.locator("[data-cancel-dl]")).toBeHidden();
    await page.locator("[data-cancel-retry]").click();
    await expect(page.locator("[data-cancel-dl]")).toBeVisible();
    await expect(page.locator("[data-cancel-confirm]")).toBeEnabled();
    await page.getByRole("button", { name: "Tidak, tetap pesan" }).click();

    // A dropped connection: "cannot compute", retry, then the quote appears.
    await page.route("**/cancellation-quote", (route) => route.abort("failed"));
    await page.getByRole("button", { name: "Batalkan reservasi" }).click();
    await expect(page.locator("[data-cancel-error]")).toContainText("Tidak dapat menghitung pengembalian dana. Coba lagi.");
    await expect(page.locator("[data-cancel-confirm]")).toBeDisabled();
    await page.unroute("**/cancellation-quote");
    await page.locator("[data-cancel-retry]").click();
    await expect(page.locator("[data-cancel-dl]")).toBeVisible();
    await expect(page.locator("[data-cancel-error]")).toBeHidden();
  });

  test("a dropped connection on the cancel is retried with the SAME Idempotency-Key and cancels once", async ({ page }) => {
    const budi = await login();
    const code = await confirmed(budi, 4);
    const seen = watch(page);
    await open(page, budi, code);
    await openDialog(page);

    let dropped = false;
    await page.route("**/booking/reservations/*/cancel", async (route) => {
      if (!dropped) {
        dropped = true;
        // The request reaches the server, the answer never reaches the page.
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.locator("[data-cancel-confirm]").click();
    await expect(page.locator("[data-cancel-error]")).toContainText("hasil pembatalan belum diketahui");
    await expect(page.locator("[data-cancel-retry]")).toBeVisible();
    await page.locator("[data-cancel-retry]").click();
    await expect(dialog(page)).toBeHidden();

    expect(seen.cancelPosts).toHaveLength(2);
    expect(seen.cancelPosts[1].key).toBe(seen.cancelPosts[0].key);
    await expect(page.locator("[data-detail-result]")).toContainText("Reservasi dibatalkan");
    await expect(page.locator("[data-detail-result]")).toContainText(RUPIAH("135.000"));
    expect((await reservation(budi, code)).refund?.finalRefund).toBe("135000.00");
  });

  test("a reservation that cannot be cancelled gets its reason in plain text; an expired hold never reads as confirmed", async ({ page }) => {
    const budi = await login();
    const code = await hold(budi, 9, "dp", "expire-1");
    await open(page, budi, code);
    await stubControl({ expireAll: true });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator("[data-detail-pills]")).toContainText("Penahanan habis", { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Batalkan reservasi" })).toHaveCount(0);
    await expect(page.locator("[data-detail-cancel-reason]")).toContainText("Penahanan reservasi ini sudah habis");
    await expect(page.locator("[data-detail-payment-note]")).toContainText("Waktu penahanan habis sebelum pembayaran kami terima.");
    await expect(page.locator("[data-detail-payment-note]")).toContainText(`Nomor pesanan: ${code}`);
    await expect(page.locator("[data-detail-pills]")).not.toContainText("Terkonfirmasi");
    await scan(page, "/akun/reservasi?kode= (expired)");
    await noOverflow360(page, "/akun/reservasi?kode= (expired)");
  });
});

/** A second browser context holding another account's session (same built site). */
async function browserPage(page: Page, sesi: Sesi): Promise<Page> {
  const context = await page.context().browser()!.newContext({ baseURL: PREVIEW });
  const other = await context.newPage();
  await signedIn(other, sesi);
  return other;
}
