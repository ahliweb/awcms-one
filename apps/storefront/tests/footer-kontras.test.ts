/**
 * The footer sits on `.band-inverse` (`--bg-inverse`), so no rule that
 * targets a footer element may colour it with a surface-side text token
 * (issue #551). `.site-footer-column h2` once set `--text-primary`, which
 * equals `--bg-inverse` in light mode: invisible headings, a 1:1 ratio.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../src/styles/global.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);

/** Every `{ selector, body }` rule whose selector mentions `.site-footer` (including `.site-footer-*`). */
function footerRules(): Array<{ selector: string; body: string }> {
  return [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1]!.trim(), body: m[2]! }))
    .filter((r) => /\.site-footer/.test(r.selector));
}

const SURFACE_TEXT_TOKENS = ["--text-primary", "--text-secondary", "--text-muted"];

describe("footer text colours (issue #551)", () => {
  test("the footer rules were found", () => {
    expect(footerRules().length).toBeGreaterThan(5);
  });

  test("no footer rule colours text with a surface-side token", () => {
    const offenders = footerRules().filter((r) =>
      SURFACE_TEXT_TOKENS.some((t) => new RegExp(`(^|[;\\s])color:\\s*var\\(${t}\\)`).test(r.body))
    );
    expect(offenders.map((r) => r.selector)).toEqual([]);
  });

  test("the footer headings take the on-inverse colour", () => {
    const rule = footerRules().find((r) => r.selector === ".site-footer h2");
    expect(rule?.body).toContain("var(--text-on-inverse)");
    const column = footerRules().find((r) => r.selector === ".site-footer-column h2");
    expect(column?.body).not.toMatch(/(^|[;\s])color:/);
  });
});
