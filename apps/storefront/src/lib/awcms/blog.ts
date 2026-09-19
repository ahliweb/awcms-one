/**
 * Raw `blog_content` reads for the news surface (issue #28) — posts,
 * taxonomy terms, institutions, active ad placements, and the legacy-URL
 * redirect rules this app turns into a static 301 map. Same discipline as
 * `src/lib/awcms/pages.ts`/`profil.ts`: this file is the only place that
 * knows a path, a query parameter, or an envelope key for any of these five
 * resources — everything above it (`src/lib/berita.ts`, then every page)
 * gets a plain array or record back.
 *
 * ## Every shape below is read from the route/application code, not the
 * issue text or the OpenAPI doc alone
 *
 * - `GET /api/v1/blog/posts` — list endpoint, `src/pages/api/v1/blog/
 *   posts/index.ts`. `?status=published&order=created_at&view=full&limit=`
 *   is the ONLY combination that returns `bodyPortableText` at all (the
 *   default view is a title/slug/date summary with no body — see that
 *   route's own docblock for the real incident this shape confused: "a
 *   client that believed it built an entire static site with every article
 *   body empty"). `view=full` therefore ALSO returns `termIds`/
 *   `institutionIds`/`authorByline` in the same row, so a build here never
 *   needs the single-post-by-id endpoint at all — one list walk, exactly
 *   the shape `src/lib/catalog.ts` already established for products.
 *   Envelope: `ok({ posts: page.items, nextCursor: page.nextCursor })`.
 * - `GET /api/v1/blog/terms` — `src/pages/api/v1/blog/terms/index.ts`.
 *   No `taxonomyType` filter is sent: this app wants BOTH `category`
 *   (rubrik) and `tag` terms in one call and splits them client-side
 *   (`src/lib/berita.ts`), the same way it needs both branches of
 *   institutions below. Envelope: `ok({ terms: page.items, nextCursor })`.
 * - `GET /api/v1/blog/institutions` — `src/pages/api/v1/blog/institutions/
 *   index.ts`. No `?branch=` filter (this app wants both legislative and
 *   executive), and — verified against that route — genuinely NOT
 *   paginated: `ok({ institutions })`, no `nextCursor` field at all, unlike
 *   every other list here.
 * - `GET /api/v1/news-portal/ad-placements/active` —
 *   `src/pages/api/v1/news-portal/ad-placements/active.ts`. All twelve
 *   slots in one call, already rotated/capped server-side. Envelope:
 *   `ok({ slots })`. Deliberately NOT memoized as aggressively as the
 *   others would suggest — see `src/lib/awcms/iklan.ts` for why one build
 *   still only calls this once despite the response being explicitly
 *   documented as not byte-stable between calls.
 * - `GET /api/v1/seo/redirects` — `src/pages/api/v1/seo/redirects/
 *   index.ts`. `?state=active` only; there is no `?origin=` filter
 *   server-side, so `origin === "legacy_blog"` is applied here, client-side,
 *   against `redirect-directory.ts`'s `RedirectRecord` shape. Envelope:
 *   `ok({ redirects: ..., nextCursor })`.
 *
 * ## What this file deliberately does NOT call
 *
 * - `GET /api/v1/media/objects` / `GET /api/v1/media/public-origin` — issue
 *   #28 recorded here that this app had no way to resolve `featuredMediaId`/
 *   a gallery item's `mediaObjectId`/`thumbnailMediaObjectId` to a URL yet.
 *   Issue #47 built that client (`src/lib/awcms/media.ts`) — a SEPARATE
 *   file, deliberately: this one stays the raw `blog_content`/
 *   `seo_distribution` reader, `media.ts` is the raw `media_library` reader,
 *   and `src/lib/berita.ts` is what combines the two into a post's already-
 *   resolved `image`/`video` fields. `RawPost.featuredMediaId` itself is
 *   unchanged — still a bare id — this file's own job is still only to hand
 *   that id upward, never to resolve it.
 * - `GET /api/v1/news-portal/homepage-sections/composed` — its section
 *   vocabulary (`headline`/`latest_posts`/`featured_posts`/`editor_picks`/
 *   `category_grid`/`gallery_block`) has no way to express "one section per
 *   top-level rubrik with an Indeks link", which is what `/berita`'s front
 *   page actually needs — and the issue's own Lib list for this file names
 *   only `posts`/`terms`/`institutions`/`pages/public` plus the two
 *   idn-regions/media-origin reads, not this endpoint. `/berita` is
 *   composed directly from `getPosts()`/`getRubrik()`/`getVideo()`/
 *   `getMitra()` instead (`src/lib/berita.ts`).
 */
import { AwcmsApiError, awcmsGet } from "./client";

function isExpectedRefusal(error: unknown): error is AwcmsApiError {
  return (
    error instanceof AwcmsApiError &&
    (error.status === 403 || error.status === 404)
  );
}

/**
 * A runaway-loop backstop for every keyset walk in this file, same
 * reasoning as `src/lib/catalog.ts`'s `MAX_PAGES`: not measured against this
 * tenant's real scale (nothing about it exists to measure yet), chosen only
 * as "clearly larger than one tenant's news archive will be for a long
 * time".
 */
const MAX_PAGES = 200;

/**
 * Walks one keyset-paginated `blog_content`/`seo_distribution` list to
 * exhaustion. Shared by posts/terms/redirects below — institutions is the
 * one resource that is NOT paginated (see file header) and does not use
 * this helper.
 */
async function walkKeysetPages<Row>(
  path: string,
  query: Record<string, string | number | undefined>,
  rowsKey: string,
  resourceNoun: string
): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;

  for (let page = 1; ; page += 1) {
    const response = await awcmsGet<Record<string, unknown>>(path, {
      ...query,
      cursor
    });

    const pageRows = response[rowsKey];
    if (Array.isArray(pageRows)) rows.push(...(pageRows as Row[]));

    const nextCursor = response["nextCursor"];
    if (typeof nextCursor !== "string" || nextCursor.length === 0) return rows;

    if (page >= MAX_PAGES) {
      throw new Error(
        `Stopped walking ${path} after ${MAX_PAGES} pages (${rows.length} ` +
          `${resourceNoun}) and awcms still returned a cursor. Either the ` +
          `cursor is not advancing, or this tenant's ${resourceNoun} really ` +
          `is that large — see src/lib/catalog.ts's MAX_PAGES docblock for ` +
          `the same tradeoff. Returning what has been collected so far is ` +
          `NOT an answer: a short list that looks complete would publish ` +
          `every gate green.`
      );
    }

    cursor = nextCursor;
  }
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

const POSTS_PATH = "/api/v1/blog/posts";

/** Server-side max for `view=full` (`blog-post-list-query.ts`); `MAX_PAGES` above is the backstop on the WALK, not this per-page size. */
const POST_PAGE_SIZE = 50;

/** One row of `GET /api/v1/blog/posts?view=full`, trimmed to the fields this app reads — verified field-by-field against `BlogPostFeedView` (`blog-post-directory.ts`). */
export type RawPost = {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  /** The canonical body (ADR-0100) — see `src/lib/portable-text.ts`. `contentJson.blocks` is a derived, lossy projection this app never reads. */
  bodyPortableText: unknown;
  status: string;
  visibility: string;
  featuredMediaId: string | null;
  seoTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  locale: string;
  publishedAt: string | null;
  updatedAt: string;
  termIds: string[];
  institutionIds: string[];
  /** Opt-in public byline (ADR-0109) — `null` means "attribute to the publisher", never a raw account name. */
  authorByline: string | null;
};

let postsCache: Promise<RawPost[]> | undefined;

/**
 * Every post this build is willing to publish — fetched once, memoized,
 * walking `?status=published&order=created_at&view=full`. Unlike
 * `src/lib/catalog.ts`'s products, a 403/404 here is NOT caught: this is the
 * primary content type the whole issue exists to publish, so "the CMS said
 * no" degrades no better than "the CMS is unreachable" would — both would
 * publish a news site with zero articles and every gate green.
 */
export function getAllPosts(): Promise<RawPost[]> {
  postsCache ??= walkKeysetPages<RawPost>(
    POSTS_PATH,
    { status: "published", order: "created_at", view: "full", limit: POST_PAGE_SIZE },
    "posts",
    "posts"
  );
  return postsCache;
}

// ---------------------------------------------------------------------------
// Taxonomy terms (rubrik = category, tags = tag)
// ---------------------------------------------------------------------------

const TERMS_PATH = "/api/v1/blog/terms";

/** Server-side max (`blog-term-list-query.ts`). */
const TERM_PAGE_SIZE = 200;

/** One row of `GET /api/v1/blog/terms` — verified against `BlogTermView` (`blog-taxonomy-directory.ts`). */
export type RawTerm = {
  id: string;
  taxonomyType: "category" | "tag" | "channel" | "topic";
  parentId: string | null;
  name: string;
  slug: string;
  description: string | null;
};

let termsCache: Promise<RawTerm[]> | undefined;

/**
 * Every term (all four taxonomy types, unfiltered), fetched once and
 * memoized — `src/lib/berita.ts` splits `category` (rubrik, hierarchical via
 * `parentId`) from `tag` (flat) client-side. A 403/404 degrades to an empty
 * vocabulary: a tenant with `blog_content` enabled but no taxonomy set up
 * yet is a real, buildable state.
 */
export function getAllTerms(): Promise<RawTerm[]> {
  termsCache ??= fetchAllTerms();
  return termsCache;
}

async function fetchAllTerms(): Promise<RawTerm[]> {
  try {
    return await walkKeysetPages<RawTerm>(
      TERMS_PATH,
      { order: "created_at", limit: TERM_PAGE_SIZE },
      "terms",
      "terms"
    );
  } catch (error) {
    if (isExpectedRefusal(error)) return [];
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Institutions (Mitra)
// ---------------------------------------------------------------------------

const INSTITUTIONS_PATH = "/api/v1/blog/institutions";

/** One row of `GET /api/v1/blog/institutions` — verified against `InstitutionView` (`institution-directory.ts`). No logo/media field exists on this row at all — `src/profil/berita/pages/mitra/[slug].astro` renders name/description/posts and nothing else. */
export type RawInstitution = {
  id: string;
  branch: "legislative" | "executive";
  name: string;
  slug: string;
  regionCode: string | null;
  description: string | null;
  /**
   * The institution's emblem, as a bare `media_library` id — resolved to a
   * URL through `resolveMedia` like every other media reference in this app
   * (issue #59 / C1; upstream awcms#806 added the column and the two DTO
   * fields, and this repo received them through the `apps/cms` subtree
   * pull). `null` for an institution whose emblem nobody has uploaded.
   *
   * Optional on this type, not required: an `apps/cms` older than that
   * subtree pull answers without the field at all, and a build against one
   * must render no logo rather than crash.
   */
  logoMediaId?: string | null;
  /** Alt text authored beside the emblem. `null`/absent → the logo is decorative beside the institution's own name, and renders with an empty `alt`. */
  logoAlt?: string | null;
};

let institutionsCache: Promise<RawInstitution[]> | undefined;

/**
 * Every institution, fetched once with NO `?branch=` filter (this app wants
 * both) and memoized. Unlike every other list in this file, the route
 * genuinely returns everything in one unpaginated array — `ok({
 * institutions })`, no `nextCursor` — verified against the route file, not
 * assumed from the pattern the others share.
 */
export function getAllInstitutions(): Promise<RawInstitution[]> {
  institutionsCache ??= fetchAllInstitutions();
  return institutionsCache;
}

async function fetchAllInstitutions(): Promise<RawInstitution[]> {
  try {
    const { institutions } = await awcmsGet<{ institutions: RawInstitution[] }>(
      INSTITUTIONS_PATH
    );
    return institutions;
  } catch (error) {
    if (isExpectedRefusal(error)) return [];
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Active ad placements
// ---------------------------------------------------------------------------

const AD_PLACEMENTS_ACTIVE_PATH = "/api/v1/news-portal/ad-placements/active";

/**
 * The twelve slot keys `AD_PLACEMENT_KEYS` declares
 * (`blog-content/domain/ad-placement-policy.ts`) — re-declared locally
 * rather than imported, the same convention `src/lib/catalog.ts` uses for
 * row shapes that live outside `domain/`'s pure-type layer
 * `@awcms-one/kontrak` is scoped to (`ad-placement-policy.ts` IS `domain/`,
 * but re-exporting a plain string-literal array through a type-only package
 * would need a value export, which `@awcms-one/kontrak`'s own contract
 * forbids — see that package's `src/index.ts` docblock).
 */
export const AD_PLACEMENT_KEYS = [
  "header_banner",
  "below_headline",
  "homepage_middle",
  "homepage_bottom",
  "article_top",
  "article_middle",
  "article_bottom",
  "sidebar_top",
  "sidebar_middle",
  "sidebar_bottom",
  "category_archive_top",
  "search_result_top"
] as const;

export type AdPlacementKey = (typeof AD_PLACEMENT_KEYS)[number];

/** One creative, verified against `PublicAdPlacement` (`ad-placements/active.ts`). `mediaPublicUrl` is a real, already-resolved absolute URL — issue #28 could not render it as this app's CSP (`img-src 'self'`, `server/penyaji.mjs`) had no exemption for the CMS's media origin. Issue #47 widens `img-src` with that origin (`src/pages/csp.json.ts`, from `GET /api/v1/media/public-origin`), so `src/components/berita/IklanSlot.astro` now renders a real `<img>` for this field, re-checked there as a genuine `http(s)` URL before use. */
export type PublicAdPlacement = {
  id: string;
  name: string;
  linkUrl: string | null;
  mediaPublicUrl: string;
  mediaAltText: string | null;
  contentClass: "standard" | "advertorial" | "sponsored";
};

let adPlacementsCache: Promise<Partial<Record<AdPlacementKey, PublicAdPlacement[]>>> | undefined;

/**
 * Every slot's current creatives, fetched once and memoized for the WHOLE
 * build — even though the route's own docblock says the rotated selection
 * is not byte-stable between calls. Calling it once and reusing the result
 * everywhere is what makes a single build internally consistent: the same
 * `article_top` creative on every page of one build, not a different one
 * per page because each page re-rolled the rotation independently.
 *
 * A 403/404 degrades to "no slots have anything" — `docs/awcms/` names the
 * header/in-article/sidebar placements as OPTIONAL editorial inventory, not
 * content this build fails without.
 */
export function getActiveAdPlacements(): Promise<
  Partial<Record<AdPlacementKey, PublicAdPlacement[]>>
> {
  adPlacementsCache ??= fetchActiveAdPlacements();
  return adPlacementsCache;
}

async function fetchActiveAdPlacements(): Promise<
  Partial<Record<AdPlacementKey, PublicAdPlacement[]>>
> {
  try {
    const { slots } = await awcmsGet<{
      slots: Partial<Record<AdPlacementKey, PublicAdPlacement[]>>;
    }>(AD_PLACEMENTS_ACTIVE_PATH);
    return slots;
  } catch (error) {
    if (isExpectedRefusal(error)) return {};
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Legacy redirects (seputarborneo / beritasampit URL compatibility)
// ---------------------------------------------------------------------------

const REDIRECTS_PATH = "/api/v1/seo/redirects";

/** One row of `GET /api/v1/seo/redirects`, trimmed — verified against `RedirectRecord` (`redirect-directory.ts`). */
export type RawRedirect = {
  sourcePath: string;
  targetType: "relative_same_tenant" | "verified_external";
  target: string;
  origin: "manual" | "slug_change" | "domain_change" | "locale_change" | "import" | "legacy_blog";
};

let redirectsCache: Promise<RawRedirect[]> | undefined;

/**
 * Every ACTIVE `origin: "legacy_blog"` redirect rule, fetched once and
 * memoized. There is no `?origin=` filter on the route (only `state`/
 * `targetType`/`q`), so the origin check happens here, client-side, against
 * every active rule this tenant has — a tenant with a large general
 * redirect table (slug changes, domain changes) pays one extra filter pass,
 * not a second endpoint.
 */
export function getLegacyRedirectRows(): Promise<RawRedirect[]> {
  redirectsCache ??= fetchLegacyRedirectRows();
  return redirectsCache;
}

async function fetchLegacyRedirectRows(): Promise<RawRedirect[]> {
  try {
    const rows = await walkKeysetPages<RawRedirect>(
      REDIRECTS_PATH,
      { state: "active" },
      "redirects",
      "redirects"
    );
    return rows.filter((row) => row.origin === "legacy_blog");
  } catch (error) {
    if (isExpectedRefusal(error)) return [];
    throw error;
  }
}

/** Test seam: drops every memoized fetch in this file. */
export function resetBlogCachesForTests(): void {
  postsCache = undefined;
  termsCache = undefined;
  institutionsCache = undefined;
  adPlacementsCache = undefined;
  redirectsCache = undefined;
}
