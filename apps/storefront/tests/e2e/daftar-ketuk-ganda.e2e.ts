/**
 * Issue #513: a double tap on **Daftar** sends ONE verify request, shows no
 * error, keeps the form disabled until the redirect, and a bfcache restore
 * (back button) leaves a usable form.
 *
 * Real browser, real built `/daftar`, the stub CMS (`scripts/stub-awcms.mjs`).
 * The verify response is held by `page.route` so the "pending" window is wide
 * enough to tap twice in; the requests are counted at the network layer, never
 * inferred from the page.
 *
 * Honest limits: this runs where a browser exists (`bun run test:e2e`, the
 * trusted host); it was written in a sandbox that cannot launch one, so it has
 * NOT been run by the author. A desktop Chromium `dblclick` and the Enter key
 * stand in for a phone's double tap; the real touch behaviour (and a real
 * bfcache, which headless Chromium does not always enable) is the physical
 * device check recorded in `docs/pengujian.md`. The bfcache case therefore
 * dispatches the `pageshow` event a restored page receives instead of relying on
 * the browser's own cache.
 *
 * Commerce-only: `/daftar` is a `toko` route, so the file skips cleanly on a
 * `berita` or `landing` run.
 */
import { expect, test } from "@playwright/test";
import { isGroupActive } from "../../src/config/profil";

test.skip(!isGroupActive("toko"), "/daftar is only built for the toko profile group.");

const VERIFY = "**/account/otp/verify";

function identitasBaru() {
  const n = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return { nama: "Rani Ketuk", email: `ketuk-${n}@example.test`, telepon: `0812${n.slice(-8)}` };
}

async function sampaiLangkahKode(page: import("@playwright/test").Page) {
  const { nama, email, telepon } = identitasBaru();
  await page.goto("/daftar");
  await page.locator('[name="name"]').fill(nama);
  await page.locator('[name="phone"]').fill(telepon);
  await page.locator('[name="email"]').fill(email);
  await page.locator("[data-kirim-kode]").click();
  await expect(page.locator('[data-step="code"]')).toBeVisible();
  await page.locator('[name="code"]').fill("123456");
}

test("a double tap and the Enter key send one verify request and show no error", async ({ page }) => {
  let permintaan = 0;
  let lepaskan: (() => void) | undefined;
  const ditahan = new Promise<void>((resolve) => (lepaskan = resolve));
  await page.route(VERIFY, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    permintaan += 1;
    await ditahan;
    await route.fallback();
  });

  await sampaiLangkahKode(page);
  const kirim = page.locator('[data-step="code"] button[type="submit"]');

  await kirim.dblclick();
  await page.locator('[name="code"]').press("Enter").catch(() => undefined); // the control is already disabled: a no-op by design

  // While pending: busy, disabled, announced politely, no error.
  await expect(page.locator("[data-daftar-form]")).toHaveAttribute("aria-busy", "true");
  await expect(kirim).toBeDisabled();
  await expect(page.locator("[data-proses-status]")).toHaveText("Memproses...");
  await expect(page.locator("[data-submit-error]")).toBeHidden();

  lepaskan?.();
  await page.waitForURL(/\/akun/);
  expect(permintaan).toBe(1);
});

test("the form stays disabled after a successful verify until the redirect", async ({ page }) => {
  // Answer the navigation to the account page with an empty 204: the browser stays on this page (an abort would swap in
  // the browser's error page), in the state it is in the instant a redirect is under way.
  await page.route("**/akun", (route) =>
    route.request().isNavigationRequest() ? route.fulfill({ status: 204 }) : route.fallback()
  );

  await sampaiLangkahKode(page);
  const kirim = page.locator('[data-step="code"] button[type="submit"]');
  await kirim.click();

  // Read through the page, not through locators: with a navigation pending, Playwright's locator actions wait for it to
  // finish, and this one is deliberately never allowed to.
  const keadaan = () =>
    page.evaluate(() => ({
      sibuk: document.querySelector("[data-daftar-form]")?.getAttribute("aria-busy"),
      nonaktif: document.querySelector<HTMLButtonElement>('[data-step="code"] button[type="submit"]')?.disabled,
      status: document.querySelector("[data-proses-status]")?.textContent
    }));
  await expect.poll(keadaan).toEqual({ sibuk: "true", nonaktif: true, status: "Memproses..." });
  // Even after the response has long settled, nothing re-enabled it.
  await page.waitForTimeout(500);
  expect(await keadaan()).toEqual({ sibuk: "true", nonaktif: true, status: "Memproses..." });

  // The back button restoring the page from the bfcache fires pageshow with persisted: the form must be usable again.
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect.poll(keadaan).toEqual({ sibuk: null, nonaktif: false, status: "" });
});

test("the resend button is guarded too and keeps its countdown", async ({ page }) => {
  let permintaan = 0;
  await page.route("**/account/otp/request", async (route) => {
    if (route.request().method() === "POST") permintaan += 1;
    await route.fallback();
  });
  await sampaiLangkahKode(page);
  expect(permintaan).toBe(1); // "Kirim kode"

  const ulang = page.locator("[data-kirim-ulang]");
  await expect(ulang).toBeDisabled(); // the 60 s countdown owns it
  await expect(page.locator("[data-countdown]")).not.toHaveText("");
});
