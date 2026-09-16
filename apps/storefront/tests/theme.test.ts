import { describe, expect, test } from "bun:test";
import { extractThemeToken } from "../src/lib/awcms/theme";
import { readFileSync } from "node:fs";

const FIXTURE_CSS = readFileSync(
  new URL("./fixtures/awcms/tokens.css", import.meta.url),
  "utf8"
);

describe("lib/awcms/theme: extractThemeToken", () => {
  test("reads a token's value out of a real tokens.css fixture", () => {
    expect(extractThemeToken(FIXTURE_CSS, "color_primary")).toBe("#7c3aed");
    expect(extractThemeToken(FIXTURE_CSS, "color_accent")).toBe("#db2777");
  });

  test("returns null for a token the stylesheet does not declare", () => {
    expect(extractThemeToken(FIXTURE_CSS, "color_secondary")).toBeNull();
    expect(extractThemeToken(":root {}", "color_primary")).toBeNull();
  });

  test("trims surrounding whitespace from the extracted value", () => {
    const css = ":root {\n  --awcms-theme-color_primary:   #112233  ;\n}\n";
    expect(extractThemeToken(css, "color_primary")).toBe("#112233");
  });

  test("does not confuse a prefix match — e.g. font_size_base vs font_size", () => {
    const css = ":root { --awcms-theme-font_size_base: 1rem; }";
    expect(extractThemeToken(css, "font_size")).toBeNull();
    expect(extractThemeToken(css, "font_size_base")).toBe("1rem");
  });
});
