/**
 * Browser-level coverage for issue #30's whole flow, against a REAL built
 * static site (see `global-setup.ts`) and the extended
 * `scripts/stub-awcms.mjs` state machine: add to cart → the cart page's
 * live quote renders real totals → checkout submits an order → `/pesanan`
 * shows it — plus the neutral not-found state for a wrong phone.
 *
 * `kopi-arabika-kalteng-250g` is used throughout: it is the one fixture
 * product with no variants and no service-form fields, so "add to cart"
 * needs no extra selection first — the SAME reason `tests/fixtures/awcms/
 * products.json` carries it at all is not tested here, only relied on.
 */
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

let orderCode: string | undefined;

test("add to cart → cart quote renders totals → checkout submits → tracking shows the order", async ({ page }) => {
  await page.goto("/product/kopi-arabika-kalteng-250g");
  await page.locator("[data-add-to-cart]").click();
  await expect(page.locator("[data-cart-feedback]")).toBeVisible();

  await page.goto("/keranjang");
  await expect(page.locator("[data-keranjang-body]")).toBeVisible();
  // The quote's own total row — never a client-computed number (issue #30's
  // own "totals shown are the quote's, never computed client-side" rule).
  await expect(page.locator("[data-summary-body]")).toContainText("Rp");
  await expect(page.locator("[data-checkout-link]")).toHaveAttribute("aria-disabled", "false");

  await page.locator("[data-checkout-link]").click();
  await expect(page).toHaveURL(/\/checkout$/);

  // Step 1: contact.
  await page.locator("#customer-name").fill("Siti Rahma");
  await page.locator("#customer-phone").fill("081234567890");
  await expect(page.locator("[data-phone-preview]")).toContainText("+62");
  await page.locator('[data-step-next="contact"]').click();

  // Step 2: address — skipped entirely (self-pickup, chosen next).
  await expect(page.locator('[data-step="address"]')).toBeVisible();
  await page.locator('[data-step-next="address"]').click();

  // Step 3: shipping — self-pickup, no cost, no address required.
  await expect(page.locator('[data-step="shipping"]')).toBeVisible();
  await page.getByLabel(/Ambil di toko/).check();
  await page.locator('[data-step-next="shipping"]').click();

  // Step 4: payment — QRIS is the one method the stub's store settings
  // fixture marks active.
  await expect(page.locator('[data-step="payment"]')).toBeVisible();
  await page.getByLabel(/QRIS/).check();
  await page.locator('[data-step-next="payment"]').click();

  // Step 5: review and submit.
  await expect(page.locator('[data-step="review"]')).toBeVisible();
  await expect(page.locator("[data-review-summary]")).toContainText("Rp");
  await page.locator("[data-submit-order]").click();

  await page.waitForURL(/\/pesanan\?kode=/);
  const url = new URL(page.url());
  orderCode = url.searchParams.get("kode") ?? undefined;
  expect(orderCode).toBeTruthy();

  await expect(page.locator("[data-order-status]")).toContainText("Menunggu pembayaran");
  await expect(page.locator("[data-order-code]")).toContainText(orderCode!);
  await expect(page.locator("[data-payment-section]")).toBeVisible();
});

test("a wrong phone shows the neutral not-found state, never a hint about which part was wrong", async ({
  page
}) => {
  test.skip(!orderCode, "requires the previous test's order code");

  await page.goto(`/pesanan?kode=${orderCode}`);
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();

  await expect(page.locator("[data-phone-form]")).toBeVisible();
  await page.locator("#pesanan-phone").fill("089999999999");
  await page.locator('[data-phone-form] button[type="submit"]').click();

  await expect(page.locator("[data-order-error]")).toBeVisible();
  await expect(page.locator("[data-order-body]")).toBeHidden();
});
