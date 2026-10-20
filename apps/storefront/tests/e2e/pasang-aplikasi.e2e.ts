/**
 * The iPhone install-help page and the install metadata (issue #428), in a
 * real browser against the real build (`build-and-serve.ts` builds with
 * `PUBLIC_INSTALL_HELP=1`). Axe and 360px overflow for this page are covered
 * by `aksesibilitas.e2e.ts` / `responsif.e2e.ts` through `KEY_PAGES`.
 */
import { expect, test } from "@playwright/test";
import { INSTALL_HELP_PATH } from "../../src/lib/pasang-aplikasi";

test("a normal browser tab sees the steps and the closed-tab notification limit, with no permission prompt", async ({ page }) => {
  let permissionRequested = false;
  await page.addInitScript(() => {
    // Any attempt to ask for notification permission would be a bug on this page.
    const original = window.Notification;
    if (original) {
      original.requestPermission = (() => {
        (window as unknown as { __permissionRequested: boolean }).__permissionRequested = true;
        return Promise.resolve("denied" as NotificationPermission);
      }) as typeof original.requestPermission;
    }
  });

  await page.goto(INSTALL_HELP_PATH);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Tambahkan ke Layar Utama").first()).toBeVisible();
  await expect(page.getByText("Tab browser tidak bisa menerima notifikasi")).toBeVisible();
  // Not standalone: the "already installed" status stays hidden.
  await expect(page.locator("[data-when=standalone]")).toBeHidden();

  permissionRequested = await page.evaluate(
    () => (window as unknown as { __permissionRequested?: boolean }).__permissionRequested === true
  );
  expect(permissionRequested).toBe(false);
});

test("launched standalone, the page confirms it and hides the install steps", async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) =>
      query.includes("display-mode: standalone")
        ? ({ matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as MediaQueryList)
        : real(query)) as typeof window.matchMedia;
  });
  const page = await context.newPage();
  await page.goto(INSTALL_HELP_PATH);
  await expect(page.locator("[data-when=standalone]")).toBeVisible();
  await expect(page.locator("[data-when=browser]")).toBeHidden();
  await context.close();
});

test("every page links the manifest and the touch icon, and both resolve", async ({ page, request }) => {
  await page.goto("/");
  expect(await page.locator('link[rel="manifest"]').getAttribute("href")).toBe("/manifest.webmanifest");
  const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect(touch).toBe("/apple-touch-icon.png");
  for (const path of ["/manifest.webmanifest", "/apple-touch-icon.png", "/icons/icon-192.png", "/icons/icon-512.png"]) {
    const response = await request.get(path);
    expect(`${path}:${response.status()}`).toBe(`${path}:200`);
  }
  expect((await request.get("/apple-touch-icon.png")).headers()["content-type"]).toContain("image/png");
});
