/**
 * A build-time-generated stylesheet: one class per DISTINCT `labelColor` the
 * catalog actually uses, e.g. `.label-bg-1a2b3c { background-color: #1a2b3c; color: #ffffff }`.
 *
 * ## Why this file exists at all
 *
 * `label`/`labelColor` (`CommerceProduct.labelColor`, `src/lib/catalog.ts`)
 * is an arbitrary, merchandiser-chosen hex string — there is no fixed
 * palette to pre-declare as ordinary classes in `global.css`. The two usual
 * ways to apply an arbitrary per-instance color — an inline
 * `style="background: ..."` attribute, or a hand-written inline `<style>`
 * block — are BOTH exactly what `style-src 'self'` (`server/penyaji.mjs`)
 * refuses without an `'unsafe-inline'` exemption, and issue #5 is explicit
 * that this build must never need one.
 *
 * The static-output decision is what makes a third way possible: every
 * `labelColor` in the catalog is already known at BUILD time, so this
 * endpoint — the same `src/pages/*.ts` static-file mechanism the upstream
 * `awcms-astro` template uses for `robots.txt.ts` — generates one small,
 * genuinely external, same-origin stylesheet instead. `style-src 'self'`
 * allows it with no exemption, because it is not inline anything: it is a
 * file, like any other CSS this build emits.
 *
 * A color awcms sends that is not a clean 6-digit hex (free text, `rgb(...)`,
 * a typo) gets no class here at all — `labelClassName()` in `catalog.ts`
 * already returns `undefined` for it, and the product falls back to the
 * plain `.label-badge` style in `global.css`. One merchandiser's bad color
 * value degrades a badge; it does not fail a build.
 */
import { getProducts, contrastingForeground, isValidHexColor, labelClassName } from "../../../lib/catalog";

export const prerender = true;

export async function GET(): Promise<Response> {
  const products = await getProducts();

  const colors = [
    ...new Set(
      products
        .map((product) => product.labelColor)
        .filter((color): color is string => color !== null && isValidHexColor(color))
    )
  ];

  const css = colors
    .map((color) => {
      const className = labelClassName(color);
      const foreground = contrastingForeground(color);
      return `.${className} { background-color: ${color}; color: ${foreground}; }`;
    })
    .join("\n");

  return new Response(css, {
    headers: { "Content-Type": "text/css; charset=utf-8" }
  });
}
