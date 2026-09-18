/**
 * Legacy URL → `/berita/{slug}` (or `/video/{slug}`, for a video post — see
 * `buildLegacyRedirectMap`'s own docblock) redirect map (issue #28) — turns
 * `awcms_seo_redirects` rows with `origin: "legacy_blog"`
 * (`src/lib/awcms/blog.ts`'s `getLegacyRedirectRows()`) into a static
 * `sourcePath -> targetPath` map, baked into the build by
 * `src/pages/index/pengalihan-legacy.json.ts` and read once, at startup, by
 * `server/penyaji.mjs`'s additive redirect hook — never at request time, so
 * a finished build still never contacts awcms again.
 *
 * ## Why the CMS's own `target` column is not used verbatim
 *
 * `target` (verified against `redirect-directory.ts`'s `RedirectRecord`) is
 * whatever path the CMS's own operator/import tooling recorded as the
 * eventual destination for a `relative_same_tenant` rule — most plausibly
 * this CMS's OWN themed `/blog/{tenantCode}/{slug}` page (ADR-0071's
 * permanent vocabulary for `apps/cms` itself), which has no reason to know
 * this storefront's `/berita/{slug}` (or `/video/{slug}`) shape exists. The
 * one fact both sides agree on is the post's SLUG, not the path shape
 * around it — so this file reads only the trailing path segment of `target`
 * and rebuilds the destination in this app's own URL vocabulary
 * (`ROUTES.article`/`ROUTES.videoArticle`).
 *
 * `verified_external` rows are skipped outright: they point somewhere this
 * storefront does not serve, and sending a reader through this app to an
 * outside URL is not this hook's job.
 */
import { ROUTES } from "../config/routes";

export type LegacyRedirectRow = {
  sourcePath: string;
  targetType: "relative_same_tenant" | "verified_external";
  target: string;
};

/** The last non-empty path segment of `path` (query/fragment stripped first), or `null` for a path with none (`/`, `""`). */
function lastPathSegment(path: string): string | null {
  const withoutQuery = path.split(/[?#]/)[0] ?? "";
  const segments = withoutQuery.split("/").filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : null;
}

/**
 * Normalizes a stored/incoming source path the same way on both sides of
 * the comparison — decode, strip query/fragment, drop one trailing slash —
 * so `/News/1-x.html` and an incoming `/News/1-x.html?utm=fb` (or a stored
 * `/2024/01/02/judul/` and an incoming request with no trailing slash
 * mismatch) still compare equal. An undecodable path is left as-is rather
 * than thrown on — it simply will not match anything real, which is the
 * correct outcome for a malformed URL nobody could have followed anyway.
 *
 * ONE shape is exempt from the query strip: `/video/?video={id}-…` (issue
 * #58/B2's own template for a video row) carries its whole identity in the
 * query — unlike `?utm=fb` on an otherwise-complete path, there is no path
 * left once it is removed. Stripping it here the same way would collapse
 * every video row onto the identical bare `/video` key, which
 * `buildLegacyRedirectMap`'s own conflict guard would then reject the
 * moment a second, differently-targeted video row exists (the throw two
 * DIFFERENT sources are supposed to trigger, misfiring on what are really
 * DIFFERENT sources). This function still has no reason to know which
 * table's row it is looking at, so it recognizes the shape by prefix, not
 * by a caller-supplied flag — `apps/storefront/server/pengalihan-
 * aturan.mjs`'s `findVideoRowTargetById` (issue #55/A9) is what actually
 * reads this preserved key at request time, by the same prefix.
 */
export function normalizeLegacyPath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURI(path);
  } catch {
    // Left as `path` — see docblock.
  }

  const withoutFragment = decoded.split("#")[0] ?? "";

  if (/^\/video\/?\?video=/.test(withoutFragment)) {
    return withoutFragment;
  }

  const withoutQuery = withoutFragment.split("?")[0] ?? "";

  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) {
    return withoutQuery.slice(0, -1);
  }

  return withoutQuery;
}

/**
 * Builds the static `sourcePath -> targetPath` map. Pure — no I/O — so the
 * mapping rule is unit-testable with fixed rows
 * (`tests/berita-pengalihan-legacy.test.ts`), the same seam
 * `src/lib/sitemap.ts`'s XML renderers already use.
 *
 * `videoSlugs` — every video post's slug (`getVideo()`, this app's own
 * `isVideo: true` partition) — decides which of this app's two article
 * route shapes a resolved slug actually lives at: `getPosts()`'s own
 * docblock is explicit that a video post is NEVER also published at
 * `/berita/{slug}` (one canonical URL per post), so a `legacy_blog` row
 * whose slug belongs to a video post must resolve to `/video/{slug}`, not
 * `/berita/{slug}` — the latter is a page this app never builds for that
 * slug, so every redirect for that video's `/news/{id}-…`/`/video/
 * ?video={id}-…` legacy URL would otherwise 404. Optional, defaulting to
 * an empty set, so every call site (and every existing test) predating this
 * distinction keeps its old, correct-for-a-non-video-post behavior with no
 * change.
 *
 * Refuses (throws) rather than silently picking a winner: two rows
 * normalizing to the same source path but disagreeing on the destination
 * is a build defect worth seeing, not a "last one wins" a reader would
 * never notice went wrong.
 */
export function buildLegacyRedirectMap(
  rows: readonly LegacyRedirectRow[],
  videoSlugs: ReadonlySet<string> = new Set()
): Record<string, string> {
  const map: Record<string, string> = {};

  for (const row of rows) {
    if (row.targetType !== "relative_same_tenant") continue;

    const slug = lastPathSegment(row.target);
    if (!slug) continue;

    const source = normalizeLegacyPath(row.sourcePath);
    const destination = videoSlugs.has(slug) ? ROUTES.videoArticle(slug) : ROUTES.article(slug);

    const existing = map[source];
    if (existing !== undefined && existing !== destination) {
      throw new Error(
        `Legacy redirect source "${source}" maps to two different ` +
          `destinations ("${existing}" and "${destination}") across the ` +
          `fetched awcms_seo_redirects rows. Fix the conflicting rule in ` +
          `awcms rather than picking one silently here — a reader following ` +
          `an old link deserves one, deterministic destination.`
      );
    }

    map[source] = destination;
  }

  return map;
}
