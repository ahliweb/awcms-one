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
 *
 * Commerce-only (issue #183): `/product`, `/keranjang`, `/checkout`,
 * `/pesanan` are all `toko`-group routes (`src/config/routes.ts`'s
 * `ROUTE_GROUPS`) — this whole file skips cleanly, not red, on a `berita`
 * or `landing` run of `bun run test:e2e`, which build neither the pages
 * nor the anonymous storefront-commerce endpoints this spec drives.
 */
import { expect, test } from "@playwright/test";
import { isGroupActive } from "../../src/config/profil";

test.describe.configure({ mode: "serial" });

test.skip(!isGroupActive("toko"), "Checkout/cart routes are only built for the toko profile group.");

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

test("picking a district prices real courier options, and choosing one carries its etd/price into the order (issue #109)", async ({
  page
}) => {
  await page.goto("/product/kopi-arabika-kalteng-250g");
  await page.locator("[data-add-to-cart]").click();
  await expect(page.locator("[data-cart-feedback]")).toBeVisible();

  await page.goto("/checkout");

  // Step 1: contact.
  await page.locator("#customer-name").fill("Andi Saputra");
  await page.locator("#customer-phone").fill("081234567891");
  await page.locator('[data-step-next="contact"]').click();

  // Step 2: address — before a district is chosen, the shipping step's
  // courier row is the disabled placeholder with its own explanatory note
  // (never a bare "Segera hadir" with no reason).
  await expect(page.locator('[data-step="address"]')).toBeVisible();
  await page.locator("#address-recipient").fill("Andi Saputra");
  await page.locator("#address-phone").fill("081234567891");
  await page.locator('[data-step-next="address"]').click();

  await expect(page.locator('[data-step="shipping"]')).toBeVisible();
  await expect(page.locator("[data-shipping-options]")).toContainText(
    "Pilih kecamatan tujuan pada langkah alamat untuk melihat ongkir kurir."
  );

  // Back to address: choosing a district re-quotes and the shipping step
  // now shows real, priced courier services for it.
  await page.locator('[data-step-prev="shipping"]').click();
  await expect(page.locator('[data-step="address"]')).toBeVisible();

  await page.locator("#address-province").selectOption({ label: "KALIMANTAN TENGAH" });
  await expect(page.locator("#address-city")).toBeEnabled();
  await page.locator("#address-city").selectOption({ label: "KOTAWARINGIN BARAT" });
  await expect(page.locator("#address-district")).toBeEnabled();
  await page.locator("#address-district").selectOption({ label: "ARUT SELATAN" });
  await page.locator("#address-postal").fill("74111");
  await page.locator("#address-street").fill("Jl. Contoh No. 1");

  await page.locator('[data-step-next="address"]').click();

  await expect(page.locator('[data-step="shipping"]')).toBeVisible();
  await expect(page.getByLabel(/JNE REG/)).toBeVisible();
  await expect(page.locator("[data-shipping-options]")).toContainText("2-3 hari");
  await expect(page.locator("[data-shipping-options]")).toContainText("Rp");

  await page.getByLabel(/JNE REG/).check();
  await page.locator('[data-step-next="shipping"]').click();

  // Step 4: payment.
  await expect(page.locator('[data-step="payment"]')).toBeVisible();
  await page.getByLabel(/QRIS/).check();
  await page.locator('[data-step-next="payment"]').click();

  // Step 5: review and submit.
  await expect(page.locator('[data-step="review"]')).toBeVisible();
  await expect(page.locator("[data-review-summary]")).toContainText("Rp");
  await page.locator("[data-submit-order]").click();

  await page.waitForURL(/\/pesanan\?kode=/);
  await expect(page.locator("[data-order-status]")).toContainText("Menunggu pembayaran");
});

test("a gateway order redirects to the stub's own hosted page, and paying there shows the tracking page as paid (issue #112)", async ({
  page
}) => {
  await page.goto("/product/kopi-arabika-kalteng-250g");
  await page.locator("[data-add-to-cart]").click();
  await expect(page.locator("[data-cart-feedback]")).toBeVisible();

  await page.goto("/checkout");

  // Step 1: contact.
  await page.locator("#customer-name").fill("Rina Wulandari");
  await page.locator("#customer-phone").fill("081234567892");
  await page.locator('[data-step-next="contact"]').click();

  // Step 2: address — self-pickup, skipped.
  await expect(page.locator('[data-step="address"]')).toBeVisible();
  await page.locator('[data-step-next="address"]').click();

  // Step 3: shipping — self-pickup.
  await expect(page.locator('[data-step="shipping"]')).toBeVisible();
  await page.getByLabel(/Ambil di toko/).check();
  await page.locator('[data-step-next="shipping"]').click();

  // Step 4: payment — the gateway option, listed because the stub's own
  // `store-settings-public.json` carries `payment.gatewayEnabled: true`.
  await expect(page.locator('[data-step="payment"]')).toBeVisible();
  await page.getByLabel(/Bayar online/).check();
  await page.locator('[data-step-next="payment"]').click();

  // Step 5: review and submit — this whole tab navigates to the stub's own
  // hosted payment page (a DIFFERENT origin, the stub's own port), never
  // `/pesanan` directly, matching ADR-0010's "redirect-based" flow.
  await expect(page.locator('[data-step="review"]')).toBeVisible();
  await page.locator("[data-submit-order]").click();

  await page.waitForURL(/\/stub\/gateway\//);
  await expect(page.getByRole("button", { name: "Bayar (simulasi)" })).toBeVisible();

  // "Bayar (simulasi)" flips the order to paid on the stub, then redirects
  // this SAME tab back to `/pesanan?kode=…` on the storefront's own origin.
  await page.getByRole("button", { name: "Bayar (simulasi)" }).click();

  await page.waitForURL(/\/pesanan\?kode=/);
  await expect(page.locator("[data-order-status]")).toContainText("Sudah dibayar");
  await expect(page.locator("[data-gateway-pay]")).toBeHidden();
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
