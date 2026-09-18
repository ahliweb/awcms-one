/**
 * The share row's pure, build-time half (issue #51) — the four share-intent
 * URL builders and the "follow us" resolver `src/components/berita/
 * BarisBagikan.astro` renders from. No DOM, no network; the browser-side
 * half (the Instagram share button's Web Share API → clipboard flow) lives
 * in `src/scripts/bagikan.ts`, which never imports this file — the same
 * build-time/browser-runtime split every other feature of this app keeps
 * (`apps/storefront/README.md`, "The static/runtime rule").
 *
 * Ported from seputarborneo.com's `include/view_helpers.php` `sb_bagikan()`
 * (issues #61/#67 there), whose `AGENTS.md` paragraph on it is the
 * load-bearing rule this file encodes: **the row mixes three kinds of
 * control, and they must not be conflated.**
 *
 * 1. Facebook, X, WhatsApp, Threads have a REAL web share-intent URL — a
 *    plain `<a>` that works with no JavaScript. Always rendered.
 * 2. Instagram has NO web share URL at all — it is still a SHARE control
 *    (Web Share API, then a clipboard fallback), always rendered, and
 *    deliberately does NOT read `identity.socialLinks`: the reader shares to
 *    THEIR Instagram, and that needs no account of ours.
 * 3. TikTok and YouTube have no web share URL either — they are FOLLOW links
 *    to this site's OWN accounts, hidden when the CMS has none configured.
 *    Never invent a share URL for either.
 *
 * ## Why the follow links go through `src/lib/ikon-sosial.ts`, not a new filter
 *
 * A2 (issue #48) already built `isHttpUrl`/`detectSocialPlatform` for the
 * utility bar's icon row — hostname-based platform detection plus the
 * `http(s)`-only scheme filter seputarborneo's `sb_url_sosial()` applies
 * before an admin-typed URL ever reaches an `href` (a stored-XSS surface
 * otherwise: `javascript:`, `data:`, and the schemeless `www.tiktok.com/@x`
 * a browser would read as a RELATIVE path). This file reuses that exact
 * filter and detection rather than duplicating either — `resolveSocialIcons`
 * already applies both, in a stable order, and this file only narrows its
 * result to the two follow platforms and relabels them.
 */
import { resolveSocialIcons, SOCIAL_ICON_PATHS, type SocialPlatform } from "./ikon-sosial";

export type SharePlatform = "facebook" | "x" | "whatsapp" | "threads";
export type FollowPlatform = Extract<SocialPlatform, "tiktok" | "youtube">;

export type ShareLink = {
  platform: SharePlatform;
  /** The full accessible name — "Bagikan ke Facebook", never just the platform. */
  label: string;
  href: string;
  pathData: string;
};

export type FollowLink = {
  platform: FollowPlatform;
  /** "Ikuti kami di TikTok" — a FOLLOW verb, so a screen-reader user hears which of the row's controls share and which do not. */
  label: string;
  href: string;
  pathData: string;
};

/**
 * WhatsApp is not one of `src/lib/ikon-sosial.ts`'s six `SocialPlatform`s
 * (it is a messenger, not a profile a site has a public page on, so the
 * utility bar never renders it) — the one glyph this row needs that A2 did
 * not already ship. Same generic brand shape seputarborneo's own
 * `sb_ikon_sosial()` draws, rendered inline for the same reason as the rest
 * (pure vector geometry needs no image origin, so no CSP `img-src` change).
 */
export const WHATSAPP_ICON_PATH =
  "M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.87 9.87 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm5.8 14.09c-.25.69-1.44 1.32-1.99 1.4-.51.08-1.15.11-1.86-.12-.43-.13-.98-.32-1.69-.62-2.97-1.28-4.91-4.27-5.06-4.47-.15-.2-1.21-1.61-1.21-3.07s.77-2.18 1.04-2.48c.27-.3.59-.37.79-.37h.57c.18 0 .43-.07.67.51.25.6.85 2.06.92 2.21.07.15.12.32.02.52-.1.2-.15.32-.3.5-.15.17-.31.39-.44.52-.15.15-.3.31-.13.61.17.3.76 1.25 1.63 2.03 1.12 1 2.06 1.31 2.36 1.46.3.15.47.12.65-.07.17-.2.75-.87.95-1.17.2-.3.4-.25.67-.15.27.1 1.73.82 2.03.97.3.15.5.22.57.35.07.12.07.72-.18 1.41Z";

/**
 * The four real share-intent URLs, in seputarborneo's fixed order. Every
 * value is `encodeURIComponent`-ed — the title carries whatever punctuation
 * an editor typed (`&`, `#`, `?`, quotes), and the URL itself contains `:`
 * and `/`; either one unencoded truncates the intent at the platform's end.
 *
 * - Facebook's `sharer.php` takes only `u=` — it reads the title from the
 *   page's own Open Graph tags, never from a query parameter.
 * - X's `intent/tweet` takes `url=` and `text=` separately.
 * - WhatsApp (`wa.me`, per issue #51 — the domain this app's previous share
 *   link already used; seputarborneo's `api.whatsapp.com/send` is the same
 *   endpoint under an older host) and Threads take one `text=` carrying
 *   `"<title> <url>"`, joined with a literal `%20` so the URL stays a
 *   separate token the app auto-links.
 */
export function buildShareLinks(url: string, title: string): ShareLink[] {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);

  return [
    {
      platform: "facebook",
      label: "Bagikan ke Facebook",
      href: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
      pathData: SOCIAL_ICON_PATHS.facebook
    },
    {
      platform: "x",
      label: "Bagikan ke X",
      href: `https://twitter.com/intent/tweet?url=${u}&text=${t}`,
      pathData: SOCIAL_ICON_PATHS.x
    },
    {
      platform: "whatsapp",
      label: "Bagikan ke WhatsApp",
      href: `https://wa.me/?text=${t}%20${u}`,
      pathData: WHATSAPP_ICON_PATH
    },
    {
      platform: "threads",
      label: "Bagikan ke Threads",
      href: `https://www.threads.net/intent/post?text=${t}%20${u}`,
      pathData: SOCIAL_ICON_PATHS.threads
    }
  ];
}

const FOLLOW_LABEL: Record<FollowPlatform, string> = {
  tiktok: "Ikuti kami di TikTok",
  youtube: "Ikuti kami di YouTube"
};

/** The fixed follow order (TikTok, then YouTube — `sb_bagikan()`'s `$ikuti`); a missing account never shifts the other. */
const FOLLOW_ORDER: FollowPlatform[] = ["tiktok", "youtube"];

/**
 * `identity.socialLinks` → the TikTok/YouTube follow links this row can
 * safely render, or an empty array when neither is configured (the row then
 * simply ends after the Instagram button — no placeholder, no disabled
 * icon). Every URL has already passed `isHttpUrl` AND matched its platform
 * by HOSTNAME inside `resolveSocialIcons` — the CMS-authored `platform`
 * label is never what decides which icon a URL gets, for the reason
 * `src/lib/ikon-sosial.ts`'s own docblock gives.
 */
export function resolveFollowLinks(
  socialLinks: ReadonlyArray<{ platform: string; url: string }>
): FollowLink[] {
  const icons = resolveSocialIcons(socialLinks);
  const result: FollowLink[] = [];

  for (const platform of FOLLOW_ORDER) {
    const icon = icons.find((candidate) => candidate.platform === platform);
    if (!icon) continue;
    result.push({ platform, label: FOLLOW_LABEL[platform], href: icon.url, pathData: icon.pathData });
  }

  return result;
}
