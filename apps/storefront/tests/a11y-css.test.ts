/**
 * Invariants of `src/styles/a11y.css` and the reading-preferences markup
 * (issue #539, ADR-0057) that a browser run would only surface late:
 *
 * - the two copies of the high-contrast palette (a stored choice, and the OS
 *   `prefers-contrast: more` default) are identical;
 * - every text/background pair in the palette clears WCAG 1.4.6's 7:1, in both
 *   colour schemes;
 * - the palette is never applied under `forced-colors: active`;
 * - monochrome is a `filter` on `html` alone (a filter on `body` or a wrapper
 *   would break `position: fixed`);
 * - nothing in the panel's markup or styles needs an inline script or style.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { contrastRatio } from "../src/lib/warna";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const RAW_CSS = read("../src/styles/a11y.css");
/** The stylesheet without comments, so a rule is never matched inside prose. */
const CSS = RAW_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
/** The component's markup, without its frontmatter docblock (which talks about `aria-modal`, inline script and so on). */
const PANEL = read("../src/components/A11yPanel.astro").replace(/^---[\s\S]*?\n---\n/, "");
const GLOBAL_CSS = read("../src/styles/global.css");

function section(name: string): string {
  const match = RAW_CSS.match(new RegExp(`/\\* BEGIN ${name} \\*/([\\s\\S]*?)/\\* END ${name} \\*/`));
  if (!match) throw new Error(`a11y.css has no "${name}" section between BEGIN/END markers`);
  return match[1] ?? "";
}

const ATTRIBUTE_SECTION = section("contrast-attribute");
const OS_SECTION = section("contrast-os-default");

/** The tokens declared on `root` in the light or the dark `@media` block of a section. */
function tokensOf(sectionText: string, root: string, scheme: "light" | "dark"): Record<string, string> {
  const darkStart = sectionText.indexOf("and (prefers-color-scheme: dark)");
  if (darkStart === -1) throw new Error("section has no dark block");
  const block = scheme === "dark" ? sectionText.slice(darkStart) : sectionText.slice(0, darkStart);
  const start = block.indexOf(`${root} {`);
  if (start === -1) throw new Error(`no ${root} rule in the ${scheme} block`);
  const body = block.slice(start, block.indexOf("\n}", start));
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

describe("high-contrast palette", () => {
  test("the stored-choice section and the OS-default section are copies of each other", () => {
    const normalisedAttribute = ATTRIBUTE_SECTION.replaceAll(":root[data-a11y-contrast]", "ROOT").replaceAll(
      "(forced-colors: none) ",
      "MQ "
    );
    const normalisedOs = OS_SECTION.replaceAll(":root:not([data-a11y-user])", "ROOT").replaceAll(
      "(forced-colors: none) and (prefers-contrast: more) ",
      "MQ "
    );
    expect(normalisedOs).toBe(normalisedAttribute);
  });

  test("both sections are excluded under forced colours, and the OS default under an explicit choice", () => {
    expect(ATTRIBUTE_SECTION).toMatch(/@media \(forced-colors: none\)/);
    expect(OS_SECTION).toMatch(/@media \(forced-colors: none\) and \(prefers-contrast: more\)/);
    expect(OS_SECTION).toContain(":root:not([data-a11y-user])");
    // No palette rule sits outside those media queries.
    expect(RAW_CSS.slice(0, RAW_CSS.indexOf("/* BEGIN contrast-attribute */"))).not.toMatch(/--bg-primary:/);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`${scheme} scheme: every text/background pair clears 7:1 (WCAG 1.4.6)`, () => {
      const t = tokensOf(ATTRIBUTE_SECTION, ":root[data-a11y-contrast]", scheme);

      const pairs: Array<[string, string]> = [
        ["--text-primary", "--bg-primary"],
        ["--text-primary", "--bg-surface"],
        ["--text-primary", "--bg-subtle"],
        ["--text-secondary", "--bg-primary"],
        ["--text-secondary", "--bg-surface"],
        ["--text-secondary", "--bg-subtle"],
        ["--text-muted", "--bg-primary"],
        ["--text-muted", "--bg-surface"],
        ["--text-muted", "--bg-subtle"],
        ["--link-color", "--bg-primary"],
        ["--link-color", "--bg-surface"],
        ["--link-color", "--bg-subtle"],
        ["--link-hover", "--bg-surface"],
        ["--danger-text", "--danger-bg"],
        ["--success-text", "--success-bg"],
        ["--status-success-fg", "--status-success-bg"],
        ["--status-warning-fg", "--status-warning-bg"],
        ["--status-info-fg", "--status-info-bg"],
        ["--status-danger-fg", "--status-danger-bg"],
        ["--status-neutral-fg", "--status-neutral-bg"],
        ["--text-on-inverse", "--bg-inverse"],
        ["--text-on-inverse-muted", "--bg-inverse"],
        ["--text-on-inverse", "--bg-inverse-2"],
        ["--text-on-inverse-muted", "--bg-inverse-2"],
        ["--accent-on-inverse", "--bg-inverse"],
        ["--text-on-inverse-muted", "--news-bar-bg"],
        ["--color-primary-foreground", "--color-primary"],
        ["--color-secondary-foreground", "--color-secondary"],
        ["--color-accent-foreground", "--color-accent"],
        ["--text-rating", "--bg-surface"],
        ["--news-accent", "--bg-surface"],
        ["--news-accent", "--bg-subtle"],
        // The skip link and the ticker label take `--bg-primary` as their text colour.
        ["--bg-primary", "--accent-primary"],
        ["--bg-primary", "--news-accent"]
      ];

      const failures: string[] = [];
      for (const [fg, bg] of pairs) {
        const foreground = t[fg];
        const background = t[bg];
        if (!foreground || !background) {
          failures.push(`${fg} on ${bg}: token missing from the palette`);
          continue;
        }
        const ratio = contrastRatio(foreground, background);
        if (ratio < 7) failures.push(`${fg} ${foreground} on ${bg} ${background}: ${ratio.toFixed(2)}:1`);
      }
      expect(failures).toEqual([]);
    });

    test(`${scheme} scheme: borders and the focus ring clear 3:1 against the surfaces they sit on`, () => {
      const t = tokensOf(ATTRIBUTE_SECTION, ":root[data-a11y-contrast]", scheme);
      for (const surface of ["--bg-primary", "--bg-surface", "--bg-subtle"]) {
        expect(contrastRatio(t["--border-color"]!, t[surface]!)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(t["--border-focus"]!, t[surface]!)).toBeGreaterThanOrEqual(3);
      }
    });
  }

  test("the focus ring inside an inverse band is a colour that is visible on it", () => {
    for (const scheme of ["light", "dark"] as const) {
      const t = tokensOf(ATTRIBUTE_SECTION, ":root[data-a11y-contrast]", scheme);
      expect(contrastRatio("#ffeb3b", t["--bg-inverse"]!)).toBeGreaterThanOrEqual(3);
    }
    expect(ATTRIBUTE_SECTION).toContain(":is(.band-inverse, .bilah-utilitas)");
  });
});

describe("preference rules", () => {
  test("monochrome is a filter on the root element only", () => {
    expect(CSS).toMatch(/html\[data-a11y-mono\]\s*\{\s*filter: grayscale\(1\);\s*\}/);
    const filterRules = [...CSS.matchAll(/([^{}]+)\{[^{}]*\bfilter:[^{}]*\}/g)].map((m) => m[1]!.trim());
    expect(filterRules).toEqual(["html[data-a11y-mono]"]);
  });

  test("each documented attribute has a rule, scoped under `html[...]`", () => {
    for (const selector of [
      'html[data-a11y-text="large"]',
      'html[data-a11y-text="x-large"]',
      "html[data-a11y-mono]",
      "html[data-a11y-dyslexia]",
      "html[data-a11y-underline] a[href]",
      "html[data-a11y-highlight] a[href]",
      'html[data-a11y-motion="reduce"]'
    ]) {
      expect(CSS).toContain(selector);
    }
    expect(CSS).toMatch(/html\[data-a11y-text="large"\]\s*\{\s*font-size: 120%;/);
    expect(CSS).toMatch(/html\[data-a11y-text="x-large"\]\s*\{\s*font-size: 140%;/);
  });

  test("dyslexia support uses the WCAG 1.4.12 spacing values and the system sans stack", () => {
    expect(CSS).toContain('system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif');
    expect(CSS).toContain("letter-spacing: 0.12em");
    expect(CSS).toContain("word-spacing: 0.16em");
    expect(CSS).toMatch(/line-height: 1\.5;/);
    expect(CSS).toMatch(/margin-block-end: 2em/);
    expect(CSS).toMatch(/text-align: start/);
  });

  test("link highlight is yellow #ffeb3b with #111 text, which clears 7:1", () => {
    expect(CSS).toMatch(/background-color: #ffeb3b;\s*color: #111111 !important;/);
    expect(contrastRatio("#111111", "#ffeb3b")).toBeGreaterThanOrEqual(7);
    expect(CSS).toMatch(/html\[data-a11y-underline\] a\[href\]\s*\{[^}]*text-underline-offset: 0\.15em/);
  });

  test("reduce-motion disables animation, transition and smooth scrolling everywhere", () => {
    const rule = CSS.match(/html\[data-a11y-motion="reduce"\],[\s\S]*?\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(rule).toContain("animation: none !important");
    expect(rule).toContain("transition: none !important");
    expect(rule).toContain("scroll-behavior: auto !important");
    expect(CSS).toContain('html[data-a11y-motion="reduce"] *::before');
    expect(CSS).toContain('html[data-a11y-motion="reduce"] *::after');
  });

  test("the OS reduced-motion default in global.css stands down once a visitor has a stored choice", () => {
    const block = GLOBAL_CSS.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}\n/)?.[1] ?? "";
    expect(block).toContain(":root:not([data-a11y-user])");
    expect(block).not.toMatch(/^\s*\*,/m);
  });
});

describe("panel markup and styles", () => {
  test("the panel and its button are rendered hidden, so a visitor without JavaScript never meets them", () => {
    expect(PANEL).toMatch(/<button[^>]*data-a11y-fab[^>]*>/s);
    expect(PANEL.match(/<button[^>]*\bhidden\b[^>]*data-a11y-fab/s)).not.toBeNull();
    expect(PANEL.match(/<div[^>]*\bhidden\b[^>]*data-a11y-panel/s)).not.toBeNull();
  });

  test("the dialog is non-modal, named, and described", () => {
    expect(PANEL).toContain('role="dialog"');
    expect(PANEL).toContain('aria-labelledby="a11y-title"');
    expect(PANEL).toContain('aria-describedby="a11y-summary"');
    expect(PANEL).not.toContain("aria-modal");
  });

  test("the button names itself, and declares what it controls", () => {
    expect(PANEL).toContain('aria-label="Pengaturan aksesibilitas"');
    expect(PANEL).toContain('aria-expanded="false"');
    expect(PANEL).toContain('aria-controls="a11y-panel"');
  });

  test("no inline style or script in the markup, no remote URL in the styles", () => {
    // Plain substring checks: this is a tripwire on our own markup, not an HTML filter.
    expect(PANEL.toLowerCase()).not.toContain(" style=");
    expect(PANEL.toLowerCase()).not.toContain("<style");
    expect(PANEL.toLowerCase()).not.toContain("<script");
    expect(CSS).not.toMatch(/url\(\s*["']?https?:/);
    expect(CSS).not.toMatch(/@import/);
  });

  test("the floating button is fixed at the inline start, at least 44px square, and hidden in print", () => {
    expect(CSS).toMatch(/\.a11y__fab \{[^}]*position: fixed;[^}]*inset-inline-start: 1rem;/s);
    expect(CSS).toMatch(/\.a11y__fab \{[^}]*width: 48px;[^}]*height: 48px;/s);
    expect(CSS).toMatch(/@media print \{\s*\.a11y \{\s*display: none;/);
  });
});
