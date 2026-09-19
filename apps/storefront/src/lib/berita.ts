/**
 * The news domain layer (issue #28) — the seam between `src/lib/awcms/{blog,
 * wilayah,lembaga}.ts` and every `/berita`, `/rubrik`, `/daerah`, `/mitra`,
 * `/video`, `/tag`, `/penulis`, `/arsip` page. Mirrors the SHAPE of
 * `src/lib/catalog.ts` (issue #5): a memoized, once-per-build index built
 * from the raw fetches, and pages never see a term id, an institution id,
 * or a keyset cursor — only the plain, already-cross-referenced shapes
 * below.
 *
 * ## `PostSummary` — the #27/#28 seam
 *
 * `getPosts(opts)` is exported specifically so issue #27's home page can
 * import it for a "recent news" teaser without depending on anything else
 * in this file — see this type's own docblock for the exact contract.
 */
import {
  getAllPosts,
  getAllTerms,
  getAllInstitutions,
  type RawPost,
  type RawTerm,
  type RawInstitution
} from "./awcms/blog";
import { getResolvableRegionsByCode } from "./awcms/wilayah";
import { getMitraList, type MitraSummary } from "./awcms/lembaga";
import { resolveMedia, type ResolvedMedia } from "./awcms/media";
import {
  documentHasPlayableVideo,
  extractPlayableVideoInfo,
  collectGalleryMediaObjectIds,
  type PlayableVideoInfo
} from "./portable-text";
import { arsipBulanWIB } from "./tanggal";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type TermSummary = { slug: string; name: string };

export type RegionRef = { code: string; slug: string; name: string; level: number };

export type InstitutionRef = {
  slug: string;
  name: string;
  /**
   * The institution's emblem, already resolved to a public URL (issue #59 /
   * C1). seputarborneo attaches a regency's emblem to an ARTICLE; here it
   * lives on the institution the article is filed under, so one upload
   * serves every article of that institution and changing it updates them
   * all — the property seputarborneo's own "satu logo dipakai berulang"
   * rule was after, with one source of truth instead of a per-post picker.
   * `null` when the institution has no emblem, or when its id does not
   * resolve (a stale reference renders nothing, never a broken image).
   */
  logo: ResolvedMedia | null;
  /** Alt text for that emblem. `null` → decorative beside the institution's own name (`alt=""`). */
  logoAlt: string | null;
};

/**
 * One published post, as every listing page (front page, rubrik/daerah/
 * mitra/tag/penulis/arsip index, search) needs it. Documented here per
 * issue #28's own instruction, since issue #27 imports this type via
 * `getPosts()`: every field is either a plain scalar or an already-resolved
 * reference (a rubrik's slug+name, never its id) — nothing here requires a
 * second awcms request to use.
 */
export type PostSummary = {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  /** ISO 8601, always present — a post with no `publishedAt` never reaches this list (see `buildIndex` below). */
  publishedAt: string;
  updatedAt: string;
  /** The post's primary `category` term, or `null` if uncategorised. A post with more than one `category` term keeps only the first (awcms's own `termIds` order). */
  rubric: TermSummary | null;
  /** Every `tag` term. */
  tags: TermSummary[];
  /** Derived from the post's institutions' `regionCode` — see `src/lib/awcms/wilayah.ts`'s file header for why a post carries no region field of its own. `null` when none of the post's institutions resolve to a region this build knows how to name. */
  region: RegionRef | null;
  institutions: InstitutionRef[];
  /** Opt-in public byline (ADR-0109) — `null` means "attribute to the publisher". */
  authorByline: string | null;
  /** Whether this post's body carries at least one renderable `videoNews` block — a video post lives at `/video/{slug}`, never `/berita/{slug}` (see `getPosts`/`getVideo` below). */
  isVideo: boolean;
  /**
   * The post's `featuredMediaId`, resolved (issue #47) — `null` when the
   * post has none, or when the id did not resolve (unverified, deleted, or
   * not yet uploaded — `src/lib/awcms/media.ts`'s own docblock). Every card
   * and hero figure renders this when present; a video post with no
   * `featuredMediaId` of its own falls back to `video.thumbnail` instead
   * (see `src/components/berita/ArtikelCard.astro`).
   */
  image: ResolvedMedia | null;
  /** The first playable `videoNews` block's provider/id/poster (issue #47), or `null` for a non-video post — see `src/lib/portable-text.ts`'s `extractPlayableVideoInfo`. */
  video: PlayableVideoInfo | null;
};

export type PostDetail = PostSummary & {
  bodyPortableText: unknown;
  metaDescription: string | null;
  canonicalUrl: string | null;
  seoTitle: string | null;
};

export type RubrikNode = TermSummary & {
  parentSlug: string | null;
  children: RubrikNode[];
};

export type RubrikArchive = {
  term: RubrikNode;
  /** Root → immediate parent, excluding `term` itself. */
  ancestors: TermSummary[];
  /** This rubrik's own posts PLUS every descendant rubrik's posts (issue #28: "the parent index includes children's posts"). */
  posts: PostSummary[];
};

export type DaerahArchive = { region: RegionRef; posts: PostSummary[] };

export type DaerahLink = RegionRef;

export type MitraArchive = { mitra: MitraSummary; posts: PostSummary[] };

export type TagArchive = { term: TermSummary; posts: PostSummary[] };

export type AuthorArchive = { slug: string; name: string; posts: PostSummary[] };

export type PagedResult<T> = { items: T[]; currentPage: number; totalPages: number };

// ---------------------------------------------------------------------------
// Slugs derived from a name (regions and author bylines have no CMS-issued
// slug of their own — see src/lib/awcms/wilayah.ts's file header) —
// deterministic, ASCII, hyphenated, never re-derived twice for the same
// input within one build (memoized per input string, not per call site).
// ---------------------------------------------------------------------------

const slugifyCache = new Map<string, string>();

export function slugifyName(name: string): string {
  const cached = slugifyCache.get(name);
  if (cached !== undefined) return cached;

  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  slugifyCache.set(name, slug);
  return slug;
}

// ---------------------------------------------------------------------------
// The build-wide index
// ---------------------------------------------------------------------------

/**
 * Declared standalone rather than as `RubrikNode & {id, parentId}`: an
 * intersection would keep `children` typed as `RubrikNode[]` (the PUBLIC
 * type's own field), not `RubrikNodeInternal[]` — which breaks every
 * recursive walk below (`node.children` would type-error against a function
 * expecting `RubrikNodeInternal`). This type re-states every `RubrikNode`
 * field itself specifically so `children` can recurse into ITSELF.
 */
export type RubrikNodeInternal = {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  parentSlug: string | null;
  children: RubrikNodeInternal[];
};

type Indexed = {
  posts: PostSummary[];
  rawPostsBySlug: Map<string, RawPost>;
  rubrikNodesBySlug: Map<string, RubrikNodeInternal>;
  rubrikRoots: RubrikNodeInternal[];
  tagTerms: TermSummary[];
  mitraBySlug: Map<string, MitraSummary>;
  /** Every media object this build's visible posts reference (`featuredMediaId` plus every gallery item's `mediaObjectId`), resolved ONCE — the map `src/components/berita/ArtikelView.astro` passes to `renderPortableText` (issue #47). */
  mediaById: ReadonlyMap<string, ResolvedMedia>;
};

let indexCache: Promise<Indexed> | undefined;

function getIndex(): Promise<Indexed> {
  indexCache ??= buildIndex();
  return indexCache;
}

/**
 * A post survives onto this build's public listings when it is published,
 * public, has a `publishedAt`, and that `publishedAt` is not more than
 * `CLOCK_SKEW_MS` in the future — the same clock-skew tolerance the sibling
 * `media-lenterakalteng` template applies for the same reason: a build
 * machine's clock and awcms's own are never perfectly synchronised, and a
 * post scheduled to the second should not flicker in and out of the
 * listing depending on which side's clock is a few seconds fast.
 */
const CLOCK_SKEW_MS = 15 * 60 * 1000;

function isPubliclyVisible(post: RawPost, now: number): post is RawPost & { publishedAt: string } {
  return (
    post.status === "published" &&
    post.visibility === "public" &&
    typeof post.publishedAt === "string" &&
    new Date(post.publishedAt).getTime() <= now + CLOCK_SKEW_MS
  );
}

/**
 * Pure — builds the rubrik forest from a flat `category`-taxonomy list via
 * `parentId`, with no fetch involved. Exported ONLY for
 * `tests/berita-rubrik.test.ts` to exercise the hierarchy-resolution rule
 * directly, the same way `src/lib/awcms/theme.ts`'s `extractThemeToken` is
 * exported for its own unit test rather than only reachable through a live
 * fetch — `getRubrikTree()`/`getRubrik()` above are this function's only
 * production callers.
 */
export function buildRubrikForest(terms: RawTerm[]): {
  bySlug: Map<string, RubrikNodeInternal>;
  roots: RubrikNodeInternal[];
} {
  const categoryTerms = terms.filter((t) => t.taxonomyType === "category");
  const byId = new Map<string, RubrikNodeInternal>();

  for (const term of categoryTerms) {
    byId.set(term.id, {
      id: term.id,
      slug: term.slug,
      name: term.name,
      parentId: term.parentId,
      parentSlug: null,
      children: []
    });
  }

  const roots: RubrikNodeInternal[] = [];

  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) {
      node.parentSlug = parent.slug;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const bySlug = new Map<string, RubrikNodeInternal>();
  for (const node of byId.values()) bySlug.set(node.slug, node);

  return { bySlug, roots };
}

/** Pure — `RubrikNodeInternal` → the public `RubrikNode` shape (drops `id`/`parentId`). Exported for the same reason `buildRubrikForest` above is. */
export function toPublicRubrikNode(node: RubrikNodeInternal): RubrikNode {
  return {
    slug: node.slug,
    name: node.name,
    parentSlug: node.parentSlug,
    children: node.children.map(toPublicRubrikNode)
  };
}

async function toPostSummary(
  raw: RawPost & { publishedAt: string },
  termById: Map<string, RawTerm>,
  institutionById: Map<string, RawInstitution>,
  regionRefsByCode: Map<string, RegionRef>,
  mediaById: ReadonlyMap<string, ResolvedMedia>
): Promise<PostSummary> {
  const terms = raw.termIds
    .map((id) => termById.get(id))
    .filter((t): t is RawTerm => Boolean(t));

  const rubricTerm = terms.find((t) => t.taxonomyType === "category") ?? null;
  const tags = terms
    .filter((t) => t.taxonomyType === "tag")
    .map((t): TermSummary => ({ slug: t.slug, name: t.name }));

  const institutions = raw.institutionIds
    .map((id) => institutionById.get(id))
    .filter((i): i is RawInstitution => Boolean(i));

  let region: RegionRef | null = null;
  for (const institution of institutions) {
    if (!institution.regionCode) continue;
    const resolved = regionRefsByCode.get(institution.regionCode);
    if (resolved) {
      region = resolved;
      break;
    }
  }

  return {
    id: raw.id,
    slug: raw.slug,
    title: raw.title,
    excerpt: raw.excerpt,
    publishedAt: raw.publishedAt,
    updatedAt: raw.updatedAt,
    rubric: rubricTerm ? { slug: rubricTerm.slug, name: rubricTerm.name } : null,
    tags,
    region,
    institutions: institutions.map((i) => ({
      slug: i.slug,
      name: i.name,
      logo: i.logoMediaId ? mediaById.get(i.logoMediaId) ?? null : null,
      logoAlt: i.logoAlt ?? null
    })),
    authorByline: raw.authorByline,
    isVideo: documentHasPlayableVideo(raw.bodyPortableText),
    image: raw.featuredMediaId ? mediaById.get(raw.featuredMediaId) ?? null : null,
    video: extractPlayableVideoInfo(raw.bodyPortableText)
  };
}

/** `RegionRecord` (`src/lib/awcms/wilayah.ts`) → `RegionRef`, adding the derived `slug` every consumer in this file needs — the ONE place that conversion happens, so `/daerah/{slug}` and a post's own `region` field always agree on what a region's slug is. Exported for `tests/berita-rubrik.test.ts`'s region-slug-mapping coverage. */
export function toRegionRef(record: { code: string; name: string; level: number }): RegionRef {
  return { code: record.code, slug: slugifyName(record.name), name: record.name, level: record.level };
}

async function buildIndex(): Promise<Indexed> {
  const [rawPosts, rawTerms, rawInstitutions, rawRegionsByCode, mitraList] = await Promise.all([
    getAllPosts(),
    getAllTerms(),
    getAllInstitutions(),
    getResolvableRegionsByCode(),
    getMitraList()
  ]);

  const termById = new Map(rawTerms.map((t) => [t.id, t]));
  const institutionById = new Map(rawInstitutions.map((i) => [i.id, i]));
  const regionRefsByCode = new Map(
    [...rawRegionsByCode.entries()].map(([code, record]) => [code, toRegionRef(record)])
  );
  const now = Date.now();

  const visible = rawPosts.filter((p): p is RawPost & { publishedAt: string } =>
    isPubliclyVisible(p, now)
  );

  // Every media id this build's visible posts could possibly render —
  // `featuredMediaId` plus every gallery item's `mediaObjectId` — collected
  // up front so the whole build resolves media in ONE batched, chunked call
  // (issue #47) rather than one request per post per image.
  const mediaIds: string[] = [];
  for (const raw of visible) {
    if (raw.featuredMediaId) mediaIds.push(raw.featuredMediaId);
    mediaIds.push(...collectGalleryMediaObjectIds(raw.bodyPortableText));
  }
  // …plus every institution's emblem (issue #59). Collected here, in the
  // same batch, rather than resolved per article: the 24 institutions of a
  // regional news portal are a handful of ids shared by thousands of posts,
  // and `resolveMedia` de-duplicates them into the same chunked call.
  for (const institution of rawInstitutions) {
    if (institution.logoMediaId) mediaIds.push(institution.logoMediaId);
  }
  const mediaById = await resolveMedia(mediaIds);

  const posts: PostSummary[] = [];
  for (const raw of visible) {
    posts.push(await toPostSummary(raw, termById, institutionById, regionRefsByCode, mediaById));
  }

  // Newest first, source-slug tiebreak — `Array#sort` is stable, but two
  // posts CAN legitimately share one `publishedAt` to the second, and a
  // tiebreak keyed on something immutable (the slug) is what keeps this
  // build's own ordering identical to the last one when nothing changed.
  posts.sort((a, b) => {
    const byDate = new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    return byDate !== 0 ? byDate : a.slug.localeCompare(b.slug);
  });

  const rawPostsBySlug = new Map(visible.map((p) => [p.slug, p]));
  const { bySlug: rubrikNodesBySlug, roots: rubrikRoots } = buildRubrikForest(rawTerms);

  const tagTerms = rawTerms
    .filter((t) => t.taxonomyType === "tag")
    .map((t): TermSummary => ({ slug: t.slug, name: t.name }));

  return {
    posts,
    rawPostsBySlug,
    rubrikNodesBySlug,
    rubrikRoots,
    tagTerms,
    mitraBySlug: new Map(mitraList.map((m) => [m.slug, m])),
    mediaById
  };
}

/** Test/build seam: drops the memoized index so a test can rebuild it against different underlying fetches. */
export function resetBeritaIndexForTests(): void {
  indexCache = undefined;
}

/**
 * The whole build's resolved-media lookup (issue #47) — `src/components/
 * berita/ArtikelView.astro` passes this to `renderPortableText` so a post's
 * body can render its own gallery images. A flat, whole-build map rather
 * than one scoped per post: every id is a UUID (collision-free across
 * posts), and a single map is simpler than threading a per-post subset
 * through every render call for no observable difference.
 */
export async function getResolvedMedia(): Promise<ReadonlyMap<string, ResolvedMedia>> {
  const { mediaById } = await getIndex();
  return mediaById;
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/**
 * Every published, non-video post — or the `limit` most recent, when given.
 * `PostSummary`'s own docblock documents the contract issue #27 depends on;
 * this signature must not change without updating that dependency.
 *
 * Excludes video posts (`isVideo: true`) on purpose: a video post's
 * canonical page is `/video/{slug}`, not `/berita/{slug}`, and this app
 * never publishes the same post at two URLs (avoiding a duplicate-content
 * canonical conflict `src/lib/jsonld-berita.ts`'s `NewsArticle` schema would
 * otherwise have to pick a side on). Use `getVideo()` for the video list.
 */
export async function getPosts(opts: { limit?: number } = {}): Promise<PostSummary[]> {
  const { posts } = await getIndex();
  const nonVideo = posts.filter((p) => !p.isVideo);
  return typeof opts.limit === "number" ? nonVideo.slice(0, opts.limit) : nonVideo;
}

/** One post by slug (video or not) — `/berita/[slug].astro` and `/video/[slug].astro` both call this and check `isVideo` themselves to decide whether the slug belongs on their route. */
export async function getPost(slug: string): Promise<PostDetail | null> {
  const { posts, rawPostsBySlug } = await getIndex();

  const summary = posts.find((p) => p.slug === slug);
  if (!summary) return null;

  const raw = rawPostsBySlug.get(slug);
  if (!raw) return null;

  return {
    ...summary,
    bodyPortableText: raw.bodyPortableText,
    metaDescription: raw.metaDescription,
    canonicalUrl: raw.canonicalUrl,
    seoTitle: raw.seoTitle
  };
}

/** Every video post (`isVideo: true`) — `/video/index.astro` and `/video/[slug].astro`'s `getStaticPaths()`. */
export async function getVideo(opts: { limit?: number } = {}): Promise<PostSummary[]> {
  const { posts } = await getIndex();
  const video = posts.filter((p) => p.isVideo);
  return typeof opts.limit === "number" ? video.slice(0, opts.limit) : video;
}

// "Terpopuler" (issue #28: "by `visitor_analytics` rollup when available,
// else latest") used to be a `getTerpopuler(limit)` here that only ever
// implemented the "else latest" branch — no `visitor_analytics` read
// endpoint was in that issue's verified-safe scope. Issue #49 superseded it:
// `src/lib/awcms/analitik.ts` reads the real `GET /api/v1/analytics/pages`
// rollup and `src/components/berita/Sidebar.astro` ranks `getPosts()`/
// `getVideo()` with it, falling back to `getPosts({ limit })` — the exact
// list the removed function returned. Nothing imported it any more, so it
// is gone rather than kept as a misleading second entry point.

/** Up to `limit` OTHER posts sharing `post`'s rubrik, newest first — `[]` for an uncategorised post (nothing to relate it by). */
export async function getRelatedPosts(post: PostSummary, limit = 3): Promise<PostSummary[]> {
  if (!post.rubric) return [];
  const { posts } = await getIndex();
  const rubricSlug = post.rubric.slug;
  return posts.filter((p) => p.id !== post.id && p.rubric?.slug === rubricSlug).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Rubrik (category taxonomy — hierarchical)
// ---------------------------------------------------------------------------

/** Every top-level rubrik, each with its full descendant tree — `/berita`'s "one section per top-level rubrik" and `/rubrik` nav. */
export async function getRubrikTree(): Promise<RubrikNode[]> {
  const { rubrikRoots } = await getIndex();
  return rubrikRoots.map(toPublicRubrikNode);
}

/**
 * Every rubrik in `nodes`' trees, flattened depth-first (parent before its
 * children) — `getStaticPaths()` in `src/profil/berita/pages/rubrik/[slug]/index.astro`/
 * `halaman/[n].astro`/`feed.xml.ts` and `src/lib/sitemap-sources.ts` all
 * need "every rubrik at any depth", not just the top-level roots
 * `getRubrikTree()` returns. Declared ONCE, here, and exported — four
 * separate local copies of this same function (one per call site) is what
 * this file used to have, until they collided: Astro/Vite's SSR chunk
 * bundling can merge same-named top-level function declarations from
 * different route modules into one shared chunk, and one copy silently
 * shadowed the others at runtime (`flattenRubrik is not defined` during
 * prerendering). A single shared export has no name left to collide with.
 */
export function flattenRubrikTree(nodes: readonly RubrikNode[]): RubrikNode[] {
  return nodes.flatMap((node) => [node, ...flattenRubrikTree(node.children)]);
}

/** Pure — `node`'s own slug plus every descendant's, at any depth. Exported for the same reason `buildRubrikForest` above is. */
export function collectDescendantSlugs(node: RubrikNodeInternal): Set<string> {
  const slugs = new Set<string>([node.slug]);
  const stack = [...node.children];
  while (stack.length > 0) {
    const current = stack.pop()!;
    slugs.add(current.slug);
    stack.push(...current.children);
  }
  return slugs;
}

/** Pure — root → immediate parent, excluding `node` itself. Exported for the same reason `buildRubrikForest` above is. */
export function collectAncestors(
  node: RubrikNodeInternal,
  bySlug: Map<string, RubrikNodeInternal>
): TermSummary[] {
  const chain: TermSummary[] = [];
  let currentParentId = node.parentId;

  while (currentParentId) {
    const parent = [...bySlug.values()].find((n) => n.id === currentParentId);
    if (!parent) break;
    chain.unshift({ slug: parent.slug, name: parent.name });
    currentParentId = parent.parentId;
  }

  return chain;
}

/** One rubrik (any depth), its own posts PLUS every descendant rubrik's posts, and its ancestor chain for a breadcrumb — `null` when the slug does not exist. */
export async function getRubrik(slug: string): Promise<RubrikArchive | null> {
  const { rubrikNodesBySlug, posts } = await getIndex();
  const node = rubrikNodesBySlug.get(slug);
  if (!node) return null;

  const descendantSlugs = collectDescendantSlugs(node);
  const rubrikPosts = posts.filter((p) => p.rubric && descendantSlugs.has(p.rubric.slug));

  return {
    term: toPublicRubrikNode(node),
    ancestors: collectAncestors(node, rubrikNodesBySlug),
    posts: rubrikPosts
  };
}

// ---------------------------------------------------------------------------
// Daerah (region archive)
// ---------------------------------------------------------------------------

/** Every region this build can resolve a name for, as `{slug, name, level}` — the region list `/daerah`'s own nav renders (14 Kalteng regencies/cities + provinces of "Lintas Kalimantan", per the issue's IA — see `src/lib/awcms/wilayah.ts`). */
export async function listDaerahLinks(): Promise<DaerahLink[]> {
  const regionsByCode = await getResolvableRegionsByCode();
  return [...regionsByCode.values()].map(toRegionRef);
}

/** One region's own posts (via its institutions' `regionCode` — see `src/lib/awcms/wilayah.ts`'s file header), or `null` when the slug does not resolve to a region this build knows how to name. */
export async function getDaerah(slug: string): Promise<DaerahArchive | null> {
  const [regionsByCode, { posts }] = await Promise.all([getResolvableRegionsByCode(), getIndex()]);
  const region = [...regionsByCode.values()].map(toRegionRef).find((r) => r.slug === slug);
  if (!region) return null;

  return {
    region,
    posts: posts.filter((p) => p.region?.code === region.code)
  };
}

// ---------------------------------------------------------------------------
// Mitra (institution landing)
// ---------------------------------------------------------------------------

/** One institution's own posts (via `institutionIds`), or `null` when the slug does not exist. */
export async function getMitra(slug: string): Promise<MitraArchive | null> {
  const { mitraBySlug, posts } = await getIndex();
  const mitra = mitraBySlug.get(slug);
  if (!mitra) return null;

  return {
    mitra,
    posts: posts.filter((p) => p.institutions.some((i) => i.slug === slug))
  };
}

/**
 * Institutions with at least one post published in the CURRENT WIB calendar
 * month — `/berita`'s own "Mitra" strip (issue #28's IA). Computed at build
 * time, so "this month" means the month the build ran, not a visitor's
 * (the same static/runtime rule every other build-time value in this app
 * already follows).
 *
 * `now` defaults to the real clock and is only ever overridden by
 * `tests/berita-rubrik.test.ts`, which needs a FIXED month to assert
 * against — a static test fixture cannot otherwise agree with "the current
 * month" on whatever day this suite happens to run.
 */
export async function getMitraStripBulanIni(now: Date = new Date()): Promise<MitraSummary[]> {
  const { posts, mitraBySlug } = await getIndex();
  const currentMonth = arsipBulanWIB(now.toISOString());

  const activeSlugs = new Set<string>();
  for (const post of posts) {
    const postMonth = arsipBulanWIB(post.publishedAt);
    if (postMonth.yyyy !== currentMonth.yyyy || postMonth.mm !== currentMonth.mm) continue;
    for (const institution of post.institutions) activeSlugs.add(institution.slug);
  }

  return [...activeSlugs]
    .map((slug) => mitraBySlug.get(slug))
    .filter((m): m is MitraSummary => Boolean(m));
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Every tag actually assigned to at least one visible post — a tag cloud entry for a tag no post uses is a link to a permanently empty page, so this filters against `posts`, not the raw taxonomy list. */
export async function getTags(): Promise<TermSummary[]> {
  const { posts } = await getIndex();
  const seen = new Map<string, string>();
  for (const post of posts) {
    for (const tag of post.tags) {
      if (!seen.has(tag.slug)) seen.set(tag.slug, tag.name);
    }
  }
  return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
}

/** One tag's own posts, or `null` when no visible post carries it. */
export async function getTag(slug: string): Promise<TagArchive | null> {
  const { posts, tagTerms } = await getIndex();
  const matched = posts.filter((p) => p.tags.some((t) => t.slug === slug));
  if (matched.length === 0) return null;

  const term = tagTerms.find((t) => t.slug === slug) ?? matched[0]!.tags.find((t) => t.slug === slug)!;

  return { term, posts: matched };
}

// ---------------------------------------------------------------------------
// Authors (Penulis) — byline-based, since there is no author entity/route
// ---------------------------------------------------------------------------

/** Every distinct byline in use, as `{slug, name}` — `/penulis`'s own index, if one is ever needed; used today by `getStaticPaths()` in `src/profil/berita/pages/penulis/[slug].astro`. */
export async function listAuthors(): Promise<Array<{ slug: string; name: string }>> {
  const { posts } = await getIndex();
  const seen = new Map<string, string>();
  for (const post of posts) {
    if (post.authorByline) {
      const slug = slugifyName(post.authorByline);
      if (!seen.has(slug)) seen.set(slug, post.authorByline);
    }
  }
  return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
}

/** One author's own bylined posts, or `null` when no visible post carries that byline. */
export async function getAuthor(slug: string): Promise<AuthorArchive | null> {
  const { posts } = await getIndex();
  const matched = posts.filter((p) => p.authorByline && slugifyName(p.authorByline) === slug);
  if (matched.length === 0) return null;

  return { slug, name: matched[0]!.authorByline!, posts: matched };
}

// ---------------------------------------------------------------------------
// Monthly archive
// ---------------------------------------------------------------------------

/** Every `{yyyy, mm}` a visible post's WIB publish month falls into, each exactly once — `/arsip/[yyyy]/[mm].astro`'s `getStaticPaths()`. */
export async function listArsipBulan(): Promise<Array<{ yyyy: string; mm: string }>> {
  const { posts } = await getIndex();
  const seen = new Set<string>();
  const result: Array<{ yyyy: string; mm: string }> = [];

  for (const post of posts) {
    const { yyyy, mm } = arsipBulanWIB(post.publishedAt);
    const key = `${yyyy}-${mm}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ yyyy, mm });
    }
  }

  return result;
}

/** Every post published in `yyyy`/`mm`, WIB calendar month — `[]` for a month with nothing, not an error. */
export async function getArsipBulan(yyyy: string, mm: string): Promise<PostSummary[]> {
  const { posts } = await getIndex();
  return posts.filter((post) => {
    const parts = arsipBulanWIB(post.publishedAt);
    return parts.yyyy === yyyy && parts.mm === mm;
  });
}

// ---------------------------------------------------------------------------
// Pagination — page 1 lives at the bare archive path, page N>=2 at
// `.../halaman/{n}` (`src/config/routes.ts`'s `ROUTES.rubricPage`) — never
// duplicated at both, and an empty section is "page 1 of 1", never "of 0".
// ---------------------------------------------------------------------------

export const RUBRIK_PAGE_SIZE = 10;

export function paginate<T>(
  items: readonly T[],
  page: number,
  perPage: number = RUBRIK_PAGE_SIZE
): PagedResult<T> {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const currentPage = Math.min(Math.max(1, Math.floor(page)), totalPages);
  const start = (currentPage - 1) * perPage;

  return { items: items.slice(start, start + perPage), currentPage, totalPages };
}

// ---------------------------------------------------------------------------
// Reading time (issue #28's Accessibility/SEO bullet)
// ---------------------------------------------------------------------------

const WORDS_PER_MINUTE = 200;

/**
 * Estimated reading time in whole minutes, floored at 1 — strips HTML tags
 * from the RENDERED body and counts words. Safe to do with a plain regex
 * only because the input is always this app's own escaped, closed-vocabulary
 * renderer output (`src/lib/portable-text.ts`), never raw CMS HTML — the
 * same precondition `src/profil/berita/pages/berita/[slug].astro` already relies on when
 * it injects that same HTML via `set:html`.
 */
export function estimasiWaktuBacaMenit(bodyHtml: string): number {
  const text = bodyHtml.replace(/<[^>]*>/g, " ");
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  return Math.max(1, Math.ceil(words.length / WORDS_PER_MINUTE));
}

// ---------------------------------------------------------------------------
// RSS 2.0 (issue #28: "20 latest, full content:encoded") — pure, so
// `tests/berita-feed.test.ts` can assert validity without a network.
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** CDATA cannot nest — a body that itself contains the literal sequence `]]>` must split it, the standard escape for CDATA content. */
function escapeCdata(value: string): string {
  return value.replace(/]]>/g, "]]]]><![CDATA[>");
}

export type BeritaFeedItem = {
  title: string;
  link: string;
  guid: string;
  description: string;
  contentHtml: string;
  /** ISO 8601 — converted to RFC 822 (`Date#toUTCString()`) here, once, so no caller has to. */
  publishedAt: string;
};

export function renderBeritaRssXml(
  channel: { title: string; link: string; description: string },
  items: readonly BeritaFeedItem[]
): string {
  const itemsXml = items
    .map(
      (item) =>
        `  <item>\n` +
        `    <title>${escapeXml(item.title)}</title>\n` +
        `    <link>${escapeXml(item.link)}</link>\n` +
        `    <guid isPermaLink="true">${escapeXml(item.guid)}</guid>\n` +
        `    <pubDate>${escapeXml(new Date(item.publishedAt).toUTCString())}</pubDate>\n` +
        `    <description>${escapeXml(item.description)}</description>\n` +
        `    <content:encoded><![CDATA[${escapeCdata(item.contentHtml)}]]></content:encoded>\n` +
        `  </item>`
    )
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>\n` +
    `  <title>${escapeXml(channel.title)}</title>\n` +
    `  <link>${escapeXml(channel.link)}</link>\n` +
    `  <description>${escapeXml(channel.description)}</description>\n` +
    `${itemsXml}\n` +
    `</channel></rss>\n`
  );
}
