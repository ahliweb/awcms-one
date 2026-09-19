/**
 * Renders awcms's canonical CMS-page/post body — Portable Text — to HTML at
 * build time (issue #24, extended by issue #28 for the news surface).
 * PATTERN adapted from the sibling `media-lenterakalteng`/`apps/situs`'s
 * `src/lib/portable-text.ts`, not ported verbatim.
 *
 * Vocabulary verified against `apps/cms/src/modules/blog-content/domain/
 * portable-text.ts` — the CLOSED vocabulary ADR-0100 defines: block styles
 * `normal`/`h1`-`h6`/`blockquote`, list items `bullet`/`number`, decorators
 * `strong`/`em`/`code` (no `underline` — an underlined span that is not a
 * link is a usability defect), one annotation type `link`, and two object
 * blocks `gallery`/`videoNews`. This same vocabulary is used for both
 * `blog_content` pages (issue #24) and posts (issue #28) — verified
 * against `apps/cms/src/modules/blog-content/domain/portable-text-
 * validation.ts`, which enforces one closed schema for both content types.
 *
 * ## `videoNews` and `gallery` images render REAL media now (issue #47)
 *
 * Issue #28 rendered `videoNews` as a real outbound watch link (never an
 * `<iframe>`) and a captioned `gallery` item as a `<figure>`/`<figcaption>`
 * with no `<img>` at all — both deliberate deviations, recorded there,
 * because this app had no media-object client yet and no CSP exemption for
 * a third-party frame origin. Issue #47 lifts both trims now that a client
 * exists (`src/lib/awcms/media.ts`) and the CSP is widened for the two
 * origins this needs (`src/pages/csp.json.ts`):
 *
 * - `gallery` item `mediaType: "image"` with a `mediaObjectId` that resolves
 *   (via the `resolvedMedia` map every caller now passes as this function's
 *   second argument — see `renderPortableText` below) renders a real
 *   `<figure><img loading="lazy" decoding="async" width height alt>
 *   <figcaption>` — the item's own `caption` and the resolved object's
 *   credit (`creditLine`/`sourceName`) joined with " · " when both exist.
 *   An item whose `mediaObjectId` does NOT resolve (unverified/deleted/not
 *   yet uploaded), that carries the legacy `url`-only shape (no id this
 *   client can resolve), or that is not an image at all still degrades to
 *   the ORIGINAL issue-#24 placeholder figure — never a broken `<img>`.
 * - `videoNews` (`provider`/`videoId`/`title`/`caption`/`durationSeconds`/
 *   `sourceLabel`, verified against `video-news-block-validation.ts`) renders
 *   ONE OF TWO shapes, chosen per render call by `renderPortableText`'s
 *   `options.videoMode` (see that function's own docblock, "The video
 *   facade is opt-in, per render call" — this is NOT a global switch, and
 *   defaults to the safe one):
 *   - `"link"` (the default) — the original issue-#28 real, semantic
 *     outbound watch link, no script/`<img>`/`<iframe>` of any kind.
 *   - `"facade"` — a click-to-load facade: a real `<button>` showing the
 *     `https://i.ytimg.com/vi/{id}/hqdefault.jpg` poster (a fixed YouTube
 *     CDN convention — no media-object resolution needed for this one), and
 *     `apps/storefront/src/scripts/video-facade.ts` (loaded only from
 *     `src/profil/berita/pages/video/[slug].astro`, the only route a playable `videoNews`
 *     block can ever appear on — see `src/lib/berita.ts`'s own routing
 *     rule, and the ONE call site that passes `"facade"`) swaps it for a
 *     real `<iframe src="https://www.youtube-nocookie.com/embed/{id}">` on
 *     activation. No third-party script/frame loads before that click; a
 *     `<noscript>` fallback links straight to the YouTube watch page for a
 *     reader with JavaScript off. The button is a real, focusable HTML
 *     element — Enter/Space activates it with no extra keyboard-handling
 *     code needed.
 *
 * A `gallery` item's `caption` field is the ONLY editorial field awcms's
 * `GalleryBlockItem` schema carries besides the image reference itself
 * (verified against `gallery-block-renderer.ts`) — there is no separate
 * "credit" field on the ITEM to distinguish from it; the credit rendered
 * alongside it comes from the resolved media OBJECT's own
 * `creditLine`/`sourceName` (Issue #782's rights fields, `src/lib/awcms/
 * media.ts`), not from anything the gallery block itself carries.
 *
 * "Internal tag links" (also named in issue #28's spec) needed NO renderer
 * change at all: verified against `internal-tag-linking.ts`, awcms's own
 * auto-linking is a RENDER-TIME HTML post-processing transform the CMS
 * applies only to its own themed pages — never an authored Portable Text
 * node or annotation. A genuine internal link (to this app's own
 * `/tag/{slug}`, say) is already carried by the ordinary `link` annotation
 * below, which already accepts a relative `/...` href; every article page
 * additionally renders an explicit tag list from `termIds`
 * (`src/lib/berita.ts`), which is more reliably useful to a reader than an
 * incidental in-body auto-link would be.
 *
 * ## The public signature DOES change (issue #47)
 *
 * `renderPortableText` gains two OPTIONAL arguments after `document`:
 * `resolvedMedia: ReadonlyMap<string, ResolvedMedia>` (defaulting to an
 * empty map) and `options: { videoMode?: "facade" | "link" }` (defaulting
 * to `{}`, i.e. `videoMode: "link"`) — so every existing call site
 * (`src/pages/halaman/[slug].astro`, issue #24; `src/pages/{berita,
 * rubrik/[slug]}/feed.xml.ts`'s RSS `content:encoded`) keeps compiling AND
 * keeps rendering exactly the safe, script-free shape it always did.
 * `src/lib/berita.ts` builds the real `resolvedMedia` map once per build
 * (every visible post's `featuredMediaId` plus every gallery item's
 * `mediaObjectId`, batched through `resolveMedia`), and
 * `src/components/berita/ArtikelView.astro` passes it through, along with a
 * `videoMode` prop the PAGE decides (`"facade"` only from `src/profil/berita/pages/video/
 * [slug].astro`, which alone mounts `video-facade.ts` — see
 * `renderPortableText`'s own docblock, "The video facade is opt-in, per
 * render call"). An empty map with `videoMode: "link"` (the default, and
 * every issue-#24/#28 test fixture's real case: no `mediaObjectId` resolves
 * against nothing) falls back to the ORIGINAL placeholder text —
 * `tests/portable-text.test.ts`'s two gallery/videoNews assertions still
 * pass for exactly that reason. `tests/berita-portable-text.test.ts`'s
 * issue-#28 assertion that a well-formed `videoNews` renders a real link is
 * now the `videoMode: "link"` case; a NEW assertion covers `"facade"`
 * explicitly.
 *
 * ## The rule that does not relax
 *
 * There is no raw-HTML node type. Every string below reaches the output
 * through `escapeHtml` and a fixed tag — a CMS author cannot inject markup,
 * a script, or an iframe through any path here, independently of whatever
 * the CSP in `server/penyaji.mjs` also refuses.
 *
 * ## Link `href` is re-checked, not trusted
 *
 * awcms scheme-checks a link annotation's `href` with `URL` parsing at
 * WRITE time (`isAllowedPortableTextHref`) — a regex over the raw string is
 * how `java\nscript:` and `JaVaScRiPt:` get through, and `URL` normalises
 * both. This file repeats the same parse at RENDER time rather than
 * trusting the stored value, because a row written before that write-time
 * validator existed is still a row this endpoint will serve.
 */
import type { ResolvedMedia } from "./awcms/media";

/** awcms `PORTABLE_TEXT_BLOCK_STYLES`. */
const BLOCK_STYLES = [
  "normal",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote"
] as const;

/** awcms `PORTABLE_TEXT_LIST_ITEMS`. */
const LIST_ITEMS = ["bullet", "number"] as const;

/** awcms `PORTABLE_TEXT_ALLOWED_LINK_SCHEMES`. */
const ALLOWED_LINK_SCHEMES = ["http:", "https:", "mailto:", "tel:"];

export type PortableTextSpan = {
  _type?: string;
  text?: unknown;
  marks?: unknown;
};

export type PortableTextNode = {
  _type?: string;
  style?: unknown;
  listItem?: unknown;
  level?: unknown;
  children?: unknown;
  markDefs?: unknown;
  [key: string]: unknown;
};

/** A whole body — a bare array, per ADR-0100. The envelope (`bodyPortableText`) lives on `StaticPageDetail`. */
export type PortableTextDocument = PortableTextNode[];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `h1`–`h6` clamped into `h2`–`h4` — the page's own title (`<h1>`) owns the top of the outline; `h5`/`h6` collapse to `h4` rather than rendering a size nobody styles. */
const HEADING_TAG: Record<string, string> = {
  h1: "h2",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h4",
  h6: "h4"
};

/**
 * `href` that may reach the output, or `null`. Parsed, never
 * pattern-matched — see file header.
 */
function safeHref(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;

  const raw = value.trim();

  if (raw.startsWith("/") && !raw.startsWith("//")) {
    try {
      new URL(raw, "https://placeholder.invalid");
      return raw;
    } catch {
      return null;
    }
  }

  try {
    const url = new URL(raw);
    return ALLOWED_LINK_SCHEMES.includes(url.protocol) ? raw : null;
  } catch {
    return null;
  }
}

/** `markDefs` → `_key` → a safe href. An annotation whose href is refused is simply absent — the span still renders, unlinked. */
function annotationMap(node: PortableTextNode): Map<string, string> {
  const map = new Map<string, string>();
  const defs = Array.isArray(node.markDefs) ? node.markDefs : [];

  for (const def of defs) {
    if (!def || typeof def !== "object") continue;
    const record = def as Record<string, unknown>;
    if (record._type !== "link" || typeof record._key !== "string") continue;

    const href = safeHref(record.href);
    if (href !== null) map.set(record._key, href);
  }

  return map;
}

/**
 * One span, with its decorators and annotation wrapped around it. Decorator
 * order is FIXED (code, then em, then strong, innermost to outermost) so
 * the same span always produces the same bytes regardless of the order an
 * author happened to apply two marks in.
 */
function renderSpan(span: PortableTextSpan, annotations: Map<string, string>): string {
  const text = escapeHtml(typeof span.text === "string" ? span.text : "");
  if (text.length === 0) return "";

  const marks = Array.isArray(span.marks) ? span.marks : [];
  let out = text;

  if (marks.includes("code")) out = `<code>${out}</code>`;
  if (marks.includes("em")) out = `<em>${out}</em>`;
  if (marks.includes("strong")) out = `<strong>${out}</strong>`;

  for (const mark of marks) {
    if (typeof mark !== "string") continue;
    const href = annotations.get(mark);
    if (href === undefined) continue;
    return `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${out}</a>`;
  }

  return out;
}

function blockText(node: PortableTextNode): string {
  const annotations = annotationMap(node);
  const children = Array.isArray(node.children) ? node.children : [];

  return children
    .filter((child): child is PortableTextSpan => Boolean(child) && typeof child === "object")
    .map((child) => renderSpan(child, annotations))
    .join("");
}

function isListItem(node: PortableTextNode): boolean {
  return (
    typeof node.listItem === "string" &&
    (LIST_ITEMS as readonly string[]).includes(node.listItem)
  );
}

function listLevel(node: PortableTextNode): number {
  return typeof node.level === "number" && Number.isFinite(node.level) && node.level >= 1
    ? Math.floor(node.level)
    : 1;
}

/**
 * A run of consecutive list items at one nesting level, as `<ul>`/`<ol>`.
 * Portable Text models a list as a FLAT run of blocks carrying `listItem`/
 * `level` — there is no list container node — so rebuilding the container
 * is this renderer's job; getting it wrong produces one `<ul>` per bullet.
 */
function renderList(
  nodes: PortableTextNode[],
  start: number
): { html: string; next: number } {
  const kind = nodes[start]!.listItem === "number" ? "ol" : "ul";
  const level = listLevel(nodes[start]!);

  const items: string[] = [];
  let i = start;

  while (i < nodes.length) {
    const node = nodes[i]!;
    if (node._type !== "block" || !isListItem(node)) break;

    const thisKind = node.listItem === "number" ? "ol" : "ul";
    const thisLevel = listLevel(node);

    if (thisLevel < level || (thisLevel === level && thisKind !== kind)) break;

    if (thisLevel > level) {
      const nested = renderList(nodes, i);
      if (items.length > 0) {
        items[items.length - 1] += nested.html;
      } else {
        items.push(nested.html);
      }
      i = nested.next > i ? nested.next : i + 1;
      continue;
    }

    items.push(blockText(node));
    i += 1;
  }

  if (items.length === 0) return { html: "", next: i };

  const inner = items.map((item) => `<li>${item}</li>`).join("");
  return { html: `<${kind}>${inner}</${kind}>`, next: i };
}

function renderProseBlock(node: PortableTextNode): string {
  const inner = blockText(node);
  if (inner.length === 0) return "";

  const style = typeof node.style === "string" ? node.style : "normal";

  if (style === "blockquote") return `<blockquote><p>${inner}</p></blockquote>`;

  const tag = HEADING_TAG[style];
  if (tag) return `<${tag}>${inner}</${tag}>`;

  // "normal", and anything the closed vocabulary does not name. Renders as
  // a paragraph rather than vanishing: the author's words are what matters.
  return `<p>${inner}</p>`;
}

/** A visible, honest placeholder for a block this app cannot render — see file header. */
function renderPlaceholder(message: string): string {
  return `<p class="content-placeholder">${escapeHtml(message)}</p>`;
}

/** awcms `VIDEO_NEWS_PROVIDERS` — only `youtube` today (`video-news-block-validation.ts`). */
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** A `https://www.youtube.com/watch?v=...` URL, or `null` when `provider`/`videoId` do not validate — awcms itself normalises `videoId` to the bare 11-character form at write time, so a stored value that does not match is a row from before that validator, not a hand-crafted bad string. */
function youtubeWatchUrl(provider: unknown, videoId: unknown): string | null {
  if (provider !== "youtube") return null;
  if (typeof videoId !== "string" || !YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) return null;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** "1:23" / "12:04" / "1:02:04" — YouTube's own duration display convention. `0`, negative, and non-finite all mean "no duration to show", not "0:00". */
function formatDurationSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;

  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const secondsPart = String(seconds).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${secondsPart}`;
  }

  return `${minutes}:${secondsPart}`;
}

/** Whether `document` contains at least one `videoNews` block this renderer can actually turn into a watch link — the same validity check `renderVideoNewsNode` uses, exported so `src/lib/berita.ts` can classify a post as a "video post" (`/video/[slug]`) without duplicating the provider/videoId check. */
export function documentHasPlayableVideo(document: unknown): boolean {
  if (!Array.isArray(document)) return false;

  return document.some((node) => {
    if (!node || typeof node !== "object") return false;
    const record = node as PortableTextNode;
    return record._type === "videoNews" && youtubeWatchUrl(record.provider, record.videoId) !== null;
  });
}

/** `https://i.ytimg.com/vi/{id}/hqdefault.jpg` — YouTube's own fixed, public poster convention for any valid 11-character video id. No media-object resolution needed for this one (see file header). */
function youtubePosterUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/** `PostSummary`/`PostDetail`'s own `video` field shape (`src/lib/berita.ts`) — the first playable `videoNews` block's provider/id/poster, or `null` when `documentHasPlayableVideo` would also answer `false`. A video post's CARD thumbnail falls back to this when it has no `featuredMediaId` of its own — see `src/components/berita/ArtikelCard.astro`. */
export type PlayableVideoInfo = { provider: "youtube"; videoId: string; thumbnail: string };

/** The first playable `videoNews` block in `document`, extracted for `src/lib/berita.ts` — never a second, independent validity check: this reuses `youtubeWatchUrl`'s own gate, the exact same one `documentHasPlayableVideo`/`renderVideoNewsNode` already use. */
export function extractPlayableVideoInfo(document: unknown): PlayableVideoInfo | null {
  if (!Array.isArray(document)) return null;

  for (const node of document) {
    if (!node || typeof node !== "object") continue;
    const record = node as PortableTextNode;
    if (record._type !== "videoNews") continue;
    if (youtubeWatchUrl(record.provider, record.videoId) === null) continue;

    const videoId = record.videoId as string;
    return { provider: "youtube", videoId, thumbnail: youtubePosterUrl(videoId) };
  }

  return null;
}

/**
 * `videoNews` → the original issue-#28 outbound link when `mode === "link"`
 * (the default — safe on every page, no script required), or the issue-#47
 * click-to-load facade when `mode === "facade"` (only from a page that
 * mounts `video-facade.ts` — see `renderPortableText`'s own docblock, "The
 * video facade is opt-in, per render call"). Either way, `provider`/
 * `videoId` that do not validate still fall back to the original issue-#24
 * placeholder.
 */
function renderVideoNewsNode(node: PortableTextNode, mode: VideoRenderMode): string {
  const watchUrl = youtubeWatchUrl(node.provider, node.videoId);
  if (!watchUrl) {
    return renderPlaceholder("Video — belum dapat ditampilkan di halaman ini.");
  }

  // `youtubeWatchUrl` only returns non-null once `videoId` already matched
  // `YOUTUBE_VIDEO_ID_PATTERN`, so this re-read is always the same, safe,
  // 11-character string — never re-validated here, on purpose: one place
  // decides validity.
  const videoId = node.videoId as string;

  const title =
    typeof node.title === "string" && node.title.trim().length > 0
      ? node.title.trim()
      : "Video berita";
  const sourceLabel = typeof node.sourceLabel === "string" ? node.sourceLabel.trim() : "";
  const duration = formatDurationSeconds(node.durationSeconds);
  const caption = typeof node.caption === "string" ? node.caption.trim() : "";

  const metaParts = [sourceLabel, duration].filter(
    (part): part is string => typeof part === "string" && part.length > 0
  );
  const metaHtml =
    metaParts.length > 0
      ? `<figcaption>${metaParts.map(escapeHtml).join(" &middot; ")}</figcaption>`
      : "";
  const captionHtml =
    caption.length > 0 ? `<p class="content-video-caption">${escapeHtml(caption)}</p>` : "";

  if (mode === "facade") {
    return (
      `<figure class="content-video" data-video-facade data-video-id="${escapeHtml(videoId)}" data-video-title="${escapeHtml(title)}">` +
      `<button type="button" class="content-video-link" data-video-facade-button aria-label="Putar video: ${escapeHtml(title)}">` +
      `<img class="content-video-poster" src="${escapeHtml(youtubePosterUrl(videoId))}" alt="" loading="lazy" decoding="async" width="120" height="90">` +
      `<span class="content-video-play" aria-hidden="true">&#9654;</span>` +
      `<span class="content-video-title">${escapeHtml(title)}</span>` +
      `</button>` +
      metaHtml +
      captionHtml +
      `<noscript><a href="${escapeHtml(watchUrl)}" rel="noopener noreferrer">Tonton di YouTube</a></noscript>` +
      `</figure>`
    );
  }

  // `mode === "link"` — the original issue-#28 rendering: a real, semantic
  // outbound link, no `<img>`/`<iframe>`/script dependency of any kind. This
  // is the SAFE-EVERYWHERE shape (see file header, "The video facade is
  // opt-in, per render call") — every caller that has not mounted
  // `video-facade.ts` uses this by not passing `{ videoMode: "facade" }`.
  return (
    `<figure class="content-video">` +
    `<a class="content-video-link" href="${escapeHtml(watchUrl)}" rel="noopener noreferrer" target="_blank">` +
    `<span class="content-video-play" aria-hidden="true">&#9654;</span>` +
    `<span class="content-video-title">${escapeHtml(title)}</span>` +
    `</a>` +
    metaHtml +
    captionHtml +
    `</figure>`
  );
}

type GalleryItemLike = { caption?: unknown; mediaType?: unknown; mediaObjectId?: unknown };

/** Every `gallery` item's `mediaObjectId` in `document` whose `mediaType` is `"image"` — exported so `src/lib/berita.ts` can collect every id a post's body references, up front, for one batched `resolveMedia` call per build (see `src/lib/awcms/media.ts`). Ignores the legacy `url`-only item shape (nothing to resolve, see file header) and `mediaType: "video"` items (out of this issue's scope). */
export function collectGalleryMediaObjectIds(document: unknown): string[] {
  if (!Array.isArray(document)) return [];

  const ids: string[] = [];
  for (const node of document) {
    if (!node || typeof node !== "object") continue;
    const record = node as PortableTextNode;
    if (record._type !== "gallery") continue;

    const items = Array.isArray(record.items) ? (record.items as GalleryItemLike[]) : [];
    for (const item of items) {
      if (item.mediaType === "image" && typeof item.mediaObjectId === "string") {
        ids.push(item.mediaObjectId);
      }
    }
  }
  return ids;
}

/** `creditLine`/`sourceName` joined for display — `creditLine` first (the more specific, "who to credit" field), `sourceName` appended only when both exist. `null` when the resolved object carries neither (unverified rights — see `src/lib/awcms/media.ts`). */
function formatMediaCredit(media: Pick<ResolvedMedia, "creditLine" | "sourceName">): string | null {
  const parts = [media.creditLine, media.sourceName].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0
  );
  return parts.length > 0 ? parts.join(" — ") : null;
}

/** One gallery item — a real `<figure><img>` when it is `mediaType: "image"` and its `mediaObjectId` resolves in `resolvedMedia`, else the original issue-#24 placeholder figure (never a broken `<img>`). */
function renderGalleryItem(
  item: GalleryItemLike,
  resolvedMedia: ReadonlyMap<string, ResolvedMedia>
): string {
  const caption = typeof item.caption === "string" ? item.caption.trim() : "";
  const media =
    item.mediaType === "image" && typeof item.mediaObjectId === "string"
      ? resolvedMedia.get(item.mediaObjectId)
      : undefined;

  if (media) {
    const credit = formatMediaCredit(media);
    // Escaped BEFORE joining — the separator itself is a fixed, already-safe
    // HTML entity, never re-escaped, but `caption`/`credit` are CMS-authored
    // strings and must not reach the output un-escaped (the same rule every
    // other string in this file follows — see file header, "The rule that
    // does not relax").
    const figcaptionText = [caption, credit]
      .filter((part): part is string => Boolean(part && part.length > 0))
      .map(escapeHtml)
      .join(" &middot; ");
    const alt = media.alt ?? caption;

    return (
      `<figure class="content-figure">` +
      `<img src="${escapeHtml(media.publicUrl)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async"` +
      (media.width && media.height ? ` width="${media.width}" height="${media.height}"` : "") +
      `>` +
      (figcaptionText.length > 0 ? `<figcaption>${figcaptionText}</figcaption>` : "") +
      `</figure>`
    );
  }

  return (
    `<figure class="content-figure">` +
    `<span class="content-figure-placeholder" aria-hidden="true"></span>` +
    (caption.length > 0 ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "") +
    `</figure>`
  );
}

/**
 * `gallery` → one `<figure>` per item (real `<img>` where `resolvedMedia`
 * resolves it, a placeholder figure otherwise), WHEN at least one item
 * either resolves to a real image or carries a `caption` — the same
 * "not enough to render at all" gate issue #24/#28 established, extended
 * rather than replaced: a gallery block with neither still renders the
 * exact original single, stated placeholder line instead of a row of empty
 * boxes.
 */
function renderGalleryNode(
  node: PortableTextNode,
  resolvedMedia: ReadonlyMap<string, ResolvedMedia>
): string {
  const items = Array.isArray(node.items) ? (node.items as GalleryItemLike[]) : [];

  const hasAnythingToRender = items.some((item) => {
    const hasCaption = typeof item.caption === "string" && item.caption.trim().length > 0;
    const hasImage =
      item.mediaType === "image" &&
      typeof item.mediaObjectId === "string" &&
      resolvedMedia.has(item.mediaObjectId);
    return hasCaption || hasImage;
  });

  if (!hasAnythingToRender) {
    return renderPlaceholder(
      `Galeri (${items.length} gambar) — belum dapat ditampilkan di halaman ini.`
    );
  }

  const figures = items.map((item) => renderGalleryItem(item, resolvedMedia)).join("");
  return `<div class="content-gallery">${figures}</div>`;
}

/**
 * `videoNews`'s two render shapes — see `renderVideoNewsNode`'s own
 * docblock. `"link"` is the default deliberately: it is the shape that
 * works on every page, with no script dependency, so a caller has to OPT IN
 * to the facade rather than opt out of it.
 */
export type VideoRenderMode = "facade" | "link";

/**
 * Render a Portable Text document to HTML. Still pure — no I/O —
 * `resolvedMedia` is a plain, already-fetched lookup the caller built ahead
 * of time (`src/lib/berita.ts`, via `src/lib/awcms/media.ts`), never
 * fetched here. That is what still lets the whole vocabulary be
 * unit-tested with fixed input (`tests/portable-text.test.ts`) — an empty
 * map (the default) is indistinguishable from "nothing resolved" and falls
 * back to every original placeholder, unchanged.
 *
 * ## The video facade is opt-in, per render call
 *
 * `options.videoMode` defaults to `"link"` — the original issue-#28
 * outbound-link rendering, which needs no script anywhere. `"facade"`
 * (issue #47's click-to-load poster/button) is safe ONLY on a page that
 * also mounts `apps/storefront/src/scripts/video-facade.ts`, because
 * without it the button is inert: a reader clicks and nothing happens.
 * Today that is `src/profil/berita/pages/video/[slug].astro` alone — the only route a
 * playable `videoNews` block can ever appear on (`src/lib/berita.ts`'s own
 * routing rule) — which is the ONE call site
 * (`src/components/berita/ArtikelView.astro`) that passes `"facade"`
 * through its own `videoMode` prop. Every other caller (`src/pages/halaman/
 * [slug].astro`'s static pages, `src/pages/{berita,rubrik/[slug]}/feed.xml
 * .ts`'s RSS `content:encoded`) calls this function without the option and
 * gets the always-safe link — RSS in particular can never run a click
 * handler at all, so `"facade"` there would ship a permanently-dead button
 * into every reader's feed.
 */
export function renderPortableText(
  document: unknown,
  resolvedMedia: ReadonlyMap<string, ResolvedMedia> = new Map(),
  options: { videoMode?: VideoRenderMode } = {}
): string {
  const videoMode = options.videoMode ?? "link";
  if (!Array.isArray(document)) return "";

  const nodes = document.filter(
    (node): node is PortableTextNode =>
      Boolean(node) && typeof node === "object" && !Array.isArray(node)
  );

  const out: string[] = [];
  let i = 0;

  while (i < nodes.length) {
    const node = nodes[i]!;

    if (node._type === "block" && isListItem(node)) {
      const list = renderList(nodes, i);
      out.push(list.html);
      i = list.next > i ? list.next : i + 1;
      continue;
    }

    i += 1;

    if (node._type === "block") {
      out.push(renderProseBlock(node));
      continue;
    }

    if (node._type === "gallery") {
      out.push(renderGalleryNode(node, resolvedMedia));
      continue;
    }

    if (node._type === "videoNews") {
      out.push(renderVideoNewsNode(node, videoMode));
      continue;
    }

    // Defence against an awcms newer than this renderer (a `_type` the
    // closed vocabulary does not yet name). Visible rather than silently
    // dropped.
    out.push(
      renderPlaceholder(
        `Blok "${typeof node._type === "string" ? node._type : "tanpa tipe"}" belum dapat ditampilkan.`
      )
    );
  }

  return out.filter(Boolean).join("\n");
}

/** `BLOCK_STYLES` re-exported for tests that want to assert the vocabulary this file was built against, without re-typing it. */
export const PORTABLE_TEXT_BLOCK_STYLES: readonly string[] = BLOCK_STYLES;
