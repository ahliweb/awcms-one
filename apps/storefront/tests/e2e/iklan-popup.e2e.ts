/**
 * Browser-level coverage for the ad popup (issue #53, A7) against the REAL
 * built static site `global-setup.ts` produces — the top of this app's
 * testing pyramid, run by `bun run test:e2e` (never `bun test`; the `.e2e.ts`
 * suffix keeps it out of the unit runner's file discovery, see
 * `checkout.e2e.ts`'s docblock).
 *
 * `/berita/panduan-pemilu-2024` (any article page would do) renders BOTH
 * trigger shapes from the committed
 * `tests/fixtures/awcms/ad-placements-active.json`:
 *
 *   - `article_middle` — a LINKED creative (`linkUrl` set, `advertorial`):
 *     the anchor trigger, whose popup shows the "Buka iklan" CTA to that
 *     same href and the "Advertorial" disclosure label.
 *   - `article_bottom` — an UNLINKED creative (`linkUrl: null`, `standard`;
 *     added to the fixture by this issue): the `<button>` trigger, whose
 *     popup hides the CTA, shows the no-destination message, and falls
 *     back to the slot's own "Iklan" label since `standard` has no
 *     disclosure label of its own.
 *
 * Why an ARTICLE page and not `/berita` (whose header/sidebar slots carry
 * the same two shapes): the preview server answers `/berita` with the 404
 * page. `build.format: "file"` emits `dist/client/berita.html` next to the
 * `dist/client/berita/` directory of article pages, and `@astrojs/node`'s
 * static handler (`serve-static.js`, `trailingSlash: "never"` branch)
 * rewrites a directory-shaped URL to `/berita/index.html` — which does not
 * exist — before `send`'s `.html` extension fallback ever gets a chance.
 * `/video` has the same shape. That is a pre-existing serving bug outside
 * this issue's file ownership, reported for follow-up; this spec does not
 * depend on its fix.
 *
 * Both triggers are located by `data-placement` + `[data-iklan-popup]`
 * rather than by page structure, so a concurrent re-arrangement of the
 * article page (or issue #49's new `Sidebar.astro`) only has to keep those
 * two placements rendering.
 *
 * The creatives point at `https://media.example.test/…`, which resolves to
 * nothing in the test browser: the popup's `<img>` is a broken image
 * throughout. That is fine — every assertion here is about the dialog's
 * behaviour, not the pixels — and it exercises the "intrinsic size unknown
 * → no `width`/`height` attribute" branch of `readTrigger` for free.
 *
 * News-only (issue #183): `/berita/*` is a `berita`-group route
 * (`src/config/routes.ts`'s `ROUTE_GROUPS`) — this whole file skips
 * cleanly, not red, on a `landing` run of `bun run test:e2e`, which builds
 * no article pages at all.
 */
import { expect, test } from "@playwright/test";
import { isGroupActive } from "../../src/config/profil";

test.skip(!isGroupActive("berita"), "Article pages (and their ad-popup slots) are only built for the berita profile group.");

const ARTICLE = "/berita/panduan-pemilu-2024";
const LINKED_TRIGGER = '.ad-slot[data-placement="article_middle"] [data-iklan-popup]';
const UNLINKED_TRIGGER = '.ad-slot[data-placement="article_bottom"] [data-iklan-popup]';
const DIALOG = "dialog#iklan-popup";

test("a plain click on a linked creative opens the dialog instead of navigating, with the CTA on the ad's own href", async ({
  page
}) => {
  await page.goto(ARTICLE);

  const trigger = page.locator(LINKED_TRIGGER).first();
  await expect(trigger).toBeVisible();
  const href = await trigger.getAttribute("href");
  expect(href).toBe("https://example.test/wisata-kalteng");

  // Not in the DOM at all before the first click — built lazily.
  await expect(page.locator(DIALOG)).toHaveCount(0);

  await trigger.click();

  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveJSProperty("open", true);
  // Still on the article — the anchor's own navigation was intercepted.
  await expect(page).toHaveURL(new RegExp(`${ARTICLE}$`));

  await expect(dialog.locator("[data-iklan-popup-name]")).toHaveText("Wisata Kalteng — Advertorial");
  await expect(dialog.locator("[data-iklan-popup-label]")).toHaveText("Advertorial");
  const image = dialog.locator("[data-iklan-popup-image]");
  await expect(image).toHaveAttribute("src", "https://media.example.test/ads/wisata-kalteng.jpg");
  await expect(image).toHaveAttribute("alt", "Wisata Kalteng");
  // Natural size: the trigger's 300×250 slot dimensions are NOT copied —
  // with the intrinsic size unknown (broken image) there is no
  // width/height attribute at all, and CSS decides.
  await expect(image).not.toHaveAttribute("width", /.+/);
  await expect(image).not.toHaveAttribute("height", /.+/);

  const cta = dialog.locator("[data-iklan-popup-cta]");
  await expect(cta).toBeVisible();
  await expect(cta).toHaveText("Buka iklan");
  await expect(cta).toHaveAttribute("href", href!);
  await expect(cta).toHaveAttribute("rel", "sponsored noopener");
  await expect(cta).toHaveAttribute("target", "_blank");
  await expect(dialog.locator("[data-iklan-popup-status]")).toBeHidden();

  // Scroll locked while open.
  await expect(page.locator("body")).toHaveClass(/iklan-popup-open/);
  // Focus starts on the close button.
  await expect(dialog.locator("[data-iklan-popup-close]")).toBeFocused();
});

test("Escape closes the dialog, unlocks scrolling, and returns focus to the trigger", async ({ page }) => {
  await page.goto(ARTICLE);

  const trigger = page.locator(LINKED_TRIGGER).first();
  await trigger.click();
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(dialog).toBeHidden();
  await expect(dialog).toHaveJSProperty("open", false);
  await expect(page.locator("body")).not.toHaveClass(/iklan-popup-open/);
  await expect(trigger).toBeFocused();
});

test("the close button and the backdrop each close it, and focus returns to the trigger both ways", async ({
  page
}) => {
  await page.goto(ARTICLE);

  const trigger = page.locator(LINKED_TRIGGER).first();
  const dialog = page.locator(DIALOG);

  await trigger.click();
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-iklan-popup-close]").click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  // Reopen, then click the backdrop: a click whose target is the `<dialog>`
  // element itself can only have landed on `::backdrop` (every control
  // sits inside `.iklan-popup-body`), so click the viewport's top-left
  // corner, which the centred dialog never covers.
  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("an unlinked creative opens the same dialog with the CTA hidden and the no-destination message shown", async ({
  page
}) => {
  await page.goto(ARTICLE);

  const trigger = page.locator(UNLINKED_TRIGGER).first();
  await expect(trigger).toBeVisible();
  // The unlinked shape is a real button, never an anchor with no href.
  expect(await trigger.evaluate((el) => el.tagName)).toBe("BUTTON");

  await trigger.click();

  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-iklan-popup-name]")).toHaveText("Koperasi Sampit — Tanpa Tautan");
  // `standard` has no disclosure label: the slot's own "Iklan" is shown.
  await expect(dialog.locator("[data-iklan-popup-label]")).toHaveText("Iklan");

  const status = dialog.locator("[data-iklan-popup-status]");
  await expect(status).toBeVisible();
  await expect(status).toHaveText("Iklan ini belum memiliki tautan tujuan");

  const cta = dialog.locator("[data-iklan-popup-cta]");
  await expect(cta).toBeHidden();
  await expect(cta).not.toHaveAttribute("href", /.+/);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("one shared dialog is reused across creatives, re-filled each time", async ({ page }) => {
  await page.goto(ARTICLE);
  const dialog = page.locator(DIALOG);

  await page.locator(LINKED_TRIGGER).first().click();
  await expect(dialog.locator("[data-iklan-popup-cta]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.locator(UNLINKED_TRIGGER).first().click();
  await expect(dialog.locator("[data-iklan-popup-status]")).toBeVisible();
  await expect(dialog.locator("[data-iklan-popup-cta]")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.locator(LINKED_TRIGGER).first().click();
  await expect(dialog.locator("[data-iklan-popup-cta]")).toBeVisible();
  await expect(dialog.locator("[data-iklan-popup-status]")).toBeHidden();

  await expect(page.locator(DIALOG)).toHaveCount(1);
});

test("a modifier-click on a linked creative is left to the browser (no popup)", async ({ page, context }) => {
  await page.goto(ARTICLE);

  // Whatever the browser does with the (unresolvable example.test) tab it
  // opens is its own business — closed as soon as it appears; what this
  // module promises is only that it does NOT intercept a modified click.
  context.on("page", (opened) => {
    void opened.close();
  });

  const trigger = page.locator(LINKED_TRIGGER).first();
  await trigger.click({ modifiers: ["ControlOrMeta"] });

  await expect(page).toHaveURL(new RegExp(`${ARTICLE}$`));
  await expect(page.locator(DIALOG)).toHaveCount(0);
});
