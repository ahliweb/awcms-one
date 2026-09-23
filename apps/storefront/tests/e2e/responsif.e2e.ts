/**
 * No-horizontal-overflow coverage (issue #183) — a REAL browser measuring
 * `document.documentElement.scrollWidth` against `window.innerWidth` at a
 * phone width (360px) and a desktop width (1280px), for every one of this
 * profile's key pages (`profil-halaman.ts`). The deterministic replacement
 * for `docs/responsif.md`'s prior "read the CSS, never opened a browser"
 * caveat.
 *
 * `scrollWidth > innerWidth` is exactly the condition that produces an
 * unwanted horizontal scrollbar — a fluid grid whose `min(Npx, 100%)` clamp
 * (see `docs/responsif.md`) is working correctly never trips it; a fixed
 * track, an unclamped `width`, or a too-wide unbreakable string would.
 *
 * What this does NOT prove: only two widths are sampled, never a continuous
 * sweep, and a layout that overflows only BETWEEN 360px and 1280px (an
 * intermediate breakpoint's own transition) would not be caught here — see
 * `docs/responsif.md`'s own restated limits section.
 */
import { expect, test } from "@playwright/test";
import { ACTIVE_PROFILE, KEY_PAGES } from "./profil-halaman";

const VIEWPORTS = [
  { name: "mobile", width: 360, height: 800 },
  { name: "desktop", width: 1280, height: 800 }
] as const;

for (const keyPage of KEY_PAGES) {
  for (const viewport of VIEWPORTS) {
    test(`${ACTIVE_PROFILE}/${keyPage.name} (${keyPage.path}) has no horizontal overflow at ${viewport.name} (${viewport.width}px)`, async ({
      page
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(keyPage.path);

      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth
      }));

      expect(
        scrollWidth,
        `${keyPage.path} at ${viewport.width}px: document.documentElement.scrollWidth (${scrollWidth}px) exceeds window.innerWidth (${innerWidth}px) — a horizontal scrollbar a reader never asked for.`
      ).toBeLessThanOrEqual(innerWidth);
    });
  }
}
