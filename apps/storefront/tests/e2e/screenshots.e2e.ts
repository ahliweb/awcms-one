/**
 * Per-profile screenshot capture (issue #183) — full-page PNGs at a phone
 * width (360px) and a desktop width (1280px) for every one of this
 * profile's key pages (`profil-halaman.ts`), written under
 * `E2E_SCREENSHOT_DIR` (default `test-results/screenshots/<profile>/`) and
 * uploaded as a CI artifact by `.github/workflows/e2e.yml`.
 *
 * Deliberately NOT compared against a committed baseline: cross-OS font
 * rendering makes a byte-level baseline flaky by construction (a runner's
 * own font substitution shifts anti-aliasing pixel-for-pixel), and a hosted
 * visual-diff service is a paid external dependency this repo does not
 * have — see the issue's own decision record. A reviewer opens the artifact
 * to actually SEE what a profile's redesigned pages look like at each
 * width; this spec's only job is producing that evidence deterministically,
 * never judging it.
 *
 * A DIFFERENT, smaller thing from `scripts/screenshots-readme.mjs`
 * (`bun run screenshots:readme`, documented in `docs/pengujian.md`): that
 * script captures a small, curated, optimised set for the README, not
 * every key page of every profile as a debugging/review artifact.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ACTIVE_PROFILE, KEY_PAGES } from "./profil-halaman";

const STOREFRONT_ROOT = new URL("../../", import.meta.url).pathname;
const OUTPUT_DIR = process.env.E2E_SCREENSHOT_DIR ?? join(STOREFRONT_ROOT, "test-results", "screenshots");

const VIEWPORTS = [
  { name: "mobile", width: 360, height: 800 },
  { name: "desktop", width: 1280, height: 800 }
] as const;

for (const keyPage of KEY_PAGES) {
  for (const viewport of VIEWPORTS) {
    test(`${ACTIVE_PROFILE}/${keyPage.name} (${keyPage.path}) screenshot at ${viewport.name} (${viewport.width}px)`, async ({
      page
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(keyPage.path);

      // A condition wait, never a fixed sleep (this repo's own `playwright`
      // skill: "never waitForTimeout") — lets a page's own runtime scripts
      // (the cart badge, the read-aloud player's own capability probe)
      // settle before the pixels are captured.
      await page.waitForLoadState("networkidle");

      const filePath = join(OUTPUT_DIR, ACTIVE_PROFILE, `${keyPage.name}-${viewport.name}.png`);
      await page.screenshot({ path: filePath, fullPage: true });

      expect(existsSync(filePath), `Screenshot was not written to ${filePath}`).toBe(true);
    });
  }
}
