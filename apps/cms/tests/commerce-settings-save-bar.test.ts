/**
 * Contract test for the commerce-owned sticky save bar (Issue #244):
 * `CommerceSettingsSaveBar.astro` + `commerce-settings-save-bar-client.ts`,
 * ported from `media-lenterakalteng`'s `SettingsSaveBar` (that fork's
 * ADR-0124) into this module's own `src/components/`. Pins the PURE client
 * logic (no DOM needed), a handful of static properties the component's
 * markup must keep (no-JS-safe buttons, no inline style/script), and how
 * `commerce-settings.astro` adopts it — one submit control per form, the
 * bar reached through the shared lookup rather than a removed inline
 * button, and each bar wrapped so it stays sticky only within its own
 * section (never two bars fighting over the same sticky slot).
 *
 * Also pins the webhook-endpoints table's `data-table`/`data-table--stack`
 * adoption (same issue, item 4): the scroll wrapper, `data-label` cells,
 * and an empty state, matching every other commerce table.
 *
 * Pure — no database, no network. Runs in `quality` on every PR.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import {
  DIRTY_CLASS,
  resolveStatusText,
  SAVE_BAR_SELECTOR
} from "../src/lib/ui/commerce-settings-save-bar-client";

const COMPONENT = "src/components/CommerceSettingsSaveBar.astro";
const CLIENT = "src/lib/ui/commerce-settings-save-bar-client.ts";
const PAGE = "src/pages/admin/commerce-settings.astro";

describe("resolveStatusText", () => {
  test("picks the dirty label while dirty", () => {
    expect(resolveStatusText(true, "Unsaved changes", "Saved")).toBe(
      "Unsaved changes"
    );
  });

  test("picks the clean label while clean", () => {
    expect(resolveStatusText(false, "Unsaved changes", "Saved")).toBe("Saved");
  });

  test("a missing label on the active side answers null rather than the word 'undefined'", () => {
    expect(resolveStatusText(true, undefined, "Saved")).toBeNull();
    expect(resolveStatusText(false, "Unsaved changes", undefined)).toBeNull();
  });

  test("both labels missing answers null on either side", () => {
    expect(resolveStatusText(true, undefined, undefined)).toBeNull();
    expect(resolveStatusText(false, undefined, undefined)).toBeNull();
  });
});

describe("commerce-settings-save-bar-client.ts — exported constants", () => {
  test("the selector matches the component's own data attribute", () => {
    expect(SAVE_BAR_SELECTOR).toBe("[data-commerce-save-bar]");
  });

  test("the dirty class is the one the component's own <style> reacts to", async () => {
    expect(DIRTY_CLASS).toBe("is-dirty");

    const source = await readFile(COMPONENT, "utf8");
    expect(source).toContain(".commerce-save-bar.is-dirty");
  });
});

/**
 * Both the component's docblock and (in one test below) the page's own
 * script legitimately contain the substrings `<script>`/`<style>` in prose
 * (e.g. "the page's own `<script>`"), so the "no inline style/script" check
 * reads only the TEMPLATE half of the component — after the frontmatter's
 * closing `---` — never the leading comment.
 */
function templateOnly(source: string): string {
  const frontmatterEnd = source.indexOf("\n---\n", source.indexOf("---") + 1);
  return frontmatterEnd === -1 ? source : source.slice(frontmatterEnd);
}

describe("CommerceSettingsSaveBar.astro — static contract", () => {
  test("both buttons are plain HTML submit/reset controls, no JS required to submit", async () => {
    const source = await readFile(COMPONENT, "utf8");

    expect(source).toContain('type="submit"');
    expect(source).toContain('type="reset"');
    // `form={formId}` — reaches the form from OUTSIDE its own markup.
    expect(source).toContain("form={formId}");
  });

  test("carries no inline style or script (CSP: styles/scripts are external only)", async () => {
    const source = await readFile(COMPONENT, "utf8");
    const template = templateOnly(source);

    expect(template).not.toContain("style=");
    expect(template).not.toMatch(/<script/);
    // The component's OWN scoped <style> block is expected; only an
    // inline `style=` attribute or a second, nested <style> would be a
    // regression, and this file has exactly one <style> block.
    expect(template.match(/<style/g)?.length ?? 0).toBe(1);
  });

  test("reuses the shared .btn/.btn-primary button classes rather than a bespoke button", async () => {
    const source = await readFile(COMPONENT, "utf8");

    expect(source).toContain('class="btn-primary commerce-save-bar-save"');
    expect(source).toContain('class="btn commerce-save-bar-reset"');
  });

  test("is a landmark region with an aria-label, separate from the form's own fields", async () => {
    const source = await readFile(COMPONENT, "utf8");

    expect(source).toContain('role="region"');
    expect(source).toContain("aria-label={ariaLabel ?? saveLabel}");
    expect(source).not.toContain('"Save changes"');
  });

  test("its own docblock documents props, a demo, and the sticky-within-its-section contract", async () => {
    const source = await readFile(COMPONENT, "utf8");

    expect(source).toContain("## Demo");
    expect(source).toContain("<CommerceSettingsSaveBar");
    expect(source).toContain("## Sticky within its own section");
  });
});

describe("commerce-settings-save-bar-client.ts — never hides or disables the buttons", () => {
  test("setDirty only ever toggles a class or swaps text — no `.disabled =` / `.hidden =` assignment", async () => {
    const source = await readFile(CLIENT, "utf8");

    expect(source).not.toMatch(/\.disabled\s*=/);
    expect(source).not.toMatch(/\.hidden\s*=/);
  });

  test("no beforeunload listener is ever attached — the docblock justifies the omission rather than leaving it silent", async () => {
    const source = await readFile(CLIENT, "utf8");

    expect(source).not.toContain('addEventListener("beforeunload"');
    expect(source).not.toContain("window.onbeforeunload");
    // The docblock discusses the decision by name — that is the point, not
    // a contradiction of the assertions above.
    expect(source).toContain("Deliberately no `beforeunload` warning");
  });

  test("exports the shared button lookup every adopter needs", async () => {
    const source = await readFile(CLIENT, "utf8");

    expect(source).toContain("export function commerceSaveBarButton(");
    expect(source).toContain('data-commerce-save-bar-form="${formId}"');
    expect(source).toContain(".commerce-save-bar-save");
  });
});

describe("/admin/commerce-settings — CommerceSettingsSaveBar adoption (Issue #244)", () => {
  test("the shared component and client module are imported and initialised", async () => {
    const page = await readFile(PAGE, "utf8");

    expect(page).toContain(
      'import CommerceSettingsSaveBar from "../../components/CommerceSettingsSaveBar.astro"'
    );
    expect(page).toContain('"../../lib/ui/commerce-settings-save-bar-client"');
    expect(page).toContain("commerceSaveBarButton");
    expect(page).toContain("initCommerceSettingsSaveBars();");
  });

  test("both settings forms render the bar against their own formId", async () => {
    const page = await readFile(PAGE, "utf8");

    expect(page).toContain('formId="store-settings-form"');
    expect(page).toContain('formId="commerce-features-form"');
  });

  test("neither settings form keeps a second, inline submit control", async () => {
    const page = await readFile(PAGE, "utf8");

    for (const formId of ["store-settings-form", "commerce-features-form"]) {
      const formStart = page.indexOf(`id="${formId}"`);
      const formEnd = page.indexOf("</form>", formStart);
      expect(formStart).toBeGreaterThan(-1);
      expect(formEnd).toBeGreaterThan(formStart);

      const formMarkup = page.slice(formStart, formEnd);
      expect(formMarkup).not.toContain('type="submit"');
    }
  });

  test("the webhook create-form is untouched — it keeps its own inline submit button", async () => {
    const page = await readFile(PAGE, "utf8");

    const formStart = page.indexOf('id="webhook-endpoint-create-form"');
    const formEnd = page.indexOf("</form>", formStart);
    expect(formStart).toBeGreaterThan(-1);
    expect(formEnd).toBeGreaterThan(formStart);

    const formMarkup = page.slice(formStart, formEnd);
    expect(formMarkup).toContain('type="submit"');
    expect(page).not.toContain('formId="webhook-endpoint-create-form"');
  });

  test("the store-settings bar is gated on the same canUpdate check the removed inline button used", async () => {
    const page = await readFile(PAGE, "utf8");

    const formIdIndex = page.indexOf('formId="store-settings-form"');
    expect(formIdIndex).toBeGreaterThan(-1);

    const guardWindow = page.slice(Math.max(0, formIdIndex - 120), formIdIndex);
    expect(guardWindow).toContain("<CommerceSettingsSaveBar");
    expect(guardWindow).toContain("canUpdate && (");
  });

  test("each bar sits inside a block ancestor that also holds its own form — sticky within its own section, not the whole page", async () => {
    const page = await readFile(PAGE, "utf8");

    // store-settings: a section this issue adds specifically to scope the
    // bar's stickiness (see the component's own docblock).
    const storeSectionStart = page.indexOf('id="store-settings-section"');
    const storeFormIndex = page.indexOf('id="store-settings-form"');
    const storeBarIndex = page.indexOf('formId="store-settings-form"');
    const storeSectionEnd = page.indexOf("</section>", storeBarIndex);
    expect(storeSectionStart).toBeGreaterThan(-1);
    expect(storeFormIndex).toBeGreaterThan(storeSectionStart);
    expect(storeBarIndex).toBeGreaterThan(storeFormIndex);
    expect(storeSectionEnd).toBeGreaterThan(storeBarIndex);

    // commerce-features: reuses the section the form already rendered
    // inside before this issue.
    const featuresSectionStart = page.indexOf('id="commerce-features-section"');
    const featuresFormIndex = page.indexOf('id="commerce-features-form"');
    const featuresBarIndex = page.indexOf('formId="commerce-features-form"');
    const featuresSectionEnd = page.indexOf("</section>", featuresBarIndex);
    expect(featuresSectionStart).toBeGreaterThan(-1);
    expect(featuresFormIndex).toBeGreaterThan(featuresSectionStart);
    expect(featuresBarIndex).toBeGreaterThan(featuresFormIndex);
    expect(featuresSectionEnd).toBeGreaterThan(featuresBarIndex);
  });

  test("the busy lock now targets each bar's own button, via the shared lookup — not a removed descendant", async () => {
    const page = await readFile(PAGE, "utf8");

    expect(page).toContain('commerceSaveBarButton("store-settings-form")');
    expect(page).toContain('commerceSaveBarButton("commerce-features-form")');
    // The removed ids themselves may still appear in an explanatory comment
    // (documenting what this migrated FROM) — what must be gone is the
    // element lookup by that id, i.e. no `id="store-settings-submit"` on
    // any element left in the markup.
    expect(page).not.toContain('id="store-settings-submit"');
    expect(page).not.toContain('id="commerce-features-submit"');
  });

  test("the page never writes raw SQL — every mutation still posts to a guarded endpoint", async () => {
    const page = await readFile(PAGE, "utf8");

    expect(page).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+awcms_|DELETE\s+FROM)/i
    );
    expect(page).toContain('"/api/v1/commerce/store-settings"');
    expect(page).toContain('"/api/v1/tenant/modules/commerce/settings"');
  });
});

describe("/admin/commerce-settings — webhook endpoints table stacks on mobile (Issue #244)", () => {
  test("the table joins the shared data-table/data-table--stack convention, with its scroll wrapper", async () => {
    const page = await readFile(PAGE, "utf8");

    const tableIndex = page.indexOf('id="webhook-endpoints-table"');
    expect(tableIndex).toBeGreaterThan(-1);

    const aroundTable = page.slice(
      page.lastIndexOf("<div", tableIndex),
      tableIndex + 200
    );
    expect(aroundTable).toContain('class="data-table-scroll fade-in-up"');
    expect(aroundTable).toContain('class="data-table data-table--stack"');
  });

  test("every data cell carries a data-label for the stacked mobile layout", async () => {
    const page = await readFile(PAGE, "utf8");

    for (const label of ["Provider", "Label", "Created", "Status", "Action"]) {
      expect(page).toContain(`data-label="${label}"`);
    }
  });

  test("the action cell wraps its button in .row-actions and is marked stacked-block, like every other commerce table", async () => {
    const page = await readFile(PAGE, "utf8");

    const actionCellIndex = page.indexOf(
      'data-label="Action" class="stacked-block"'
    );
    expect(actionCellIndex).toBeGreaterThan(-1);

    const cellMarkup = page.slice(actionCellIndex, actionCellIndex + 400);
    expect(cellMarkup).toContain('class="row-actions"');
    expect(cellMarkup).toContain("js-revoke-webhook-endpoint");
  });

  test("an empty tenant sees an empty state, not a bare table with a caption and no rows", async () => {
    const page = await readFile(PAGE, "utf8");

    expect(page).toContain("webhookEndpoints.length === 0");
    expect(page).toContain('class="data-table-empty"');
    expect(page).toContain('class="empty-state"');
    expect(page).toContain("No webhook endpoints yet");
  });

  test("the caption reports a real count via the plural translator, not a hard-coded label", async () => {
    const page = await readFile(PAGE, "utf8");

    const captionIndex = page.indexOf("<caption>");
    const captionEnd = page.indexOf("</caption>", captionIndex);
    expect(captionIndex).toBeGreaterThan(-1);

    const captionMarkup = page.slice(captionIndex, captionEnd);
    expect(captionMarkup).toContain("{count} webhook endpoint");
    expect(captionMarkup).toContain("{count} webhook endpoints");
    expect(captionMarkup).toContain("webhookEndpoints.length");
  });
});
