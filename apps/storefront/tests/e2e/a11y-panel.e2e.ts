/**
 * The public reading-preferences panel (issue #539, ADR-0057) in a real
 * browser, against the real build of the active profile: it opens and closes
 * the way a keyboard user expects, every preference puts its attribute on
 * `<html>` and survives a reload, the OS defaults apply while nothing is
 * stored, forced colours are left alone, a blocked `localStorage` never breaks
 * the page, nothing is sent over the network, and axe finds no serious or
 * critical violation with the panel open or high contrast on.
 *
 * `aksesibilitas.e2e.ts` keeps scanning every key page with the panel closed;
 * this file is the panel's own coverage. It runs once per `SITE_PROFILE`
 * (`local-ci/e2e-toko`, `-berita`, `-landing`), because the panel is mounted by
 * the shared layout and must exist on all three.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ACTIVE_PROFILE, KEY_PAGES } from "./profil-halaman";

const KEY = "awcms-a11y";
const HOME = KEY_PAGES[0]!.path;

/**
 * The tags `aksesibilitas.e2e.ts` uses for whole pages (WCAG 2.1 A/AA). The site's own chrome
 * is not yet held to 2.2's target-size rule (a few small footer links), so a whole-page scan
 * stays on 2.1; the panel itself is held to 2.2 AA through {@link axePanel}.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const PANEL_TAGS = [...WCAG_TAGS, "wcag22aa"];
const FAILING_IMPACT = new Set(["serious", "critical"]);

const SWITCHES = [
  { key: "contrast", attribute: "data-a11y-contrast", value: "" },
  { key: "mono", attribute: "data-a11y-mono", value: "" },
  { key: "dyslexia", attribute: "data-a11y-dyslexia", value: "" },
  { key: "underline", attribute: "data-a11y-underline", value: "" },
  { key: "highlight", attribute: "data-a11y-highlight", value: "" },
  { key: "motion", attribute: "data-a11y-motion", value: "reduce" }
] as const;

const fab = (page: Page) => page.locator("#a11y-fab");
const panel = (page: Page) => page.locator("#a11y-panel");
const toggle = (page: Page, key: string) => page.locator(`[data-a11y-switch="${key}"]`);

async function openPanel(page: Page): Promise<void> {
  await fab(page).click();
  await expect(panel(page)).toBeVisible();
}

const htmlAttribute = (page: Page, name: string) => page.evaluate((n) => document.documentElement.getAttribute(n), name);
const stored = (page: Page) => page.evaluate((k) => window.localStorage.getItem(k), KEY);
/** A custom property's value as a 6-digit lowercase hex (the build minifies `#000000` to `#000`). */
const token = (page: Page, name: string) =>
  page.evaluate((n) => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase();
    return /^#[0-9a-f]{3}$/.test(value) ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}` : value;
  }, name);

function describeViolations(violations: Array<{ impact?: string | null; id: string; help: string; nodes: Array<{ target: unknown[] }> }>): string {
  return violations
    .map((v) => `- [${v.impact}] ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`)
    .join("\n");
}

async function axeSerious(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const serious = results.violations.filter((v) => FAILING_IMPACT.has(v.impact ?? ""));
  expect(serious, `${label}: serious/critical violations\n${describeViolations(serious)}`).toHaveLength(0);
}

/** The panel (button and dialog) alone, against WCAG 2.2 AA — any impact, not only serious/critical. */
async function axePanel(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include("[data-a11y-root]").withTags(PANEL_TAGS).analyze();
  expect(results.violations, `${label}: panel violations\n${describeViolations(results.violations)}`).toHaveLength(0);
}

test.describe(`${ACTIVE_PROFILE}: reading-preferences panel`, () => {
  // The store home page opens a promotional popup (a modal <dialog>) once per day, which would
  // sit on top of the panel and swallow the clicks; this file is about the panel, so every page
  // starts as a visitor who has already seen it (`src/scripts/promo-popup.ts`'s own storage keys).
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const original = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key: string) {
        if (typeof key === "string" && key.startsWith("awcms-one:popup:")) {
          return this === window.localStorage ? new Date().toISOString() : "1";
        }
        return original.call(this, key);
      };
    });
  });

  test("the button is revealed by script, named, and the dialog starts closed", async ({ page }) => {
    await page.goto(HOME);
    await expect(fab(page)).toBeVisible();
    await expect(fab(page)).toHaveAttribute("aria-label", "Pengaturan aksesibilitas");
    await expect(fab(page)).toHaveAttribute("aria-expanded", "false");
    await expect(fab(page)).toHaveAttribute("aria-controls", "a11y-panel");
    await expect(panel(page)).toBeHidden();

    const box = await fab(page).boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    // Bottom, at the inline start (left in LTR).
    const viewport = page.viewportSize()!;
    expect(box!.x).toBeLessThan(viewport.width / 4);
    expect(box!.y + box!.height).toBeGreaterThan(viewport.height * 0.75);
  });

  test("without JavaScript the button and dialog are not offered", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(HOME);
    await expect(page.locator("#a11y-fab")).toBeHidden();
    await expect(page.locator("#a11y-panel")).toBeHidden();
    await context.close();
  });

  test("opening moves focus into the dialog; Escape closes it and returns focus to the button", async ({ page }) => {
    await page.goto(HOME);
    await fab(page).focus();
    await page.keyboard.press("Enter");

    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute("role", "dialog");
    await expect(panel(page)).not.toHaveAttribute("aria-modal", /.*/);
    await expect(fab(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#a11y-title")).toBeFocused();
    await expect(panel(page)).toHaveAccessibleName("Pengaturan Aksesibilitas");

    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
    await expect(fab(page)).toBeFocused();
    await expect(fab(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("the close button and a press outside both close the dialog", async ({ page }) => {
    await page.goto(HOME);

    await openPanel(page);
    await page.locator("[data-a11y-close]").click();
    await expect(panel(page)).toBeHidden();
    await expect(fab(page)).toBeFocused();

    await openPanel(page);
    await page.locator("body").dispatchEvent("pointerdown");
    await expect(panel(page)).toBeHidden();
  });

  test("the button toggles the dialog", async ({ page }) => {
    await page.goto(HOME);
    await openPanel(page);
    await fab(page).click();
    await expect(panel(page)).toBeHidden();
  });

  test("every switch sets its attribute, is keyboard-operable, and persists across a reload", async ({ page }) => {
    await page.goto(HOME);
    await openPanel(page);

    for (const { key, attribute, value } of SWITCHES) {
      const control = toggle(page, key);
      await expect(control).toHaveAttribute("role", "switch");
      await expect(control).toHaveAttribute("aria-checked", "false");
      await expect(control).toHaveAccessibleName(/\S/);

      await control.focus();
      await page.keyboard.press("Space");
      await expect(control).toHaveAttribute("aria-checked", "true");
      expect(await htmlAttribute(page, attribute)).toBe(value);
    }

    const saved = JSON.parse((await stored(page))!);
    expect(saved).toEqual({
      v: 1,
      text: "normal",
      contrast: true,
      mono: true,
      dyslexia: true,
      underline: true,
      highlight: true,
      motion: true
    });

    await page.reload();
    for (const { attribute, value } of SWITCHES) {
      expect(await htmlAttribute(page, attribute)).toBe(value);
    }
    await openPanel(page);
    for (const { key } of SWITCHES) await expect(toggle(page, key)).toHaveAttribute("aria-checked", "true");

    // Turning one back off removes just its attribute.
    await toggle(page, "mono").click();
    await expect(toggle(page, "mono")).toHaveAttribute("aria-checked", "false");
    expect(await htmlAttribute(page, "data-a11y-mono")).toBeNull();
    expect(await htmlAttribute(page, "data-a11y-contrast")).toBe("");
  });

  test("text size is a radio group: large and extra large set the attribute and scale the text", async ({ page }) => {
    await page.goto(HOME);
    await openPanel(page);

    const group = page.getByRole("group", { name: "Ukuran teks" });
    await expect(group.getByRole("radio")).toHaveCount(3);
    await expect(group.getByRole("radio", { name: "Normal" })).toBeChecked();

    const rootSize = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const normal = await rootSize();

    await group.getByRole("radio", { name: "Besar", exact: true }).check({ force: true });
    expect(await htmlAttribute(page, "data-a11y-text")).toBe("large");
    expect(await rootSize()).toBeCloseTo(normal * 1.2, 1);

    await group.getByRole("radio", { name: "Sangat besar" }).check({ force: true });
    expect(await htmlAttribute(page, "data-a11y-text")).toBe("x-large");
    expect(await rootSize()).toBeCloseTo(normal * 1.4, 1);

    expect(JSON.parse((await stored(page))!).text).toBe("x-large");
    await page.reload();
    expect(await htmlAttribute(page, "data-a11y-text")).toBe("x-large");

    await openPanel(page);
    await group.getByRole("radio", { name: "Normal" }).check({ force: true });
    expect(await htmlAttribute(page, "data-a11y-text")).toBeNull();
  });

  test("the radio group is keyboard operable with the arrow keys", async ({ page }) => {
    await page.goto(HOME);
    await openPanel(page);
    const group = page.getByRole("group", { name: "Ukuran teks" });
    await group.getByRole("radio", { name: "Normal" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: "Besar", exact: true })).toBeChecked();
    expect(await htmlAttribute(page, "data-a11y-text")).toBe("large");
  });

  test("Reset removes the stored value and every attribute", async ({ page }) => {
    await page.goto(HOME);
    await openPanel(page);
    for (const { key } of SWITCHES) await toggle(page, key).click();
    await page.getByRole("radio", { name: "Besar", exact: true }).check({ force: true });
    expect(await stored(page)).not.toBeNull();

    await page.getByRole("button", { name: "Reset ke standar" }).click();

    expect(await stored(page)).toBeNull();
    for (const name of [
      "data-a11y-text",
      "data-a11y-contrast",
      "data-a11y-mono",
      "data-a11y-dyslexia",
      "data-a11y-underline",
      "data-a11y-highlight",
      "data-a11y-motion",
      "data-a11y-user"
    ]) {
      expect(await htmlAttribute(page, name)).toBeNull();
    }
    for (const { key } of SWITCHES) await expect(toggle(page, key)).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("radio", { name: "Normal" })).toBeChecked();
  });

  test("a change dispatches awcms-a11y-change with the effective preferences", async ({ page }) => {
    await page.goto(HOME);
    await page.evaluate(() => {
      (window as unknown as { __a11yEvents: unknown[] }).__a11yEvents = [];
      document.addEventListener("awcms-a11y-change", (event) =>
        (window as unknown as { __a11yEvents: unknown[] }).__a11yEvents.push((event as CustomEvent).detail)
      );
    });
    await openPanel(page);
    await toggle(page, "underline").click();
    const events = await page.evaluate(() => (window as unknown as { __a11yEvents: Array<Record<string, unknown>> }).__a11yEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ v: 1, underline: true, contrast: false });
  });

  test("the preferences have real effects: underline, highlight, dyslexia spacing, monochrome", async ({ page }) => {
    await page.goto(HOME);
    await openPanel(page);

    const link = page.locator("main a[href]").first();
    await toggle(page, "underline").click();
    await expect(link).toHaveCSS("text-decoration-line", "underline");

    await toggle(page, "highlight").click();
    await expect(link).toHaveCSS("background-color", "rgb(255, 235, 59)");
    await expect(link).toHaveCSS("color", "rgb(17, 17, 17)");

    await toggle(page, "dyslexia").click();
    const body = page.locator("body");
    await expect(body).toHaveCSS("word-spacing", /^[\d.]+px$/);
    expect(await body.evaluate((el) => parseFloat(getComputedStyle(el).wordSpacing))).toBeGreaterThan(0);
    expect(await body.evaluate((el) => parseFloat(getComputedStyle(el).letterSpacing))).toBeGreaterThan(0);

    await toggle(page, "mono").click();
    await expect(page.locator("html")).toHaveCSS("filter", "grayscale(1)");
    await expect(page.locator("body")).toHaveCSS("filter", "none");
  });

  test("monochrome keeps the floating button fixed", async ({ page }) => {
    await page.goto(HOME);
    const before = (await fab(page).boundingBox())!;
    await openPanel(page);
    await toggle(page, "mono").click();
    await fab(page).click(); // close
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const after = (await fab(page).boundingBox())!;
    expect(after.y).toBeCloseTo(before.y, 0);
    expect(after.x).toBeCloseTo(before.x, 0);
  });

  test("high contrast replaces the colour tokens, beating the brand tokens", async ({ page }) => {
    await page.goto(HOME);
    const before = await token(page, "--color-primary");
    expect(await token(page, "--text-primary")).not.toBe("#000000");

    await openPanel(page);
    await toggle(page, "contrast").click();
    expect(await token(page, "--text-primary")).toBe("#000000");
    expect(await token(page, "--border-color")).toBe("#000000");
    expect(await token(page, "--color-primary")).toBe("#003a8c");
    expect(await token(page, "--color-primary")).not.toBe(before);
  });

  test("with nothing stored the OS decides: reduced motion and prefers-contrast mirror into the switches", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", contrast: "more" });
    await page.goto(HOME);
    expect(await stored(page)).toBeNull();
    expect(await htmlAttribute(page, "data-a11y-user")).toBeNull();
    expect(await token(page, "--text-primary")).toBe("#000000");

    await openPanel(page);
    await expect(toggle(page, "motion")).toHaveAttribute("aria-checked", "true");
    await expect(toggle(page, "contrast")).toHaveAttribute("aria-checked", "true");
    await expect(toggle(page, "mono")).toHaveAttribute("aria-checked", "false");
  });

  test("an explicit 'off' overrides the OS default", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", contrast: "more" });
    await page.goto(HOME);
    await openPanel(page);
    await toggle(page, "contrast").click(); // on -> off
    await expect(toggle(page, "contrast")).toHaveAttribute("aria-checked", "false");
    expect(await htmlAttribute(page, "data-a11y-user")).toBe("");
    expect(await token(page, "--text-primary")).not.toBe("#000000");

    await page.reload();
    expect(await token(page, "--text-primary")).not.toBe("#000000");
  });

  test("forced colours are never fought: the palette is not applied under forced-colors: active", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto(HOME);
    const original = await token(page, "--text-primary");
    await openPanel(page);
    await toggle(page, "contrast").click();
    expect(await htmlAttribute(page, "data-a11y-contrast")).toBe("");
    expect(await token(page, "--text-primary")).toBe(original);
    expect(original).not.toBe("#000000");
  });

  test("the news ticker's pulse stops when 'Kurangi gerakan' is on", async ({ page }) => {
    await page.goto(HOME);
    const dot = page.locator(".ticker-berita__titik");
    test.skip((await dot.count()) === 0, "this profile's home page has no news ticker");

    expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).not.toBe("none");
    await openPanel(page);
    await toggle(page, "motion").click();
    expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  });

  test("a throwing localStorage never breaks the page; the choice applies for this view", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const fail = () => {
        throw new DOMException("blocked", "SecurityError");
      };
      Storage.prototype.getItem = fail;
      Storage.prototype.setItem = fail;
      Storage.prototype.removeItem = fail;
    });

    await page.goto(HOME);
    // With storage throwing, the promotional popup cannot remember it was seen, so a profile
    // that has one shows it; close it so it does not sit over the panel.
    const promo = page.locator("dialog[data-promo-popup][open]");
    if (await promo.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false)) {
      await page.keyboard.press("Escape");
      await expect(promo).toHaveCount(0);
    }
    await expect(fab(page)).toBeVisible();
    await openPanel(page);
    await toggle(page, "underline").click();
    expect(await htmlAttribute(page, "data-a11y-underline")).toBe("");
    await page.getByRole("button", { name: "Reset ke standar" }).click();
    expect(await htmlAttribute(page, "data-a11y-underline")).toBeNull();
    expect(errors).toEqual([]);
  });

  test("a corrupt stored value is ignored", async ({ page }) => {
    await page.addInitScript((key) => window.localStorage.setItem(key, '{"v":1,"text":"huge"}'), KEY);
    await page.goto(HOME);
    expect(await htmlAttribute(page, "data-a11y-user")).toBeNull();
    expect(await htmlAttribute(page, "data-a11y-text")).toBeNull();
    await expect(fab(page)).toBeVisible();
  });

  test("nothing is sent over the network when preferences change", async ({ page }) => {
    await page.goto(HOME);
    await page.waitForLoadState("networkidle");
    const requests: string[] = [];
    page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));

    await openPanel(page);
    for (const { key } of SWITCHES) await toggle(page, key).click();
    await page.getByRole("radio", { name: "Besar", exact: true }).check({ force: true });
    await page.getByRole("button", { name: "Reset ke standar" }).click();

    expect(requests).toEqual([]);
  });

  test("the floating button and dialog are not printed", async ({ page }) => {
    await page.goto(HOME);
    await openPanel(page);
    await page.emulateMedia({ media: "print" });
    await expect(fab(page)).toBeHidden();
    await expect(panel(page)).toBeHidden();
  });

  test("the focus ring is visible on the button and on a switch", async ({ page }) => {
    await page.goto(HOME);
    await fab(page).focus();
    await page.keyboard.press("Tab"); // keyboard modality, then back
    await page.keyboard.press("Shift+Tab");
    expect(await fab(page).evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");

    await openPanel(page);
    await toggle(page, "contrast").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    expect(await toggle(page, "contrast").evaluate((el) => getComputedStyle(el).outlineWidth)).not.toBe("0px");
  });

  test("axe finds no serious/critical violations with the panel open", async ({ page }) => {
    await page.goto(HOME);
    await openPanel(page);
    await axeSerious(page, `${HOME} with the panel open`);
    await axePanel(page, `${HOME} with the panel open`);
  });

  test("axe finds no serious/critical violations with the panel open and every switch on", async ({ page }) => {
    await page.goto(HOME);
    await openPanel(page);
    for (const { key } of SWITCHES) await toggle(page, key).click();
    await axeSerious(page, `${HOME} with the panel open and every switch on`);
    await axePanel(page, `${HOME} with the panel open and every switch on`);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe: every key page is clean with high contrast on (${scheme} scheme)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      // Stored once, so each page below starts with the choice already made (a toggle would flip it back off).
      await page.addInitScript(
        (key) =>
          window.localStorage.setItem(
            key,
            JSON.stringify({ v: 1, text: "normal", contrast: true, mono: false, dyslexia: false, underline: false, highlight: false, motion: false })
          ),
        KEY
      );
      for (const keyPage of KEY_PAGES) {
        await page.goto(keyPage.path);
        expect(await htmlAttribute(page, "data-a11y-contrast"), `${keyPage.path}: contrast attribute`).toBe("");
        await openPanel(page);
        await axePanel(page, `${keyPage.path} panel open, high contrast, ${scheme}`);
        await fab(page).click();
        await axeSerious(page, `${keyPage.path} high contrast, ${scheme}`);
      }
    });
  }

  test("the panel works at 360px with extra-large text: no horizontal scroll, the dialog scrolls inside itself", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(HOME);
    await openPanel(page);
    await page.getByRole("radio", { name: "Sangat besar" }).check({ force: true });

    const metrics = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>("#a11y-panel")!;
      const rect = dialog.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        innerHeight: window.innerHeight,
        panelOverflowsX: dialog.scrollWidth > dialog.clientWidth
      };
    });
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
    expect(metrics.left).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeLessThanOrEqual(metrics.innerWidth);
    expect(metrics.top).toBeGreaterThanOrEqual(0);
    expect(metrics.bottom).toBeLessThanOrEqual(metrics.innerHeight);
    expect(metrics.panelOverflowsX).toBe(false);

    // The reset control and the note are still reachable by scrolling inside the dialog.
    await page.getByRole("button", { name: "Reset ke standar" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Reset ke standar" })).toBeInViewport();
    await axeSerious(page, "panel at 360px, extra-large text");
    await axePanel(page, "panel at 360px, extra-large text");
  });

  test("the panel works at 200 % zoom (a 640px-wide viewport at double size)", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 400 });
    await page.goto(HOME);
    await openPanel(page);
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    await page.getByRole("button", { name: "Reset ke standar" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Reset ke standar" })).toBeInViewport();
  });

  for (const keyPage of KEY_PAGES) {
    for (const combination of [
      { name: "extra-large text", text: "Sangat besar", extra: [] as string[] },
      { name: "extra-large text and dyslexia spacing", text: "Sangat besar", extra: ["dyslexia"] }
    ]) {
      test(`${keyPage.name} (${keyPage.path}) has no horizontal overflow at 360px with ${combination.name}`, async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 800 });
        await page.goto(keyPage.path);
        await openPanel(page);
        await page.getByRole("radio", { name: combination.text }).check({ force: true });
        for (const key of combination.extra) await toggle(page, key).click();
        await fab(page).click();

        const { scrollWidth, innerWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth
        }));
        expect(
          scrollWidth,
          `${keyPage.path} at 360px with ${combination.name}: scrollWidth ${scrollWidth}px exceeds innerWidth ${innerWidth}px`
        ).toBeLessThanOrEqual(innerWidth);
      });
    }
  }
});
