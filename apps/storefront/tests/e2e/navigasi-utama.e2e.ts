/**
 * Regression coverage for issue #230 — a REAL browser proving the primary
 * nav is actually visible and reachable above the 720px mobile breakpoint,
 * not merely present in the markup.
 *
 * `Header.astro` (and, on a `berita`-profile page, `NavBerita.astro`) now
 * renders its nav array twice (issue #230's fix): a desktop `.primary-nav`,
 * always open, and the mobile copy inside `.mobile-nav-toggle` (a native
 * `<details>`/`<summary>` disclosure). `global.css` shows exactly one of
 * the two by viewport width and `display: none`s the other out of the
 * accessibility tree. Before this fix, the single nav lived inside the
 * `<details>` only — and a *closed* `<details>` hides its own content
 * through the UA stylesheet's `::details-content` rule regardless of
 * author CSS, so the nav was never actually visible above 720px in any
 * browser. This spec is exactly what issue #230 says would have caught the
 * regression: a visible, focusable nav link at desktop width, plus proof
 * there is only ever one VISIBLE "Navigasi utama" landmark at once (both
 * copies exist in the DOM by construction; `getByRole` already excludes
 * whichever one `display: none` removes from the accessibility tree, which
 * is exactly the property being asserted).
 *
 * Runs against the home page for whichever `SITE_PROFILE` this harness
 * built (`profil-halaman.ts`) — every profile renders one of the two
 * components above, so the defect and the fix are both profile-independent.
 */
import { expect, test, type Page } from "@playwright/test";
import { KEY_PAGES } from "./profil-halaman";

const HOME_PATH = KEY_PAGES.find((page) => page.name === "home")?.path ?? "/";

/** Dismiss the home page's own promo popup, if one rendered — otherwise its
 * `<dialog>` overlay intercepts every click/Tab target on the page (the
 * same best-effort dismissal `screenshots.e2e.ts` already does for the same
 * reason). */
async function dismissPromoPopupIfPresent(page: Page): Promise<void> {
  const closeButton = page.locator("[data-promo-popup] [data-popup-close]");
  if (await closeButton.count()) {
    await closeButton.first().click();
  }
}

test("desktop (1440px): the primary nav is visible, keyboard-focusable, and the only visible 'Navigasi utama' landmark", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(HOME_PATH);
  await dismissPromoPopupIfPresent(page);

  // Both renders exist in the DOM (issue #230's fix)…
  const navsInDom = page.locator("nav[aria-label='Navigasi utama']");
  await expect(navsInDom).toHaveCount(2);

  // …but exactly one is in the accessibility tree at this viewport —
  // `getByRole` excludes an element `display: none` removes from it, which
  // is exactly the property that broke before this fix (a closed
  // `<details>` hid the ONLY copy, leaving zero accessible, not one).
  const accessibleNav = page.getByRole("navigation", { name: "Navigasi utama" });
  await expect(accessibleNav).toHaveCount(1);

  const desktopNav = page.locator("nav.primary-nav[aria-label='Navigasi utama']");
  await expect(desktopNav).toBeVisible();
  await expect(accessibleNav).toHaveJSProperty("className", "primary-nav");

  const firstLink = desktopNav.locator("a").first();
  await expect(firstLink).toBeVisible();

  // The mobile toggle/panel must not be occupying screen space at this width.
  await expect(page.locator(".mobile-nav-toggle")).toBeHidden();

  // Keyboard reachability: Tab from the top of the document must eventually
  // focus a link inside the visible desktop nav (not the hidden mobile copy).
  const firstLinkHref = await firstLink.getAttribute("href");
  let focusedHref: string | null = null;
  for (let i = 0; i < 40 && focusedHref !== firstLinkHref; i += 1) {
    await page.keyboard.press("Tab");
    focusedHref = await page.evaluate(() => {
      const el = document.activeElement;
      return el && el.tagName === "A" ? el.getAttribute("href") : null;
    });
  }
  expect(focusedHref, "Tab never reached the first desktop nav link").toBe(firstLinkHref);
});

test("mobile (360px): the desktop nav is hidden and the disclosure toggle opens the mobile nav", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(HOME_PATH);
  await dismissPromoPopupIfPresent(page);

  await expect(page.locator("nav.primary-nav[aria-label='Navigasi utama']")).toBeHidden();

  const toggle = page.locator(".mobile-nav-toggle");
  const summary = toggle.locator("summary");
  const mobileNav = toggle.locator("nav[aria-label='Navigasi utama']");

  await expect(summary).toBeVisible();
  await expect(mobileNav).toBeHidden();

  await summary.click();

  await expect(mobileNav).toBeVisible();
  await expect(mobileNav.locator("a").first()).toBeVisible();
});
