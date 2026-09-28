/**
 * `CommerceConfirmDialog.astro` + `commerce-confirm-dialog-client.ts`
 * (Issue #242).
 *
 * Two kinds of coverage, deliberately kept apart:
 *
 *   1. The client module's PURE helpers — option normalization, note
 *      trimming/clamping, label/focus resolution — run with no DOM at all.
 *      `bun test`'s default environment has no `document`/`HTMLDialogElement`,
 *      which is exactly the condition `isDialogSupported()` is written to
 *      degrade gracefully under, so importing the whole module here and
 *      calling only these exports is itself a small proof that the module's
 *      top level touches no global the test runner does not provide.
 *   2. Static, source-text assertions over every screen this issue touched —
 *      the same "read the file, assert what its text contains" style
 *      `admin-commerce-marketing-page-contract.test.ts` already uses for this
 *      module's other screens. The full open/resolve dialog lifecycle
 *      (`showModal`, focus, Escape) needs a real browser and is exercised by
 *      Playwright, not here — see `awcms-browser-test`.
 *
 * Every source-text check below runs against `stripComments`-cleaned text,
 * not the raw file — this file's own docblocks (and this component's) say
 * "window.confirm" in prose more than once, and `scripts/lib/source-text.ts`'s
 * own header explains why a naive "does the raw file contain X" check is the
 * wrong tool once a file is allowed to talk about its own contract.
 *
 * Pure — no database, no network, no DOM.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { stripComments } from "../scripts/lib/source-text";
import {
  DEFAULT_DIALOG_ID,
  DEFAULT_NOTE_MAX_LENGTH,
  isDialogSupported,
  normalizeNote,
  readConfirmOptions,
  resolveDialogId,
  resolveFocusTarget,
  resolveLabel,
  resolveNoteMaxLength
} from "../src/lib/ui/commerce-confirm-dialog-client";

describe("resolveDialogId", () => {
  test("falls back to DEFAULT_DIALOG_ID for undefined", () => {
    expect(resolveDialogId(undefined)).toBe(DEFAULT_DIALOG_ID);
  });

  test("falls back to DEFAULT_DIALOG_ID for an empty or whitespace-only id", () => {
    expect(resolveDialogId("")).toBe(DEFAULT_DIALOG_ID);
    expect(resolveDialogId("   ")).toBe(DEFAULT_DIALOG_ID);
  });

  test("keeps a real, trimmed id", () => {
    expect(resolveDialogId("order-status-confirm-dialog")).toBe(
      "order-status-confirm-dialog"
    );
    expect(resolveDialogId("  padded-id  ")).toBe("padded-id");
  });
});

describe("resolveNoteMaxLength", () => {
  test("falls back to DEFAULT_NOTE_MAX_LENGTH (500) for undefined", () => {
    expect(resolveNoteMaxLength(undefined)).toBe(500);
    expect(DEFAULT_NOTE_MAX_LENGTH).toBe(500);
  });

  test("falls back for anything that is not a finite, positive number", () => {
    expect(resolveNoteMaxLength(Number.NaN)).toBe(500);
    expect(resolveNoteMaxLength(0)).toBe(500);
    expect(resolveNoteMaxLength(-20)).toBe(500);
    expect(resolveNoteMaxLength(Number.POSITIVE_INFINITY)).toBe(500);
  });

  test("floors a fractional ceiling and keeps a real one", () => {
    expect(resolveNoteMaxLength(250.9)).toBe(250);
    expect(resolveNoteMaxLength(1000)).toBe(1000);
  });
});

describe("normalizeNote", () => {
  test("trims a blank note to ''", () => {
    expect(normalizeNote("", 500)).toBe("");
    expect(normalizeNote("    ", 500)).toBe("");
  });

  test("trims surrounding whitespace off a real note", () => {
    expect(normalizeNote("  Refunded by courier  ", 500)).toBe(
      "Refunded by courier"
    );
  });

  test("clamps to the resolved max length after trimming", () => {
    expect(normalizeNote("abcdefgh", 3)).toBe("abc");
    expect(normalizeNote("  abcdefgh  ", 3)).toBe("abc");
  });

  test("clamps against the default ceiling when maxLength is omitted", () => {
    const tooLong = "x".repeat(600);
    expect(normalizeNote(tooLong, undefined)).toHaveLength(500);
  });
});

describe("resolveLabel", () => {
  test("a non-blank custom label wins", () => {
    expect(resolveLabel("Ya, hapus", "Confirm")).toBe("Ya, hapus");
  });

  test("a blank or whitespace-only custom label falls back", () => {
    expect(resolveLabel(undefined, "Confirm")).toBe("Confirm");
    expect(resolveLabel("", "Confirm")).toBe("Confirm");
    expect(resolveLabel("   ", "Confirm")).toBe("Confirm");
  });

  test("trims a real custom label", () => {
    expect(resolveLabel("  Delete product  ", "Confirm")).toBe(
      "Delete product"
    );
  });
});

describe("resolveFocusTarget", () => {
  test("a danger action focuses the safe control (Cancel)", () => {
    expect(resolveFocusTarget(true)).toBe("cancel");
  });

  test("a non-danger action focuses Confirm", () => {
    expect(resolveFocusTarget(false)).toBe("confirm");
    expect(resolveFocusTarget(undefined)).toBe("confirm");
  });
});

describe("isDialogSupported", () => {
  test("reports false rather than throwing when there is no DOM (this test runner)", () => {
    // `bun test`'s default environment has no `HTMLDialogElement` global. This
    // is the same condition `confirmCommerceAction` falls back to
    // `window.confirm` under in a real, unsupporting browser — proving the
    // check degrades instead of throwing is the point of this test.
    expect(isDialogSupported()).toBe(false);
  });
});

describe("readConfirmOptions", () => {
  test("maps a fully-populated data-confirm-* dataset", () => {
    expect(
      readConfirmOptions({
        confirmTitle: "Delete this product?",
        confirmMessage: "Product SKU-1 will be moved to trash.",
        confirmLabel: "Delete product",
        confirmDanger: "true",
        confirmDialogId: "other-dialog"
      })
    ).toEqual({
      title: "Delete this product?",
      message: "Product SKU-1 will be moved to trash.",
      confirmLabel: "Delete product",
      danger: true,
      dialogId: "other-dialog"
    });
  });

  test("a missing confirmMessage degrades to '' rather than throwing", () => {
    expect(readConfirmOptions({}).message).toBe("");
  });

  test("danger is true only for the literal string 'true' — absent, empty, or any other value is not danger", () => {
    expect(readConfirmOptions({ confirmMessage: "x" }).danger).toBe(false);
    expect(
      readConfirmOptions({ confirmMessage: "x", confirmDanger: "false" }).danger
    ).toBe(false);
    expect(
      readConfirmOptions({ confirmMessage: "x", confirmDanger: "" }).danger
    ).toBe(false);
    expect(
      readConfirmOptions({ confirmMessage: "x", confirmDanger: "true" }).danger
    ).toBe(true);
  });

  test("title/confirmLabel/dialogId pass through undefined when the attribute is absent", () => {
    const opts = readConfirmOptions({ confirmMessage: "x" });
    expect(opts.title).toBeUndefined();
    expect(opts.confirmLabel).toBeUndefined();
    expect(opts.dialogId).toBeUndefined();
  });
});

/** The ten screens Issue #242 moved off `window.confirm`. */
const TARGET_SCREENS = [
  "src/pages/admin/commerce-categories.astro",
  "src/pages/admin/commerce-campaigns.astro",
  "src/pages/admin/commerce-affiliates.astro",
  "src/pages/admin/commerce-popup.astro",
  "src/pages/admin/commerce.astro",
  "src/pages/admin/commerce-reviews.astro",
  "src/pages/admin/commerce-sliders.astro",
  "src/pages/admin/commerce-testimonials.astro",
  "src/pages/admin/commerce-vouchers.astro",
  "src/pages/admin/commerce-flash-sales.astro"
] as const;

/**
 * Explicitly out of scope for this issue — a different agent owns them.
 * `commerce-orders.astro` was picked up by Issue #246 (order-status confirm
 * + note) and now DOES render `CommerceConfirmDialog` — see
 * `commerce-orders-confirm-note-246.test.ts` for its own contract. Only
 * `commerce-settings.astro` remains untouched here.
 */
const UNTOUCHED_SCREENS = ["src/pages/admin/commerce-settings.astro"] as const;

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

/** The file's CODE — comments and docblocks stripped, so prose that merely
 *  mentions `window.confirm(` or `<CommerceConfirmDialog` cannot be mistaken
 *  for a real call/render, and cannot hide a real one either. */
async function readCode(path: string): Promise<string> {
  return stripComments(await readFile(path, "utf8"));
}

describe("the ten target screens", () => {
  for (const screen of TARGET_SCREENS) {
    describe(screen, () => {
      test("has no window.confirm( call left", async () => {
        const code = await readCode(screen);
        expect(code).not.toContain("window.confirm(");
      });

      test("imports CommerceConfirmDialog exactly once", async () => {
        const code = await readCode(screen);
        expect(
          occurrences(
            code,
            'import CommerceConfirmDialog from "../../components/CommerceConfirmDialog.astro";'
          )
        ).toBe(1);
      });

      test("renders <CommerceConfirmDialog exactly once", async () => {
        const code = await readCode(screen);
        expect(occurrences(code, "<CommerceConfirmDialog")).toBe(1);
      });

      test("drives it through confirmFromTrigger, never a raw confirm()", async () => {
        const code = await readCode(screen);
        expect(code).toContain(
          'import { confirmFromTrigger } from "../../lib/ui/commerce-confirm-dialog-client";'
        );
        expect(code).toContain("confirmFromTrigger(");
      });
    });
  }
});

describe("no screen builds a confirm options literal by hand", () => {
  // The coordinator's fix for the first pass of this issue: a screen that
  // calls `confirmCommerceAction({ title: "...", message: "..." })` has put
  // an untranslated English sentence back in its own `<script>` — exactly
  // the defect this whole component exists to remove, just moved from a
  // `window.confirm(...)` argument to an options object. Every translatable
  // string must instead be `t()`-rendered server-side into a trigger's own
  // `data-confirm-*` attributes and read back by `confirmFromTrigger`.
  for (const screen of TARGET_SCREENS) {
    test(`${screen} never calls confirmCommerceAction({ title: ... / message: ... } directly`, async () => {
      const code = await readCode(screen);
      expect(code).not.toContain("confirmCommerceAction(");
      // Belt and suspenders against a differently-shaped hand-built literal
      // (e.g. built up across a few lines rather than one `confirmCommerceAction(`
      // call): no screen's own `<script>` may declare a `title:`/`message:`
      // object key at all — every one of those now lives in the template half,
      // as a `data-confirm-title`/`data-confirm-message` attribute.
      // Plain index slicing, not a `<script>…</script>` regex: this reads a
      // source file we own (never untrusted HTML), and a tag-matching regex
      // trips CodeQL's js/bad-tag-filter even in a test.
      const scriptOpen = code.indexOf("<script>");
      const scriptClose = code.lastIndexOf("</script>");
      expect(scriptOpen).toBeGreaterThanOrEqual(0);
      expect(scriptClose).toBeGreaterThan(scriptOpen);
      const scriptBody = code.slice(
        scriptOpen + "<script>".length,
        scriptClose
      );
      expect(scriptBody).not.toMatch(/\btitle:\s*["'`]/);
      expect(scriptBody).not.toMatch(/\bmessage:\s*["'`]/);
    });
  }
});

/**
 * Every trigger button that calls `confirmFromTrigger` must carry its own
 * `data-confirm-*` attributes — otherwise the dialog opens with a blank
 * title/message (`readConfirmOptions` degrades rather than throwing, per
 * its own test above, which is precisely why nothing else would catch a
 * missing attribute). One entry per `onAction`/`commissionTransition`
 * selector this issue wired to `confirmFromTrigger`; `commission-void-btn`
 * appears twice in its screen (the "pending" and "approved" row branches)
 * and both must comply, so this checks EVERY occurrence, not just the first.
 */
const CONFIRM_TRIGGERS: ReadonlyArray<{
  screen: (typeof TARGET_SCREENS)[number];
  selector: string;
  danger: boolean;
}> = [
  {
    screen: "src/pages/admin/commerce-categories.astro",
    selector: "category-delete-btn",
    danger: true
  },
  {
    screen: "src/pages/admin/commerce-campaigns.astro",
    selector: "campaign-send-btn",
    danger: false
  },
  {
    screen: "src/pages/admin/commerce-campaigns.astro",
    selector: "campaign-cancel-btn",
    danger: true
  },
  {
    screen: "src/pages/admin/commerce-affiliates.astro",
    selector: "commission-approve-btn",
    danger: false
  },
  {
    screen: "src/pages/admin/commerce-affiliates.astro",
    selector: "commission-pay-btn",
    danger: false
  },
  {
    screen: "src/pages/admin/commerce-affiliates.astro",
    selector: "commission-void-btn",
    danger: true
  },
  {
    screen: "src/pages/admin/commerce-popup.astro",
    selector: "popup-delete-btn",
    danger: true
  },
  {
    screen: "src/pages/admin/commerce.astro",
    selector: "product-delete-btn",
    danger: true
  },
  {
    screen: "src/pages/admin/commerce-reviews.astro",
    selector: "review-delete-btn",
    danger: true
  },
  {
    screen: "src/pages/admin/commerce-sliders.astro",
    selector: "slider-delete-btn",
    danger: true
  },
  {
    screen: "src/pages/admin/commerce-testimonials.astro",
    selector: "testimonial-delete-btn",
    danger: true
  },
  {
    screen: "src/pages/admin/commerce-vouchers.astro",
    selector: "voucher-delete-btn",
    danger: true
  },
  {
    screen: "src/pages/admin/commerce-flash-sales.astro",
    selector: "flash-sale-delete-btn",
    danger: true
  }
];

/**
 * Every `<button ...CLASS_OR_ID...>` opening tag in `code` that mentions
 * `token` (as a class or an id — both are plain space/quote-delimited
 * tokens in this codebase's markup, so a substring match bounded by a word
 * boundary is enough). Matches across attributes spanning several lines;
 * `[^>]` already excludes the `>` that would let it cross into the NEXT
 * tag, so no `<button ...>` here ever runs past its own close.
 */
function findButtonTags(code: string, token: string): string[] {
  const pattern = new RegExp(`<button[^>]*\\b${token}\\b[^>]*>`, "g");
  return code.match(pattern) ?? [];
}

describe("every confirmFromTrigger button carries its data-confirm-* attributes", () => {
  for (const { screen, selector, danger } of CONFIRM_TRIGGERS) {
    test(`${screen} .${selector}`, async () => {
      const code = await readCode(screen);
      const tags = findButtonTags(code, selector);

      expect(tags.length).toBeGreaterThan(0);

      for (const tag of tags) {
        expect(tag).toContain("data-confirm-title=");
        expect(tag).toContain("data-confirm-message=");
        expect(tag).toContain("data-confirm-label=");
        if (danger) {
          expect(tag).toContain('data-confirm-danger="true"');
        } else {
          expect(tag).not.toContain("data-confirm-danger=");
        }
      }
    });
  }
});

describe("every commerce admin screen", () => {
  test("no window.confirm( call remains anywhere under src/pages/admin/commerce*", async () => {
    // Broader net than TARGET_SCREENS: catches a future commerce screen
    // reintroducing `window.confirm` just as much as a regression in one of
    // the ten this issue fixed.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir("src/pages/admin", { withFileTypes: true });
    const commerceFiles = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("commerce"))
      .map((entry) => `src/pages/admin/${entry.name}`);

    expect(commerceFiles.length).toBeGreaterThanOrEqual(
      TARGET_SCREENS.length + UNTOUCHED_SCREENS.length
    );

    for (const file of commerceFiles) {
      const code = await readCode(file);
      expect(code).not.toContain("window.confirm(");
    }
  });
});

describe("screens this issue deliberately did not touch", () => {
  for (const screen of UNTOUCHED_SCREENS) {
    test(`${screen} does not render CommerceConfirmDialog (a different agent owns it)`, async () => {
      const code = await readCode(screen);
      expect(code).not.toContain("CommerceConfirmDialog");
    });
  }
});

describe("CommerceConfirmDialog.astro", () => {
  const componentPath = "src/components/CommerceConfirmDialog.astro";

  test("has no inline style= attribute", async () => {
    const code = await readCode(componentPath);
    // Matches an inline `style="..."` (or `style={...}`) attribute, never the
    // `<style>` block itself — that block has no `style=` substring at all.
    expect(code).not.toMatch(/\sstyle=/);
  });

  test("never calls window.confirm — that is the client module's job alone", async () => {
    const code = await readCode(componentPath);
    expect(code).not.toContain("window.confirm(");
  });

  test("is role=alertdialog with aria-labelledby/aria-describedby wired to its own regions", async () => {
    const code = await readCode(componentPath);
    expect(code).toContain('role="alertdialog"');
    expect(code).toContain("aria-labelledby={titleId}");
    expect(code).toContain("aria-describedby={messageId}");
  });

  test("the note region is hidden by default", async () => {
    const code = await readCode(componentPath);
    expect(code).toMatch(/<div[^>]*id=\{noteFieldId\}[^>]*\bhidden\b/);
  });
});

describe("commerce-confirm-dialog-client.ts", () => {
  const clientPath = "src/lib/ui/commerce-confirm-dialog-client.ts";

  test("is the only file under src/lib/ui referencing window.confirm", async () => {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir("src/lib/ui", { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => `src/lib/ui/${entry.name}`);

    const offenders: string[] = [];
    for (const file of files) {
      const code = await readCode(file);
      const hasReference = code.includes("window.confirm(");
      if (file === clientPath) {
        expect(hasReference).toBe(true);
      } else if (hasReference) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("calls window.confirm exactly once — the documented fallback, not a stray second use", async () => {
    const code = await readCode(clientPath);
    expect(occurrences(code, "window.confirm(")).toBe(1);
  });
});
