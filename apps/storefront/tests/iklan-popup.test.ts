/**
 * Unit coverage for the ad popup (issue #53, A7) — the DOM-free half of
 * `src/scripts/iklan-popup.ts` (`safeHttpUrl`, `isModifiedClick`,
 * `supportsDialog`), plus two source-level guards for the wiring that the
 * browser-level spec (`tests/e2e/iklan-popup.e2e.ts`) would otherwise be
 * the only thing to notice:
 *
 *   - `BeritaLayout.astro` mounts the script exactly once (every news page
 *     renders through it; a second mount would double every listener).
 *   - `IklanSlot.astro` still marks BOTH trigger shapes — the anchor for a
 *     linked creative, the `<button>` for an unlinked one — with the three
 *     `data-iklan-*` attributes the script reads.
 *
 * `bun test` has no DOM, so nothing here touches `initIklanPopup`/
 * `readTrigger`; importing the module is safe because its auto-init is
 * guarded on `typeof document !== "undefined"`. Open/close/focus/scroll-lock
 * behaviour is the e2e spec's job, against a real `<dialog>`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CTA_LABEL,
  DIALOG_ID,
  NO_LINK_MESSAGE,
  isModifiedClick,
  safeHttpUrl,
  supportsDialog
} from "../src/scripts/iklan-popup";

const SRC = new URL("../src/", import.meta.url);
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, SRC)), "utf8");

describe("safeHttpUrl", () => {
  test("keeps an absolute http(s) URL", () => {
    expect(safeHttpUrl("https://example.test/promo-kur")).toBe("https://example.test/promo-kur");
    expect(safeHttpUrl("http://example.test/a?b=1#c")).toBe("http://example.test/a?b=1#c");
  });

  test("rejects every other scheme, a relative path, an empty value, and nonsense", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,hi")).toBeNull();
    expect(safeHttpUrl("mailto:a@b.test")).toBeNull();
    expect(safeHttpUrl("/relatif")).toBeNull();
    expect(safeHttpUrl("#")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl("bukan url")).toBeNull();
  });
});

describe("isModifiedClick", () => {
  test("a plain primary click is not modified", () => {
    expect(isModifiedClick({ button: 0 })).toBe(false);
    expect(isModifiedClick({})).toBe(false);
  });

  test("any modifier key or a non-primary button leaves the click to the browser", () => {
    expect(isModifiedClick({ button: 1 })).toBe(true);
    expect(isModifiedClick({ button: 0, ctrlKey: true })).toBe(true);
    expect(isModifiedClick({ button: 0, metaKey: true })).toBe(true);
    expect(isModifiedClick({ button: 0, shiftKey: true })).toBe(true);
    expect(isModifiedClick({ button: 0, altKey: true })).toBe(true);
  });
});

describe("supportsDialog", () => {
  test("true only when HTMLDialogElement.prototype.showModal is a function", () => {
    expect(supportsDialog({ HTMLDialogElement: { prototype: { showModal() {} } } })).toBe(true);
    expect(supportsDialog({ HTMLDialogElement: { prototype: {} } })).toBe(false);
    expect(supportsDialog({})).toBe(false);
  });
});

describe("the reader-facing strings are the issue's own", () => {
  test("CTA, message, and dialog id", () => {
    expect(CTA_LABEL).toBe("Buka iklan");
    expect(NO_LINK_MESSAGE).toBe("Iklan ini belum memiliki tautan tujuan");
    expect(DIALOG_ID).toBe("iklan-popup");
  });
});

describe("wiring", () => {
  test("BeritaLayout.astro mounts src/scripts/iklan-popup exactly once, as an external module", () => {
    const layout = read("layouts/BeritaLayout.astro");
    const mounts = layout.match(/<script>\s*import "\.\.\/scripts\/iklan-popup";\s*<\/script>/g) ?? [];
    expect(mounts).toHaveLength(1);
    expect(layout).toContain('import "../styles/iklan-popup.css";');
  });

  test("IklanSlot.astro marks both trigger shapes with the three data-iklan-* attributes", () => {
    const slot = read("components/berita/IklanSlot.astro");

    // The linked shape: attributes on the anchor, conditioned on a
    // resolvable creative image (a text-only ad is never a trigger).
    const anchor = slot.match(/<a\b[\s\S]*?>/)?.[0] ?? "";
    expect(anchor).toContain('rel="noopener noreferrer sponsored"');
    expect(anchor).toContain('data-iklan-popup={imageUrl ? "" : undefined}');
    expect(anchor).toContain("data-iklan-nama={imageUrl ? ad.name : undefined}");
    expect(anchor).toContain("data-iklan-label={imageUrl ? popupLabel : undefined}");

    // The unlinked shape: a real <button type="button">, never a bare
    // <img> with a tabindex.
    // (Matched by its class: the docblock above the template also spells
    // out `<button type="button">` in prose.)
    const button = slot.match(/<button\s[^>]*class="ad-slot-trigger"[\s\S]*?>/)?.[0] ?? "";
    expect(button).toContain('type="button"');
    expect(button).toContain("data-iklan-popup");
    expect(button).toContain("data-iklan-nama={ad.name}");
    expect(button).toContain("data-iklan-label={popupLabel}");
  });
});
