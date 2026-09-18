/**
 * The external origins this build's HTML actually references, collected at
 * BUILD time so `server/penyaji.mjs` can widen its `img-src` to exactly
 * those and nothing else.
 *
 * ## Why this exists at all
 *
 * Until issue #23 gave products images, every asset this storefront served
 * was same-origin and `server/penyaji.mjs`'s CSP could be `'self'`
 * everywhere with no exemption to justify. Product photos are the first
 * thing that breaks that: `images[].publicUrl` is resolved by `apps/cms`
 * through `media_library`, and it points at the CMS's own public media
 * origin (R2, a CDN, or the CMS host itself — a deployment's choice, not
 * this app's). An `<img src>` at that origin under `img-src 'self'` is
 * blocked by the browser, silently, with every gate in this repo green:
 * the HTML is correct, the build is correct, and the reader sees a broken
 * page.
 *
 * ## Why it is DERIVED, not configured
 *
 * The obvious alternative is an env variable (`PUBLIC_MEDIA_ORIGIN`) that
 * an operator sets to the CMS's media origin. That is one more thing to
 * keep in step with the CMS's own configuration, and a wrong value fails
 * exactly the same silent way this function exists to prevent. Deriving
 * the origins from the URLs the CMS ACTUALLY sent for this build cannot
 * disagree with the content it is protecting — if the CMS starts serving
 * images from a second origin, the next build widens the policy to match,
 * and if it stops, the policy narrows again.
 *
 * The trade is stated plainly: a deployment whose catalog has NO images
 * yet emits no origins, so the first product photo added needs a rebuild
 * before it renders — the same rebuild that page already needs to appear
 * at all (ADR-0002: everything here is baked at build time).
 *
 * ## What it deliberately does NOT collect
 *
 * Only `http:`/`https:` origins, and only from fields this app renders as
 * an `<img src>`. A `data:` URI, a relative path, or anything that does
 * not parse is dropped rather than widening the policy with a value
 * nobody can read back — and the result is sorted and de-duplicated so the
 * artifact is byte-stable across a rebuild that changed nothing.
 */

/** The origin (`https://host[:port]`) of an absolute `http(s)` URL, or `null` for anything else. */
export function originOf(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    // A relative path (already same-origin, so `'self'` covers it), a
    // `data:`/`blob:` URI, or free text the CMS should never have sent.
    return null;
  }
}

/**
 * Every distinct external origin among `urls`, sorted. Same-origin
 * references are impossible to recognise here (this build does not know
 * its own deployed origin at the time the artifact is written — `SITE_URL`
 * is the canonical site, not necessarily the host serving it), so a URL
 * that happens to sit on the site's own origin is listed too. Listing it is
 * harmless: `'self'` already allows it, and a duplicate origin in a CSP
 * directive is not an error.
 */
export function collectOrigins(urls: Iterable<string | null | undefined>): string[] {
  const origins = new Set<string>();

  for (const url of urls) {
    const origin = originOf(url);
    if (origin) origins.add(origin);
  }

  return [...origins].sort();
}

/**
 * The shape written to `dist/client/csp.json` and read back by
 * `server/penyaji.mjs`'s `readCspOrigins`. Versioned from the start: this
 * file is produced by one process and consumed by another that may have
 * been built earlier (a container running yesterday's server against
 * today's client bundle is a real deployment state), and a reader that
 * cannot tell an old shape from a new one degrades in the worst possible
 * direction — a policy that is silently wider or narrower than intended.
 */
export type CspOriginsArtifact = {
  version: 1;
  /** Origins to add to `img-src`. */
  imgSrc: string[];
  /** Origins to add to `connect-src`. Empty in this increment — no page here makes a browser-side request to another origin yet (issue #30 adds the first). */
  connectSrc: string[];
  /**
   * Origins to add to `frame-src` (issue #47: `https://www.youtube-nocookie.com`,
   * added only when this build has at least one playable `videoNews` block
   * for its click-to-load facade to embed — `src/pages/csp.json.ts`).
   * Additive, not a version bump: an OLDER `server/penyaji.mjs` (built
   * before this field existed) simply ignores it and `frame-src` stays
   * `'none'` until that side is updated too — `readCspOrigins` there already
   * degrades an unknown key to nothing, never a crash. Empty by default, the
   * same "no page needed this yet" state `connectSrc` started in.
   */
  frameSrc: string[];
};

export function buildCspOriginsArtifact(
  imageUrls: Iterable<string | null | undefined>,
  connectOrigins: Iterable<string | null | undefined> = [],
  frameOrigins: Iterable<string | null | undefined> = []
): CspOriginsArtifact {
  return {
    version: 1,
    imgSrc: collectOrigins(imageUrls),
    connectSrc: collectOrigins(connectOrigins),
    frameSrc: collectOrigins(frameOrigins)
  };
}
