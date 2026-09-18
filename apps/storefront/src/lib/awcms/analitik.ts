/**
 * The `visitor_analytics` read client (issue #49) — the build-time half of
 * the visitor-analytics loop issue #56's beacon (`src/scripts/analitik.ts`,
 * `POST /api/v1/analytics/collect`) feeds: it reads the last seven days'
 * most-viewed paths back out so the news sidebar's "Terpopuler" box can rank
 * real readership rather than restating "latest". Same discipline as every
 * other file in `src/lib/awcms/`: this is the ONE place that knows the
 * route, its query parameter, its permission, and its envelope key —
 * everything above it (`src/components/berita/Sidebar.astro`) gets plain
 * `{ slug, count }` pairs or an already-ranked list of its own posts back.
 *
 * ## The shape below is read from the route file, not the issue text
 *
 * `GET /api/v1/analytics/pages?range=24h|7d|30d|12m` —
 * `apps/cms/src/pages/api/v1/analytics/pages.ts`, gated by
 * `authorizeInTransaction` on `visitor_analytics.dashboard.read`
 * (`DASHBOARD_GUARD` there; the module README's "API" table names the same
 * key for `/summary|pages|devices|locations|security`). `range` defaults to
 * `7d` (`DEFAULT_ANALYTICS_RANGE`, `domain/analytics-range.ts`) — passed
 * explicitly here anyway so this file states the window it asks for rather
 * than inheriting whatever upstream's default becomes. The envelope is
 * `ok({ range, pages })`, where `pages` is `fetchTopPaths`'s `NamedCount[]`
 * (`application/analytics-queries.ts`): `{ name: string; count: number }`,
 * `name` being the event's `path_sanitized` column — human pageviews only
 * (`human_status = 'human'`), top 50 by count. The build credential needs
 * `visitor_analytics.dashboard.read` — added by name to the seed's
 * storefront token permission set (`tools/seed-borneojek-mart.ts`'s
 * `MACHINE_CREDENTIAL_PERMISSION_KEYS`), the same rule issue #47 followed for
 * `media_library.media.read`.
 *
 * ## `path_sanitized` is a path PLUS its surviving query string
 *
 * `domain/path-sanitizer.ts`'s `sanitizePath` strips only the SENSITIVE
 * query parameters (`token`, `code`, `email`, …) and keeps every other one
 * — so `/berita/x`, `/berita/x?utm_source=wa` and `/berita/x?fbclid=…` are
 * THREE distinct rows in the route's answer, each with its own count. A
 * ranking that took the rows at face value would split one article's
 * readership across however many share links it travelled on and rank a
 * less-read article above it. `hitungTayangPerSlug` below therefore
 * collapses every row to the post slug its path names (`/berita/{slug}` or
 * `/video/{slug}`, query and fragment dropped, one trailing slash tolerated
 * even though this app's `trailingSlash: "never"` never emits one) and SUMS
 * the counts per slug before anything is ranked.
 *
 * ## Falls back to "latest" — silently, and why that is the right call
 *
 * `visitor_analytics` is OFF by default (`VISITOR_ANALYTICS_ENABLED`,
 * `apps/cms`'s own switch — `docs/deployment.md`'s "The two switches"). A
 * deployment that never turned it on, a build credential minted before this
 * permission was added to the seed, a tenant where the module is not
 * enabled, or an older `apps/cms` with no such route at all, all answer a
 * `403` (`MODULE_DISABLED`/`ACCESS_DENIED`) or `404`; a freshly enabled
 * module with no events yet answers `200` with `pages: []`; a site whose
 * traffic all landed on non-post paths maps to nothing. In every one of
 * those cases `pilihTerpopuler` degrades to the newest posts — the exact
 * list `src/lib/berita.ts`'s pre-#49 `getTerpopuler()` always rendered —
 * and the sidebar heading stays "Terpopuler" with NO "sorted by date"
 * caveat in the UI: the issue asks for the fallback to be recorded in code
 * (this comment), not surfaced to a reader, because a caveat there would be
 * a statement about the deployment's configuration, not about the news. The
 * degrade is the same "optional editorial inventory" posture
 * `src/lib/awcms/blog.ts` takes for ad placements; anything OTHER than a
 * 403/404 (5xx, timeout, unreachable) still fails the build loudly, the
 * rule every fetch in this directory follows.
 */
import { AwcmsApiError, awcmsGet } from "./client";

const ANALYTICS_PAGES_PATH = "/api/v1/analytics/pages";

/** The window "Terpopuler" ranks over — the issue's "last 7 days", and one of the route's four accepted values (`ANALYTICS_RANGES`, `domain/analytics-range.ts`). */
export const TERPOPULER_RANGE = "7d";

/** One row of `GET /api/v1/analytics/pages`'s `pages` — `NamedCount` (`application/analytics-queries.ts`) verbatim: `name` is `path_sanitized`, `count` the human pageviews in the window. */
export type TopPath = { name: string; count: number };

function isExpectedRefusal(error: unknown): error is AwcmsApiError {
  return error instanceof AwcmsApiError && (error.status === 403 || error.status === 404);
}

let topPathsCache: Promise<TopPath[]> | undefined;

/**
 * The window's top paths, fetched once and memoized for the whole build
 * (same shape as every other once-per-build read in `src/lib/awcms/`) — the
 * sidebar renders on every news page, and the route's answer is a rollup
 * over the SAME window either way. A 403/404 degrades to `[]` — see the
 * file header for exactly which deployment states answer that, and why
 * the caller cannot tell them apart from "no traffic yet" (nor needs to).
 */
export function getTopPaths(): Promise<TopPath[]> {
  topPathsCache ??= fetchTopPaths();
  return topPathsCache;
}

async function fetchTopPaths(): Promise<TopPath[]> {
  try {
    const { pages } = await awcmsGet<{ range: string; pages: TopPath[] }>(ANALYTICS_PAGES_PATH, {
      range: TERPOPULER_RANGE
    });
    return Array.isArray(pages) ? pages : [];
  } catch (error) {
    if (isExpectedRefusal(error)) return [];
    throw error;
  }
}

/**
 * The two URL shapes a post is published at (`src/config/routes.ts`'s
 * `ROUTES.article`/`ROUTES.videoArticle`), and NOTHING else: `/berita`
 * itself (the front page), `/berita/feed.xml`, `/rubrik/...`, `/tag/...`
 * and every store path never name a post and are deliberately not matched.
 * A slug is `[^/?#]+` rather than a stricter slug alphabet because the CMS
 * owns slug validation, not this file — anything the CMS published under
 * `/berita/` is a slug here, and a path that names no known post simply
 * fails to map (see `pilihTerpopuler`).
 */
const POST_PATH_PATTERN = /^\/(?:berita|video)\/([^/?#]+?)\/?(?:[?#].*)?$/;

/**
 * Pure — the post slug a `path_sanitized` value names, or `null` when the
 * path is not a post page. `decodeURIComponent` because the beacon sends
 * `location.pathname`, which is percent-encoded for a non-ASCII slug, while
 * `PostSummary.slug` is the CMS's plain string; a malformed escape (a
 * hand-crafted beacon) yields `null` rather than a throw.
 */
export function slugDariPath(path: string): string | null {
  const match = POST_PATH_PATTERN.exec(path.trim());
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/**
 * Pure — pageviews per post slug, summed across every `path_sanitized`
 * variant of the same post (see the file header's query-string note). A row
 * with a non-finite or non-positive `count` contributes nothing. Insertion
 * order is the route's own (count desc, name asc), kept so a downstream
 * sort's tie-break is deterministic.
 */
export function hitungTayangPerSlug(paths: readonly TopPath[]): Map<string, number> {
  const perSlug = new Map<string, number>();
  for (const { name, count } of paths) {
    if (typeof name !== "string" || !Number.isFinite(count) || count <= 0) continue;
    const slug = slugDariPath(name);
    if (!slug) continue;
    perSlug.set(slug, (perSlug.get(slug) ?? 0) + count);
  }
  return perSlug;
}

/**
 * Pure — up to `limit` of `kandidat` ranked by the window's pageviews
 * (highest first; a tie keeps `kandidat`'s own order, which every caller
 * passes newest-first), topped up from `terbaru` (newest-first, already
 * ranked posts skipped) when fewer than `limit` posts have any pageviews
 * at all. When NOTHING maps — the module is off, the credential lacks the
 * permission, there is no traffic yet — the result is simply the first
 * `limit` of `terbaru`: the pre-#49 "Terpopuler" list, unchanged (see the
 * file header for why that degrade is silent). Generic over anything with a
 * `slug` so `tests/analitik-terpopuler.test.ts` can assert the rule without
 * building a whole `PostSummary`.
 *
 * Topping up (rather than rendering a one-item box on a site with one
 * measured article) keeps the sidebar's shape stable across the first days
 * after the module is switched on, when only a handful of posts have any
 * events; the two sources are never distinguished in the UI for the same
 * reason the whole-list fallback is not.
 */
export function pilihTerpopuler<T extends { slug: string }>(
  kandidat: readonly T[],
  terbaru: readonly T[],
  tayangPerSlug: ReadonlyMap<string, number>,
  limit: number
): T[] {
  if (limit <= 0) return [];

  const diukur = kandidat
    .map((post, index) => ({ post, index, count: tayangPerSlug.get(post.slug) ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.post);

  if (diukur.length >= limit) return diukur;

  const sudah = new Set(diukur.map((post) => post.slug));
  const hasil = [...diukur];
  for (const post of terbaru) {
    if (hasil.length >= limit) break;
    if (sudah.has(post.slug)) continue;
    sudah.add(post.slug);
    hasil.push(post);
  }
  return hasil;
}

/** Test/build seam: drops the memoized top-paths fetch. */
export function resetAnalitikCacheForTests(): void {
  topPathsCache = undefined;
}
