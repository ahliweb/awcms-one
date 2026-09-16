import { describe, expect, test } from "bun:test";
import {
  isValidHexColor,
  contrastRatio,
  contrastingForeground,
  WCAG_AA_TEXT_CONTRAST
} from "../src/lib/warna";
import { DEFAULT_THEME_COLORS } from "../src/config/site";
import * as catalog from "../src/lib/catalog";

describe("lib/warna", () => {
  test("isValidHexColor accepts 6-digit hex, rejects everything else", () => {
    expect(isValidHexColor("#10b981")).toBe(true);
    expect(isValidHexColor("#FFF")).toBe(false);
    expect(isValidHexColor("not-a-color")).toBe(false);
    expect(isValidHexColor("rgb(1,2,3)")).toBe(false);
  });

  test("contrastRatio is symmetric and 1:1 for identical colors", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#000000"), 5);
    expect(contrastRatio("#123456", "#123456")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  test("contrastingForeground picks whichever of black/white has the higher ratio", () => {
    // A near-white background: black wins by a wide margin.
    expect(contrastingForeground("#f8fafc")).toBe("#000000");
    // A near-black background: white wins.
    expect(contrastingForeground("#0b1120")).toBe("#ffffff");
  });

  test("contrastingForeground throws on an invalid color rather than guessing", () => {
    expect(() => contrastingForeground("not-a-color")).toThrow();
  });

  test("issue #24's default theme colors each clear WCAG AA against their computed foreground", () => {
    for (const color of Object.values(DEFAULT_THEME_COLORS)) {
      const foreground = contrastingForeground(color);
      expect(contrastRatio(color, foreground)).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
    }
  });

  test("catalog.ts re-exports the SAME functions, not a re-implementation", () => {
    expect(catalog.isValidHexColor).toBe(isValidHexColor);
    expect(catalog.contrastingForeground).toBe(contrastingForeground);
  });
});
