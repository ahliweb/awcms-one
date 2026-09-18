/**
 * Open Graph / Twitter Card meta for the news surface (issue #54, A8) — the
 * page-specific tags `BaseLayout.astro`'s own fixed OG block (`og:type`/
 * `og:url`/`og:title`/`og:description`/`og:site_name`/`og:locale`) does not
 * model: `og:image` and its dimensions, `article:*`, `video:*`, and the
 * `twitter:*` card. PATTERN modeled on `src/lib/jsonld-berita.ts`: a pure
 * builder returning plain data (`MetaTag[]`) that a page hands to
 * `BaseLayout`'s `meta` prop, which renders each entry as one `<meta>`. This
 * file never writes markup and never escapes anything — Astro's own
 * attribute escaping at that one render boundary is the safety line, the
 * same as for the six OG tags the layout already renders from CMS strings.
 *
 * ## Why a builder per page KIND, not one generic function
 *
 * Open Graph's structured properties are namespaced by `og:type`: an
 * `article` carries `article:published_time`/`modified_time`/`section`/
 * `tag`; a `video.other` carries `video:release_date`/`video:tag` and
 * `og:video:url` instead. Emitting `article:*` under `video.other` (or vice
 * versa) is not an error a crawler reports — it is silently ignored — so
 * the three builders below each emit exactly the namespace their type owns
 * and nothing from a neighbour's. `ogType` is returned alongside the tags
 * so a page cannot pair one type's tags with another's `og:type` by
 * accident.
 *
 * ## `og:image` resolution order, and why it matches `ArtikelCard.astro`
 *
 * A post's OWN resolved `featuredMediaId` (`post.image`, issue #47) always
 * wins — it is the editor's deliberate choice and carries real `width`/
 * `height`/`alt`. Only a VIDEO post with no featured image of its own falls
 * back to YouTube's poster — `post.video.thumbnail`, the very same
 * `https://i.ytimg.com/vi/{id}/hqdefault.jpg` URL `src/lib/portable-text.ts`
 * derives for the card thumbnail and the click-to-load facade, so a link
 * preview shows the same picture the card does. `hqdefault` (480×360) is
 * used rather than the larger `maxresdefault.jpg` on purpose: YouTube only
 * serves `maxresdefault` for uploads that had an HD rendition and answers
 * a 404 for the rest, and this app cannot know which it has — pairing a
 * possibly-404 URL with a `summary_large_image` card would produce exactly
 * the broken, empty large-image card the "`twitter:card`" section below
 * exists to avoid (PR #70 review). `hqdefault` exists for every valid
 * video id. No dimensions are emitted for the poster: this app has not
 * fetched it and must not assert a size it has not seen.
 *
 * ## `twitter:card`
 *
 * `summary_large_image` whenever an `og:image` is emitted, else `summary`
 * — a large-image card with no image renders as a bare grey box on X, while
 * a `summary` card degrades to title + description cleanly. `twitter:title`/
 * `twitter:description` are emitted too, as the issue asks, from the same
 * SEO title/description the page passes to the layout (Twitter falls back
 * to `og:*` when they are absent, so these are belt-and-braces rather than
 * load-bearing). `twitter:description` is clamped to X's own 200-character
 * display limit, the same way `BaseLayout` clamps `og:description` at 160.
 *
 * ## Only an `http(s)` URL ever becomes an `og:image`
 *
 * `publicUrl` is CMS data (`media_library` validates it at write time), but
 * this app re-checks the scheme before emitting it — the same posture
 * `src/lib/awcms/profil.ts`'s `parseSocialLinks` takes for a stored URL that
 * ends up in the page. A non-`http(s)` value is dropped, never emitted.
 */
import { ROUTES } from "../config/routes";
import { absoluteUrl } from "../config/site";
import type { ResolvedMedia } from "./awcms/media";
import type { PostDetail } from "./berita";

/**
 * One `<meta>` tag as `BaseLayout.astro`'s `meta` prop takes it — EITHER a
 * `property=` (Open Graph, `article:*`, `video:*`) OR a `name=` (`twitter:*`)
 * tag, never both on one entry, matching how each vocabulary is actually
 * keyed (Open Graph uses RDFa `property`; Twitter's card markup uses
 * `name`).
 */
export type MetaTag =
  | { property: string; content: string }
  | { name: string; content: string };

/** The three `og:type` values `BaseLayout.astro` renders — `website` is its default when a page passes nothing. */
export type OgType = "website" | "article" | "video.other";

export type SocialMeta = { ogType: OgType; meta: MetaTag[] };

/** X's own display limit for `twitter:description`. */
const TWITTER_DESCRIPTION_MAX_LENGTH = 200;

const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

/** `https://www.youtube-nocookie.com/embed/{id}` — the SAME privacy-enhanced origin `src/scripts/video-facade.ts` swaps in on click, so `og:video:url` names the player this page actually uses. */
export function youtubeEmbedUrl(videoId: string): string {
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${videoId}`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** `og:image` + `og:image:width/height/alt` for a resolved media object — dimensions/alt only when the CMS actually reported them, never a guessed value. Empty when `media` is `null` or its URL is not `http(s)`. */
export function ogImageMeta(media: ResolvedMedia | null): MetaTag[] {
  if (!media || !isHttpUrl(media.publicUrl)) return [];

  const tags: MetaTag[] = [{ property: "og:image", content: media.publicUrl }];
  if (media.width !== null && media.width > 0) {
    tags.push({ property: "og:image:width", content: String(media.width) });
  }
  if (media.height !== null && media.height > 0) {
    tags.push({ property: "og:image:height", content: String(media.height) });
  }
  const alt = media.alt?.trim();
  if (alt) tags.push({ property: "og:image:alt", content: alt });
  return tags;
}

function twitterCardMeta(input: {
  title: string;
  description: string | null;
  imageUrl: string | null;
}): MetaTag[] {
  const tags: MetaTag[] = [
    { name: "twitter:card", content: input.imageUrl ? "summary_large_image" : "summary" },
    { name: "twitter:title", content: input.title }
  ];
  const description = input.description?.trim();
  if (description) {
    tags.push({
      name: "twitter:description",
      content: description.slice(0, TWITTER_DESCRIPTION_MAX_LENGTH)
    });
  }
  if (input.imageUrl) tags.push({ name: "twitter:image", content: input.imageUrl });
  return tags;
}

/** The SEO title/description a post page passes to `BaseLayout` — the same precedence `src/pages/berita/[slug].astro` has used since issue #28, kept in one place so `twitter:title`/`twitter:description` can never drift from `<title>`/`og:description`. */
export function postSeoText(post: PostDetail): { title: string; description: string | null } {
  return {
    title: post.seoTitle ?? post.title,
    description: post.metaDescription ?? post.excerpt
  };
}

/**
 * `/berita/[slug]` — `og:type=article`, the post's `og:image` when its
 * featured image resolved, `article:published_time`/`modified_time` (the
 * raw ISO 8601 `publishedAt`/`updatedAt`, the same values the page's
 * `NewsArticle` JSON-LD carries as `datePublished`/`dateModified` — never
 * the WIB display string), `article:section` = the rubrik name, one
 * `article:tag` per tag, and the Twitter card.
 */
export function articleSocialMeta(post: PostDetail): SocialMeta {
  const { title, description } = postSeoText(post);
  const image = ogImageMeta(post.image);
  const imageUrl = post.image && image.length > 0 ? post.image.publicUrl : null;

  const meta: MetaTag[] = [
    ...image,
    { property: "article:published_time", content: post.publishedAt },
    { property: "article:modified_time", content: post.updatedAt },
    ...(post.rubric ? [{ property: "article:section", content: post.rubric.name }] : []),
    ...post.tags.map((tag) => ({ property: "article:tag", content: tag.name })),
    ...twitterCardMeta({ title, description, imageUrl })
  ];

  return { ogType: "article", meta };
}

/**
 * `/video/[slug]` — `og:type=video.other`, `og:image` = the post's own
 * featured image when it resolved, else the post's YouTube poster
 * (`post.video.thumbnail`, `hqdefault.jpg` — see the file header for the
 * precedence and why not `maxresdefault`),
 * `og:video:url` = the privacy-enhanced embed URL the facade itself loads,
 * `video:release_date` and one `video:tag` per tag (the `video` namespace's
 * own equivalents of `article:published_time`/`article:tag`), and the
 * Twitter card — always `summary_large_image`, because a video post always
 * has SOME poster.
 *
 * A post with no playable `videoNews` block (`post.video === null`) is not
 * a video post and never reaches `/video/[slug]` (`src/lib/berita.ts`'s
 * `getVideo()`), so this falls back to `articleSocialMeta` rather than
 * inventing a `video.other` page with no video on it.
 */
export function videoSocialMeta(post: PostDetail): SocialMeta {
  if (!post.video) return articleSocialMeta(post);

  const { title, description } = postSeoText(post);
  const ownImage = ogImageMeta(post.image);
  const usesOwnImage = post.image !== null && ownImage.length > 0;
  const imageUrl = usesOwnImage ? (post.image as ResolvedMedia).publicUrl : post.video.thumbnail;
  const image: MetaTag[] = usesOwnImage ? ownImage : [{ property: "og:image", content: imageUrl }];

  const meta: MetaTag[] = [
    ...image,
    { property: "og:video:url", content: youtubeEmbedUrl(post.video.videoId) },
    { property: "video:release_date", content: post.publishedAt },
    ...post.tags.map((tag) => ({ property: "video:tag", content: tag.name })),
    ...twitterCardMeta({ title, description, imageUrl })
  ];

  return { ogType: "video.other", meta };
}

/**
 * A listing page (the news front page, a rubrik/daerah/mitra archive) —
 * `og:type` stays `website`; the only additions are the site logo as
 * `og:image` (+ dimensions/alt) and a matching `summary` Twitter card, and
 * ONLY when the logo actually resolved. `logo` is `identity.logoMediaId`
 * put through `src/lib/awcms/media.ts`'s `resolveOneMedia` by the caller
 * (`src/layouts/BeritaLayout.astro`); `null` — no logo configured, or an id
 * `media_library` did not resolve — emits nothing at all, so a page's OG
 * block is then byte-identical to what it was before this issue.
 */
export function listingSocialMeta(logo: ResolvedMedia | null): MetaTag[] {
  const image = ogImageMeta(logo);
  if (image.length === 0) return [];
  return [...image, { name: "twitter:card", content: "summary" }];
}

/**
 * `rel="prev"`/`rel="next"` for a paginated rubrik archive — page 1 lives
 * ONLY at `/rubrik/{slug}` (never `/halaman/1`, see
 * `src/pages/rubrik/[slug]/halaman/[n].astro`), so the link back from page
 * 2 points at the bare rubrik URL, matching `RubrikBody.astro`'s own
 * `hrefFor`. Absolute URLs, like the canonical, because a crawler treats
 * these as the same class of hint. Empty for a single-page archive, and
 * `prev` is never emitted for page 1 — an out-of-range `currentPage` is
 * the page's own error to raise, not this function's to paper over.
 */
export function rubrikPaginationLinks(
  slug: string,
  currentPage: number,
  totalPages: number
): { rel: "prev" | "next"; href: string }[] {
  const hrefFor = (page: number): string =>
    absoluteUrl(page === 1 ? ROUTES.rubric(slug) : ROUTES.rubricPage(slug, page));

  const links: { rel: "prev" | "next"; href: string }[] = [];
  if (currentPage > 1) links.push({ rel: "prev", href: hrefFor(currentPage - 1) });
  if (currentPage < totalPages) links.push({ rel: "next", href: hrefFor(currentPage + 1) });
  return links;
}
