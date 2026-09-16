/**
 * A build-time-generated stylesheet carrying this tenant's brand palette
 * (issue #24) — `--color-primary`/`--color-secondary`/`--color-accent`,
 * each paired with a computed `-foreground` custom property so any consumer
 * that puts text ON one of these colors gets a contrast-safe pairing for
 * free, exactly the way `product-labels.css.ts` already does for a
 * product's `labelColor`. See that file's own docblock for why an EXTERNAL,
 * same-origin stylesheet is how this app applies an arbitrary color at all
 * under `style-src 'self'` (`server/penyaji.mjs`) — the same reasoning
 * applies here unchanged, just for the brand palette instead of a label.
 *
 * `getSiteTheme()` (`src/lib/awcms/theme.ts`) already guarantees every
 * field is a valid 6-digit hex (either read from `apps/cms`'s `theming`
 * module or BjekMart's own default) — `contrastingForeground` is called
 * unconditionally, never behind an `isValidHexColor` guard the way
 * `labelClassName` needs one for arbitrary, possibly-malformed CMS data.
 */
import { getSiteTheme } from "../lib/awcms/theme";
import { contrastingForeground } from "../lib/warna";

export const prerender = true;

export async function GET(): Promise<Response> {
  const theme = await getSiteTheme();

  const css = `:root {
  --color-primary: ${theme.primary};
  --color-primary-foreground: ${contrastingForeground(theme.primary)};
  --color-secondary: ${theme.secondary};
  --color-secondary-foreground: ${contrastingForeground(theme.secondary)};
  --color-accent: ${theme.accent};
  --color-accent-foreground: ${contrastingForeground(theme.accent)};
}
`;

  return new Response(css, {
    headers: { "Content-Type": "text/css; charset=utf-8" }
  });
}
