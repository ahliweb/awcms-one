/**
 * The static/legal CMS pages (issue #24) — `GET /api/v1/blog/pages/public`
 * and `GET /api/v1/blog/pages/public/{slug}`
 * (`apps/cms/src/pages/api/v1/blog/pages/public.ts` and `public/[slug].ts`),
 * fetched at build time and rendered by `src/pages/halaman/[slug].astro`.
 *
 * Two requests, and the split is awcms's own, not this app's: the LIST
 * route is metadata-only (`title, slug, locale, updatedAt` —
 * `public-blog-directory.ts`'s `listPublicBlogPagesForSitemap`) precisely
 * so a build does not have to download every page's body to learn there are
 * six of them; the DETAIL route carries the body. This app follows that
 * split rather than working around it.
 *
 * ## Public means public — no permission grant needed
 *
 * Unlike `site-profile/composed` and `theming`, both of awcms's blog page
 * routes are guarded by `blog_content.pages.read`, which every machine
 * credential is seeded with (it is the same permission the sitemap/robots/
 * feed surfaces this app already builds would need regardless). A 403/404
 * here still degrades — a tenant that has never enabled `blog_content`, or
 * an awcms instance that predates the endpoint, must still produce a
 * buildable site with zero static pages — but is not expected to be a
 * common case the way `site-profile`/`theming` gaps are.
 */
import { AwcmsApiError, awcmsGet } from "./client";

export type StaticPageSummary = {
  title: string;
  slug: string;
  locale: string;
  updatedAt: string;
};

export type StaticPageDetail = {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  seoTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  locale: string;
  publishedAt: string | null;
  updatedAt: string;
  visibility: "public" | "unlisted" | "private";
  pageType: string;
  /** The canonical body (ADR-0100) — see `src/lib/portable-text.ts`. `contentJson`'s legacy block projection is not read by this app; it renders Portable Text only. */
  bodyPortableText: unknown;
};

function isExpectedRefusal(error: unknown): error is AwcmsApiError {
  return (
    error instanceof AwcmsApiError &&
    (error.status === 403 || error.status === 404)
  );
}

let listCache: Promise<StaticPageSummary[]> | undefined;

/**
 * Every publicly reachable static page, fetched once and memoized. Used
 * both by `getStaticPaths()` in `halaman/[slug].astro` and by the sitemap
 * source (`src/lib/sitemap-sources.ts`) and the footer's per-slug existence
 * check (`Footer.astro`) — one request serves all three.
 */
export function listStaticPages(): Promise<StaticPageSummary[]> {
  listCache ??= fetchStaticPageList();
  return listCache;
}

async function fetchStaticPageList(): Promise<StaticPageSummary[]> {
  try {
    const { pages } = await awcmsGet<{ pages: StaticPageSummary[] }>(
      "/api/v1/blog/pages/public"
    );
    return pages;
  } catch (error) {
    if (isExpectedRefusal(error)) {
      console.warn(
        `[awcms] static pages not read (HTTP ${error.status}) — the ` +
          `footer's legal/press-council links and /halaman/* will be ` +
          `empty. This is expected on a tenant with blog_content not yet ` +
          `configured, or an awcms predating the endpoint.`
      );
      return [];
    }
    throw error;
  }
}

const detailCache = new Map<string, Promise<StaticPageDetail | null>>();

/**
 * One static page's body by slug, or `null` if it is not in the public list
 * (never published, or a race between the two requests). Memoized per slug
 * so `getStaticPaths()` and the page component it hands props to never
 * issue the same request twice.
 */
export function getStaticPage(slug: string): Promise<StaticPageDetail | null> {
  let cached = detailCache.get(slug);
  if (!cached) {
    cached = fetchStaticPage(slug);
    detailCache.set(slug, cached);
  }
  return cached;
}

async function fetchStaticPage(slug: string): Promise<StaticPageDetail | null> {
  try {
    return await awcmsGet<StaticPageDetail>(
      `/api/v1/blog/pages/public/${encodeURIComponent(slug)}`
    );
  } catch (error) {
    if (error instanceof AwcmsApiError && error.status === 404) {
      return null;
    }
    if (isExpectedRefusal(error)) {
      return null;
    }
    throw error;
  }
}

/** Test seam: drops both memoized fetches. */
export function resetStaticPagesCacheForTests(): void {
  listCache = undefined;
  detailCache.clear();
}
