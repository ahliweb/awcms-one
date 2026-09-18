/**
 * Social-icon rendering helpers for the news chrome (issue #48) — shared by
 * `src/components/berita/BilahUtilitas.astro` (the only caller today; a
 * future share-row issue, #51, may reuse `detectSocialPlatform` for the same
 * reason seputarborneo's own `sb_ikon_sosial()` is shared between its header
 * and its share button, per that function's own docblock in
 * `include/view_helpers.php`).
 *
 * ## Two independent guards, not one
 *
 * `identity.socialLinks` (`src/lib/awcms/profil.ts`'s `parseSocialLinks()`)
 * already drops anything that is not `http(s)` before this app ever sees it
 * — but this file does NOT trust that upstream guard alone. `isHttpUrl`
 * below is a second, independently testable check applied again at render
 * time, the same defense-in-depth seputarborneo's own `sb_url_sosial()`
 * applies (see `include/view_helpers.php`'s own docblock: `seputarborneo_e()`
 * escapes attribute TEXT, never a URL SCHEME, so a scheme check is a
 * separate concern from HTML-escaping and must not be skipped just because
 * one caller already made it). A platform this app cannot identify — an
 * unrecognised host — renders nothing rather than a generic/broken icon.
 */

export type SocialPlatform =
  | "facebook"
  | "x"
  | "instagram"
  | "youtube"
  | "tiktok"
  | "threads";

/**
 * `true` only for a genuine, parseable `http:`/`https:` URL. Rejects a
 * schemeless address (`www.tiktok.com/@x` — the most common real-world admin
 * typo, per `sb_url_sosial()`'s own docblock: a browser reads that as a
 * RELATIVE path, not a host) and any other scheme (`javascript:`, `data:`,
 * `mailto:`) — a stored-XSS surface if this ever reached an `href`
 * unchecked.
 */
export function isHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** Strips a leading `www.` and lower-cases — the only normalisation a hostname match needs. */
function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

const HOST_PLATFORM: ReadonlyArray<readonly [string, SocialPlatform]> = [
  ["facebook.com", "facebook"],
  ["fb.com", "facebook"],
  ["x.com", "x"],
  ["twitter.com", "x"],
  ["instagram.com", "instagram"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
  ["tiktok.com", "tiktok"],
  ["threads.net", "threads"],
  ["threads.com", "threads"]
];

/**
 * The platform a URL's HOST identifies, or `null` when it is not one of the
 * six this app renders an icon for — `identity.socialLinks`'s own
 * `platform` field (CMS-authored free text) is deliberately NOT trusted for
 * this: a host match is what decides which SVG glyph is correct, the same
 * way seputarborneo's header hard-codes one icon per configured field rather
 * than trusting an admin-typed label. Returns `null` (rather than throwing)
 * for a non-`http(s)` or unparseable URL too — callers that need to
 * distinguish "no icon, unrecognised platform" from "no icon, unsafe URL"
 * should call `isHttpUrl` themselves first.
 */
export function detectSocialPlatform(url: string): SocialPlatform | null {
  if (!isHttpUrl(url)) return null;

  const host = normalizeHost(new URL(url).hostname);
  for (const [suffix, platform] of HOST_PLATFORM) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return platform;
  }
  return null;
}

/**
 * One `<path d="…">` per platform — standard, generic brand glyphs (the same
 * shapes seputarborneo's own `sb_ikon_sosial()` draws), not proprietary
 * artwork. Rendered inline (`<svg><path/></svg>`) rather than as an `<img>`
 * so no image origin — and no CSP `img-src` exemption — is ever needed for
 * an icon that is pure vector geometry.
 */
export const SOCIAL_ICON_PATHS: Record<SocialPlatform, string> = {
  facebook:
    "M13.5 21v-8h2.7l.4-3.1h-3.1V7.9c0-.9.25-1.5 1.55-1.5h1.65V3.63C16.4 3.56 15.42 3.5 14.28 3.5c-2.38 0-4.02 1.45-4.02 4.12V9.9H7.55V13h2.71v8h3.24Z",
  x: "M17.2 3.75h2.94l-6.42 7.34 7.55 9.98h-5.91l-4.63-6.05-5.3 6.05H2.49l6.87-7.85L2.12 3.75h6.06l4.18 5.53 4.84-5.53Zm-1.03 15.56h1.63L7.9 5.39H6.15l10.02 13.92Z",
  instagram:
    "M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41-.56-.22-.96-.48-1.38-.9-.42-.42-.68-.82-.9-1.38-.16-.42-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41 1.27-.06 1.65-.07 4.85-.07Zm0 6.19a3.65 3.65 0 1 0 0 7.3 3.65 3.65 0 0 0 0-7.3Zm0 6.02a2.37 2.37 0 1 1 0-4.74 2.37 2.37 0 0 1 0 4.74Zm4.65-6.17a.85.85 0 1 1-1.7 0 .85.85 0 0 1 1.7 0Z",
  youtube:
    "M21.6 7.2s-.19-1.36-.78-1.96c-.75-.79-1.59-.79-1.98-.84C16.06 4.2 12 4.2 12 4.2h-.01s-4.05 0-6.83.2c-.39.05-1.23.05-1.98.84-.59.6-.78 1.96-.78 1.96S2.2 8.8 2.2 10.4v1.5c0 1.6.2 3.2.2 3.2s.19 1.36.78 1.96c.75.79 1.74.76 2.18.85 1.59.15 6.75.2 6.75.2s4.06-.01 6.84-.21c.39-.05 1.23-.05 1.98-.84.59-.6.78-1.96.78-1.96s.2-1.6.2-3.2v-1.5c0-1.6-.2-3.2-.2-3.2ZM9.94 13.9V8.62l5.22 2.65-5.22 2.63Z",
  tiktok:
    "M16.6 5.82a4.28 4.28 0 0 1-1.03-2.32h-3.1v12.4a2.6 2.6 0 0 1-2.6 2.6 2.6 2.6 0 0 1 0-5.2c.27 0 .53.04.77.12v-3.15a5.75 5.75 0 0 0-.77-.05 5.75 5.75 0 1 0 5.75 5.75V9.4a7.3 7.3 0 0 0 4.26 1.36V7.7a4.3 4.3 0 0 1-3.28-1.88Z",
  threads:
    "M16.72 11.14c-.1-.05-.2-.1-.3-.14-.18-3.29-1.98-5.17-5.01-5.19h-.04c-1.81 0-3.32.77-4.24 2.17l1.66 1.14c.69-1.05 1.78-1.27 2.58-1.27h.03c1 .01 1.75.3 2.24.85.36.41.6.98.71 1.69a12.9 12.9 0 0 0-2.88-.14c-2.9.17-4.76 1.86-4.64 4.21.06 1.19.66 2.22 1.68 2.9.86.57 1.98.85 3.14.79 1.53-.08 2.73-.66 3.57-1.72.64-.8 1.04-1.83 1.22-3.13.75.45 1.3 1.04 1.6 1.75.52 1.2.55 3.18-1.05 4.78-1.4 1.4-3.09 2.01-5.65 2.03-2.84-.02-4.99-.93-6.39-2.71-1.31-1.66-1.98-4.06-2.01-7.14.03-3.08.7-5.48 2.01-7.14C6.35 2.9 8.5 1.99 11.34 1.97c2.86.02 5.05.94 6.5 2.72.71.88 1.25 1.98 1.6 3.26l1.95-.52c-.43-1.58-1.1-2.94-2.02-4.07C17.63 1.1 15.02.03 11.35 0h-.01C7.67.02 5.09 1.1 3.3 3.38 1.71 5.4.89 8.22.86 11.99v.02c.03 3.77.85 6.58 2.44 8.61C5.09 22.9 7.67 23.98 11.34 24h.01c3.26-.02 5.56-.88 7.45-2.77 2.48-2.48 2.4-5.59 1.59-7.5-.59-1.37-1.7-2.48-3.21-3.21Zm-4.87 5.26c-1.28.07-2.61-.5-2.67-1.7-.05-.89.63-1.88 2.75-2 .24-.01.48-.02.71-.02.77 0 1.49.07 2.14.22-.24 3.03-1.67 3.44-2.93 3.5Z"
};

/** Display label for `aria-label`/`title` — the platform name, capitalised the way a reader expects ("X", not "x"). */
export const SOCIAL_PLATFORM_LABEL: Record<SocialPlatform, string> = {
  facebook: "Facebook",
  x: "X",
  instagram: "Instagram",
  youtube: "YouTube",
  tiktok: "TikTok",
  threads: "Threads"
};

export type SocialIconLink = {
  platform: SocialPlatform;
  label: string;
  url: string;
  pathData: string;
};

/**
 * `identity.socialLinks` → the icons this app can actually render, in a
 * stable order (`HOST_PLATFORM`'s own de-duplicated platform order) rather
 * than whatever order the CMS array happens to carry — so the utility bar's
 * icon row never re-shuffles between builds because an editor re-saved the
 * settings form. A link whose URL fails `isHttpUrl` (defence in depth, see
 * file header) or whose host does not match a known platform is silently
 * omitted, never rendered as a broken/generic icon.
 */
export function resolveSocialIcons(
  socialLinks: ReadonlyArray<{ platform: string; url: string }>
): SocialIconLink[] {
  const byPlatform = new Map<SocialPlatform, string>();

  for (const link of socialLinks) {
    if (!isHttpUrl(link.url)) continue;
    const platform = detectSocialPlatform(link.url);
    if (!platform) continue;
    if (!byPlatform.has(platform)) byPlatform.set(platform, link.url);
  }

  const order: SocialPlatform[] = ["facebook", "x", "instagram", "tiktok", "youtube", "threads"];
  const result: SocialIconLink[] = [];
  for (const platform of order) {
    const url = byPlatform.get(platform);
    if (!url) continue;
    result.push({ platform, label: SOCIAL_PLATFORM_LABEL[platform], url, pathData: SOCIAL_ICON_PATHS[platform] });
  }
  return result;
}
