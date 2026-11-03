/**
 * Issue #513: retry after a network failure on checkout. The first
 * `POST /orders` dies on the wire (no response: the browser cannot know whether
 * the CMS processed it); the shopper taps "Pesan" again and the SECOND request
 * carries the SAME `idempotencyKey` (the cart id), so the CMS replays the order
 * instead of creating a second one; the form is usable after the failure and
 * shows the error, and a second tap while a request is in flight is ignored.
 *
 * Real browser, real built `/checkout`, the stub CMS (which replays a repeated
 * `idempotencyKey`, `scripts/stub-awcms.mjs`). Written in a sandbox that cannot
 * launch a browser: it has NOT been run by the author, and runs on the trusted
 * host (`bun run test:e2e`). Commerce-only: skips cleanly on `berita`/`landing`.
 */
import { expect, test, type Page } from "@playwright/test";
import { isGroupActive } from "../../src/config/profil";

test.skip(!isGroupActive("toko"), "Checkout is only built for the toko profile group.");

async function sampaiTinjau(page: Page): Promise<void> {
  await page.goto("/product/kopi-arabika-kalteng-250g");
  await page.locator("[data-add-to-cart]").click();
  await expect(page.locator("[data-cart-feedback]")).toBeVisible();
  await page.goto("/checkout");
  await page.locator("#customer-name").fill("Siti Rahma");
  await page.locator("#customer-phone").fill("081234567890");
  await page.locator('[data-step-next="contact"]').click();
  await page.locator('[data-step-next="address"]').click();
  await page.getByLabel(/Ambil di toko/).check();
  await page.locator('[data-step-next="shipping"]').click();
  await page.getByLabel(/QRIS/).check();
  await page.locator('[data-step-next="payment"]').click();
  await expect(page.locator('[data-step="review"]')).toBeVisible();
}

test("a retry after a dropped connection reuses the key and lands on the one order", async ({ page }) => {
  const kunci: string[] = [];
  let percobaan = 0;
  await page.route("**/api/v1/commerce/storefront/orders", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fallback();
    percobaan += 1;
    kunci.push((JSON.parse(req.postData() ?? "{}") as { idempotencyKey?: string }).idempotencyKey ?? "");
    if (percobaan === 1) return route.abort("failed"); // no response at all
    return route.fallback();
  });

  await sampaiTinjau(page);
  const pesan = page.locator("[data-submit-order]");
  await pesan.click();

  // The failure is shown and the form is usable again (not a dead disabled form).
  await expect(page.locator("[data-submit-error]")).toBeVisible();
  await expect(pesan).toBeEnabled();
  await expect(page.locator('[data-step="review"]')).toBeVisible();

  await pesan.click();
  await page.waitForURL(/\/pesanan\?kode=/);

  expect(percobaan).toBe(2);
  expect(kunci[0]).toBeTruthy();
  expect(kunci[1]).toBe(kunci[0]);
});

test("a second tap while the order request is in flight sends nothing more", async ({ page }) => {
  let percobaan = 0;
  let lepaskan: (() => void) | undefined;
  const ditahan = new Promise<void>((resolve) => (lepaskan = resolve));
  await page.route("**/api/v1/commerce/storefront/orders", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    percobaan += 1;
    await ditahan;
    await route.fallback();
  });

  await sampaiTinjau(page);
  const pesan = page.locator("[data-submit-order]");
  await pesan.dblclick();
  await expect(pesan).toBeDisabled();
  await expect(page.locator("[data-checkout-form]")).toHaveAttribute("aria-busy", "true");

  lepaskan?.();
  await page.waitForURL(/\/pesanan\?kode=/);
  expect(percobaan).toBe(1);
});
