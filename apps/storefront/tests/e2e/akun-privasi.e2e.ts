/**
 * Browser-level coverage of the shopper's own data export and erasure on the
 * storefront (issue #529, ADR-0055 D3/D4), against a REAL built static site and
 * the account half of the stub CMS (`scripts/stub-awcms.mjs`, `/account/privacy/*`).
 *
 * REAL: the built page and script, every request to the stub, the download the
 * browser performs, the DOM, focus and axe. FAKED: the CMS - the stub accepts the
 * fixed code `123456` and models only the response shapes; the real erasure,
 * the OTP table and the refusal predicates are covered by the CMS integration
 * suite (`apps/cms/tests/integration/commerce-customer-subject.integration.test.ts`).
 *
 * Browsers cannot run in the agent sandbox that wrote this file: it runs on the
 * trusted host with `bun run test:e2e` (and as part of `bun run ci:e2e`), and was
 * NOT executed when it was written.
 *
 * Commerce-only: `/akun/privasi` is a `toko` route, so the file skips cleanly on
 * a `berita` or `landing` run.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { isGroupActive } from "../../src/config/profil";
import { PREVIEW_PORT, STUB_PORT } from "./ports";

test.describe.configure({ mode: "serial" });
test.skip(!isGroupActive("toko"), "The privacy page is only built for the toko profile group.");

const STUB = `http://localhost:${STUB_PORT}`;
const API = `${STUB}/api/v1/commerce/storefront`;
const PREVIEW = `http://localhost:${PREVIEW_PORT}`;
const SESSION_KEY = "awcms-one:akun:v1";

type Sesi = { token: string; expiresAt: string; account: { id: string } & Record<string, unknown> };

async function api<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { origin: PREVIEW, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as { data: T };
  return { status: response.status, data: payload.data };
}

let registered = 0;
async function register(prefix = "privasi"): Promise<Sesi> {
  registered += 1;
  const email = `${prefix}-${Date.now()}-${registered}@example.test`;
  await api("/account/otp/request", { email, purpose: "register", name: "Siti Pembeli", phone: `+62813000${String(registered).padStart(5, "0")}` });
  const verified = await api<Sesi>("/account/otp/verify", { email, code: "123456", purpose: "register" });
  expect(verified.status).toBe(200);
  return verified.data;
}

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

test.describe("/akun/privasi", () => {
  test("a guest sees only the sign-in link", async ({ page }) => {
    await page.goto("/akun/privasi");
    await expect(page.locator("[data-guest-view]")).toBeVisible();
    await expect(page.locator("[data-member-view]")).toBeHidden();
  });

  test("a signed-in shopper downloads a JSON export after asking for a code", async ({ page }) => {
    await signedIn(page, await register());
    await page.goto("/akun/privasi");
    await expect(page.locator("[data-member-view]")).toBeVisible();

    await page.locator("[data-privasi-ekspor-kirim]").click();
    await expect(page.locator("[data-status]")).toContainText("Kode verifikasi dikirim");

    // A wrong code is the one generic answer and downloads nothing.
    await page.locator("[data-privasi-ekspor-kode]").fill("000000");
    await page.locator("[data-privasi-ekspor-unduh]").click();
    await expect(page.locator("[data-submit-error]")).toContainText("Kode verifikasi salah");

    await page.locator("[data-privasi-ekspor-kode]").fill("123456");
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("[data-privasi-ekspor-unduh]").click()]);
    expect(download.suggestedFilename()).toMatch(/^data-saya-.+-\d{4}-\d{2}-\d{2}\.json$/);
  });

  test("an erasure needs the acknowledgement, signs the shopper out and keeps the retention notice", async ({ page }) => {
    await signedIn(page, await register());
    await page.goto("/akun/privasi");

    await page.locator("[data-privasi-hapus-kirim]").click();
    await page.locator("[data-privasi-hapus-kode]").fill("123456");

    // Without ticking the acknowledgement nothing is sent.
    await page.locator("[data-privasi-hapus-jalankan]").click();
    await expect(page.locator("[data-submit-error]")).toContainText("Centang pernyataan");
    await expect(page.locator("[data-done-view]")).toBeHidden();

    await page.locator("[data-privasi-hapus-paham]").check();
    await page.locator("[data-privasi-hapus-jalankan]").click();
    await expect(page.locator("[data-done-view]")).toBeVisible();
    await expect(page.locator("[data-done-message]")).toContainText("tetap disimpan");

    // The stored session is gone: the account area now treats the browser as a guest.
    expect(await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY)).toBeNull();
  });

  test("an erasure refused for an open order changes nothing and lists the reason", async ({ page }) => {
    const sesi = await register("terbuka");
    await signedIn(page, sesi);
    await page.goto("/akun/privasi");

    await page.locator("[data-privasi-hapus-kode]").fill("123456");
    await page.locator("[data-privasi-hapus-paham]").check();
    await page.locator("[data-privasi-hapus-jalankan]").click();

    await expect(page.locator("[data-submit-error]")).toContainText("Masih ada pesanan yang diproses");
    await expect(page.locator("[data-done-view]")).toBeHidden();
    // The session survives a refusal.
    expect(await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY)).not.toBeNull();
  });

  test("the page has no serious or critical axe violation", async ({ page }) => {
    await signedIn(page, await register());
    await page.goto("/akun/privasi");
    await expect(page.locator("[data-member-view]")).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => v.id)).toEqual([]);
  });
});
