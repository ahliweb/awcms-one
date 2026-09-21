/**
 * Issue #166 (2026-09 redesign): the self-hosted type system.
 *
 * Two things this test proves about `src/styles/global.css` without a
 * build: the three font tokens (`--font-sans`/`--font-serif`/`--font-mono`)
 * are declared, and every `@font-face src` is a same-origin `/fonts/*.woff2`
 * path — never an `http(s)://` URL, which would be a Google Fonts (or any
 * other) origin reintroduced into a CSP that stays `'self'`-only for fonts
 * (`server/penyaji.mjs`'s `font-src 'self'`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS_PATH = join(import.meta.dir, "..", "src", "styles", "global.css");
const css = readFileSync(CSS_PATH, "utf-8");

describe("global.css — self-hosted type system (issue #166)", () => {
  test("declares --font-sans, --font-serif, and --font-mono", () => {
    expect(css).toMatch(/--font-sans:\s*'Plus Jakarta Sans'/);
    expect(css).toMatch(/--font-serif:\s*'Lora'/);
    expect(css).toMatch(/--font-mono:\s*'IBM Plex Mono'/);
  });

  test("every @font-face src is a same-origin /fonts/*.woff2 path, never http(s)", () => {
    const fontFaceBlocks = css.match(/@font-face\s*{[^}]*}/g) ?? [];
    expect(fontFaceBlocks.length).toBeGreaterThanOrEqual(11);

    for (const block of fontFaceBlocks) {
      const srcMatch = block.match(/src:\s*url\(['"]([^'")]+)['"]\)/);
      expect(srcMatch).not.toBeNull();
      const src = srcMatch![1];
      expect(src.startsWith("/fonts/")).toBe(true);
      expect(src).not.toMatch(/^https?:\/\//);
      expect(src.endsWith(".woff2")).toBe(true);
      expect(block).toContain("font-display: swap");
    }
  });

  test("declares the three self-hosted font families named in each family's own @font-face block", () => {
    expect(css).toContain("font-family: 'Plus Jakarta Sans';");
    expect(css).toContain("font-family: 'Lora';");
    expect(css).toContain("font-family: 'IBM Plex Mono';");
  });
});
