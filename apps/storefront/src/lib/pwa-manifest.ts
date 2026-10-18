/**
 * The web app manifest document (issue #24, extended by #428) as a PURE
 * function, so `tests/pwa-manifest.test.ts` can pin its contract for every
 * build profile without standing up the stub CMS. `src/pages/
 * manifest.webmanifest.ts` is the only caller; it supplies the (CMS or env
 * resolved) identity and theme.
 *
 * ## Identity and isolation
 *
 * - `id: "/"` is the stable identity of the installed app. It is resolved
 *   against the origin, so two sites (two profiles, two tenants) are
 *   different apps because their ORIGINS differ — nothing here can make one
 *   deployment collide with another — while a later change of `start_url`
 *   or of the profile on the same origin does not orphan existing installs.
 * - `scope: "/"` and `start_url: "/"` stay on the storefront origin. No
 *   service worker is registered by this app, and nothing here points at
 *   the CMS origin (`apps/cms` keeps its own `/admin` PWA and
 *   `/push-sw.js`).
 * - Nothing in the manifest is a credential or personal data: only the
 *   public site name, description and theme colour.
 */
import type { SiteProfile } from "../config/profil";

export const MANIFEST_ID = "/";
export const MANIFEST_START_URL = "/";
export const MANIFEST_SCOPE = "/";

/** Public paths of the generated icons (see `src/pages/icons/[name].png.ts`). */
export const ICON_PATHS = {
  icon192: "/icons/icon-192.png",
  icon512: "/icons/icon-512.png",
  maskable512: "/icons/icon-maskable-512.png",
  appleTouch: "/apple-touch-icon.png"
} as const;

/** The manifest `categories` hint for each build profile. */
export const PROFILE_CATEGORIES: Record<SiteProfile, readonly string[]> = {
  toko: ["shopping"],
  berita: ["news"],
  landing: ["business"]
};

const SHORT_NAME_MAX = 12;

/**
 * The label under the Home Screen icon. Platforms truncate around 12
 * characters, so a longer name is shortened at a word boundary (its first
 * word when that fits, otherwise a hard cut).
 */
export function shortNameFor(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= SHORT_NAME_MAX) return trimmed;
  const firstWord = trimmed.split(/\s+/)[0] ?? trimmed;
  return (firstWord.length <= SHORT_NAME_MAX ? firstWord : firstWord.slice(0, SHORT_NAME_MAX)).trim();
}

export type ManifestInput = {
  name: string;
  description: string;
  themeColor: string;
  profile: SiteProfile;
};

export function buildManifest(input: ManifestInput) {
  return {
    id: MANIFEST_ID,
    name: input.name,
    short_name: shortNameFor(input.name),
    description: input.description,
    lang: "id",
    start_url: MANIFEST_START_URL,
    scope: MANIFEST_SCOPE,
    display: "standalone",
    background_color: "#ffffff",
    theme_color: input.themeColor,
    categories: [...PROFILE_CATEGORIES[input.profile]],
    icons: [
      { src: ICON_PATHS.icon192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: ICON_PATHS.icon512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: ICON_PATHS.maskable512, sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }
    ]
  };
}
