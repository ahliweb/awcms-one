/**
 * The web app manifest (issue #24, extended by #428) — `<link rel="manifest">`
 * in `BaseLayout.astro`. The document itself is built by the pure
 * `buildManifest()` (`src/lib/pwa-manifest.ts`): a stable `id`, a site- and
 * profile-aware `name`/`short_name`/`categories`, `scope`/`start_url` on
 * this (storefront) origin, and PNG icons generated at build time
 * (`src/pages/icons/[name].png.ts`) beside the SVG favicon. See
 * `src/lib/awcms/profil.ts`'s "Media ids, not URLs" note for why a
 * CMS-uploaded favicon (`faviconMediaId`) is not resolved into an icon URL.
 */
import { SITE_PROFILE } from "../config/profil";
import { getSiteIdentity } from "../lib/awcms/profil";
import { getSiteTheme } from "../lib/awcms/theme";
import { buildManifest } from "../lib/pwa-manifest";

export const prerender = true;

export async function GET(): Promise<Response> {
  const identity = await getSiteIdentity();
  const theme = await getSiteTheme();

  const manifest = buildManifest({
    name: identity.name,
    description: identity.description,
    themeColor: theme.primary,
    profile: SITE_PROFILE
  });

  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json; charset=utf-8" }
  });
}
