/**
 * Color math shared by two callers: `src/lib/catalog.ts` (a product's
 * merchandiser-chosen `labelColor` badge) and `src/pages/theme-tokens.css.ts`
 * (the CMS-driven `--color-primary`/`--color-secondary`/`--color-accent`
 * brand palette, issue #24). Both need the exact same question answered —
 * "is this arbitrary hex color usable?" and "black or white text reads
 * better on it?" — so the WCAG math lives here once rather than twice.
 *
 * `catalog.ts` re-exports `isValidHexColor`/`contrastingForeground` from
 * here so nothing importing from it today has to change; this file is the
 * new home of the IMPLEMENTATION, not a new public surface.
 *
 * Pure, no I/O — safe to unit test with fixed inputs.
 */

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Whether `value` is a 6-digit `#rrggbb` hex color this app knows how to pair a readable foreground against. */
export function isValidHexColor(value: string): boolean {
  return HEX_COLOR.test(value.trim());
}

/** WCAG relative luminance (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance) of a validated `#rrggbb` string. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    );

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio)
 * between two validated `#rrggbb` colors. Symmetric — the lighter color is
 * always the numerator, regardless of argument order.
 */
export function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Picks black or white text for readability against an arbitrary background
 * color — a merchandiser-chosen badge color, or a CMS-configured brand
 * color, with no fixed palette. Assuming white text is always readable on an
 * arbitrary color is the exact bug this function exists to avoid: a pale
 * background (a light yellow "Baru" tag, say) with white text fails
 * contrast outright.
 *
 * Compares the contrast ratio of BOTH candidates against the background and
 * returns whichever is higher, rather than testing luminance against a
 * single midpoint threshold — the two contrast formulas (against white,
 * against black) are not symmetric around one, so a fixed threshold picks
 * the worse option for a real range of colors.
 *
 * Known limit, stated rather than hidden: for a color near the middle of the
 * luminance range, NEITHER pure black nor pure white may reach the 4.5:1
 * body-text minimum — picking the higher-contrast one is the best a
 * function of the background color alone can do without altering the
 * chosen color, which is out of scope for this function to do silently.
 */
export function contrastingForeground(hex: string): "#000000" | "#ffffff" {
  if (!isValidHexColor(hex)) {
    throw new Error(
      `contrastingForeground: "${hex}" is not a 6-digit hex color (e.g. ` +
        `"#1a2b3c"). Callers are expected to check isValidHexColor() first.`
    );
  }

  const contrastWithWhite = contrastRatio(hex, "#ffffff");
  const contrastWithBlack = contrastRatio(hex, "#000000");

  return contrastWithWhite >= contrastWithBlack ? "#ffffff" : "#000000";
}

/** The WCAG AA minimum for normal body text (`docs/aksesibilitas.md`, issue #24's acceptance criteria). Large text (≥18pt/14pt bold) is allowed 3:1, but this app makes no such exception anywhere it uses this constant. */
export const WCAG_AA_TEXT_CONTRAST = 4.5;
