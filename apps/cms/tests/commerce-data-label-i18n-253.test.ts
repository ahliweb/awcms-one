/**
 * Issue #253 — `admin.css` renders each cell's column name on stacked tables
 * at 767px and below through `content: attr(data-label)`. Every commerce
 * admin table but `commerce-pos.astro` (the one screen that already used
 * `t()` for its `data-label`s) set `data-label="Status"`/`"Customer"`/
 * `"Created"`/etc. as bare English literals, so a phone-width operator on an
 * Indonesian admin saw untranslated column names even though the table's own
 * `<th>` header was correctly translated.
 *
 * The fix: `data-label={t("…")}` on every cell of every commerce admin
 * table, reusing the exact msgid the matching `<th>` in the same table
 * already calls `t()` with, so the stacked label always equals the column
 * header. Two cells (`commerce.astro`'s checkbox-select column, whose header
 * has no visible text, and `commerce-affiliates.astro`'s commission-table
 * first column, whose header is a status filter `<select>` rather than a
 * plain label) needed a msgid that does not already sit on a `<th>` in the
 * same table — see the two `describe` blocks below for what each one uses.
 *
 * Pure — reads source files only, no database, no network.
 *
 * ## What this test pins
 *
 * 1. **No commerce admin screen writes a literal `data-label="…"` again.**
 *    `LITERAL_DATA_LABEL` below is the regression guard: any commerce screen
 *    (this repo's own module — upstream `awcms`'s non-commerce admin screens
 *    are deliberately out of scope, see `AGENTS.md`'s subtree rules) that
 *    reintroduces a bare string here is caught, whether it is a screen this
 *    issue touched or a new one added later.
 * 2. **Every screen still calls `t()` on at least one `data-label`,** so the
 *    regex above cannot pass this test by having simply deleted every
 *    `data-label` attribute instead of translating it.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

/** Matches a `data-label` attribute whose value is a bare double-quoted
 * string rather than a `{t("…")}` (or any other `{…}`) expression — the
 * pattern this issue forbids on every commerce admin screen. */
const LITERAL_DATA_LABEL = /data-label="[^"]*"/;

/** Matches a translated `data-label` — the pattern every commerce table cell
 * must use instead. */
const TRANSLATED_DATA_LABEL = /data-label=\{t\(/;

const COMMERCE_ADMIN_PAGES = [
  "src/pages/admin/commerce.astro",
  "src/pages/admin/commerce-affiliates.astro",
  "src/pages/admin/commerce-campaigns.astro",
  "src/pages/admin/commerce-categories.astro",
  "src/pages/admin/commerce-customers.astro",
  "src/pages/admin/commerce-dashboard.astro",
  "src/pages/admin/commerce-flash-sales.astro",
  "src/pages/admin/commerce-inbox.astro",
  "src/pages/admin/commerce-orders.astro",
  "src/pages/admin/commerce-orders/[id].astro",
  "src/pages/admin/commerce-popup.astro",
  "src/pages/admin/commerce-pos.astro",
  "src/pages/admin/commerce-reports.astro",
  "src/pages/admin/commerce-reviews.astro",
  "src/pages/admin/commerce-settings.astro",
  "src/pages/admin/commerce-sliders.astro",
  "src/pages/admin/commerce-testimonials.astro",
  "src/pages/admin/commerce-vouchers.astro",
  "src/pages/admin/commerce-whatsapp.astro"
];

describe("every commerce admin screen's data-label is translated, never a literal", () => {
  for (const page of COMMERCE_ADMIN_PAGES) {
    test(`${page} has no literal data-label="…" attribute`, async () => {
      const source = await readFile(page, "utf8");
      expect(LITERAL_DATA_LABEL.test(source)).toBe(false);
    });

    test(`${page} carries at least one data-label={t("…")}`, async () => {
      const source = await readFile(page, "utf8");
      expect(TRANSLATED_DATA_LABEL.test(source)).toBe(true);
    });
  }
});

describe("commerce.astro — the checkbox-select column reuses the existing 'Select' msgid", () => {
  test('the row checkbox cell is data-label={t("Select")}, not a new msgid', async () => {
    const source = await readFile("src/pages/admin/commerce.astro", "utf8");
    expect(source).toContain('data-label={t("Select")}');
  });
});

describe("commerce-affiliates.astro — the two tables' msgids match what each column actually shows", () => {
  test('the affiliate-rate cell reuses the header\'s own "Rate (%)" msgid, not a shorter "Rate"', async () => {
    const source = await readFile(
      "src/pages/admin/commerce-affiliates.astro",
      "utf8"
    );
    expect(source).toContain('data-label={t("Rate (%)")}');
    expect(source).not.toContain('data-label={t("Rate")}');
  });

  test('the commission table\'s first column is data-label={t("Affiliate")} — its <th> is a status filter, not a plain header, so this cell needed its own new msgid', async () => {
    const source = await readFile(
      "src/pages/admin/commerce-affiliates.astro",
      "utf8"
    );
    expect(source).toContain('data-label={t("Affiliate")}');
  });
});
