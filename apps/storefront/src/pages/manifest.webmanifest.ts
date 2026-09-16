/**
 * The web app manifest (issue #24) — `<link rel="manifest">` in
 * `BaseLayout.astro`. `icons` points at `public/favicon.svg`
 * (`apps/storefront/public/favicon.svg`), this deployment's bundled default
 * favicon — see `src/lib/awcms/profil.ts`'s "Media ids, not URLs" note for
 * why a CMS-uploaded favicon (`faviconMediaId`) is not resolved to an
 * `<img>`/icon URL in this issue.
 */
import { getSiteIdentity } from "../lib/awcms/profil";
import { getSiteTheme } from "../lib/awcms/theme";

export const prerender = true;

export async function GET(): Promise<Response> {
  const identity = await getSiteIdentity();
  const theme = await getSiteTheme();

  const manifest = {
    name: identity.name,
    short_name: identity.name,
    description: identity.description,
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: theme.primary,
    icons: [
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any"
      }
    ]
  };

  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json; charset=utf-8" }
  });
}
