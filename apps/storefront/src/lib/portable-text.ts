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
 * ## `videoNews` and captioned `gallery` items render real content now
 * (issue #28) — everything else is UNCHANGED from issue #24
 *
 * `videoNews` (`provider`/`videoId`/`title`/`caption`/`durationSeconds`/
 * `sourceLabel`, verified against `video-news-block-validation.ts`) renders
 * a semantic video card with a real outbound link — NEVER an `<iframe>`
 * embed, even though the issue's own text asks for a "lite-youtube-style
 * facade": an actual embed needs `img-src`/`frame-src` widened past `'self'`
 * (`server/penyaji.mjs`), and this issue's file ownership grants it only
 * the legacy-redirect hook there, not a CSP change. This is the SAME
 * conclusion the sibling `media-lenterakalteng` app reached independently,
 * for its own reasons (ADR-0046 there refuses embeds outright) — recorded
 * here as a deliberate, documented deviation from the issue's literal ask,
 * the same way issue #24 recorded its own two.
 *
 * A `gallery` item's `caption` field is the ONLY field awcms's
 * `GalleryBlockItem` schema carries besides the image reference itself
 * (verified against `gallery-block-renderer.ts`) — there is no separate
 * "credit" field to distinguish from it. This renderer treats a photo
 * credit, when an editor writes one, as part of that single `caption`
 * string (e.g. "Foto: Antara/Budi"), exactly as awcms itself stores it,
 * rather than inventing a second field the schema does not have.
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
 * Neither change touches this file's PUBLIC signature: `renderPortableText`
 * still takes exactly one argument, so `src/pages/halaman/[slug].astro`
 * (issue #24) is untouched, and every one of issue #24's own assertions in
 * `tests/portable-text.test.ts` — including the two that name `gallery`/
 * `videoNews` — still passes unmodified: both tests' fixtures carry no
 * `caption`/`provider`/`videoId` fields, which is exactly the "not enough
 * to render" case that still falls back to the ORIGINAL placeholder text
 * below.
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

/**
 * `videoNews` → a real, semantic video card when `provider`/`videoId`
 * validate, else the original issue-#24 placeholder — see file header for
 * why this is a link, never an embed.
 */
function renderVideoNewsNode(node: PortableTextNode): string {
  const watchUrl = youtubeWatchUrl(node.provider, node.videoId);
  if (!watchUrl) {
    return renderPlaceholder("Video — belum dapat ditampilkan di halaman ini.");
  }

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

  return (
    `<figure class="content-video">` +
    `<a class="content-video-link" href="${escapeHtml(watchUrl)}" rel="noopener noreferrer" target="_blank">` +
    `<span class="content-video-play" aria-hidden="true">&#9654;</span>` +
    `<span class="content-video-title">${escapeHtml(title)}</span>` +
    `</a>` +
    (metaParts.length > 0
      ? `<figcaption>${metaParts.map(escapeHtml).join(" &middot; ")}</figcaption>`
      : "") +
    (caption.length > 0 ? `<p class="content-video-caption">${escapeHtml(caption)}</p>` : "") +
    `</figure>`
  );
}

type GalleryItemLike = { caption?: unknown };

/**
 * `gallery` → a real `<figure>` per item, with its `caption` (awcms's only
 * such field — see file header) rendered as a `<figcaption>`, WHEN at least
 * one item in the block actually carries one. When none do, this renders
 * the exact original issue-#24 placeholder text — never an `<img>` either
 * way (no media-object client — see file header).
 */
function renderGalleryNode(node: PortableTextNode): string {
  const items = Array.isArray(node.items) ? (node.items as GalleryItemLike[]) : [];

  const hasAnyCaption = items.some(
    (item) => typeof item.caption === "string" && item.caption.trim().length > 0
  );

  if (!hasAnyCaption) {
    return renderPlaceholder(
      `Galeri (${items.length} gambar) — belum dapat ditampilkan di halaman ini.`
    );
  }

  const figures = items
    .map((item) => {
      const caption = typeof item.caption === "string" ? item.caption.trim() : "";
      return (
        `<figure class="content-figure">` +
        `<span class="content-figure-placeholder" aria-hidden="true"></span>` +
        (caption.length > 0 ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "") +
        `</figure>`
      );
    })
    .join("");

  return `<div class="content-gallery">${figures}</div>`;
}

/**
 * Render a Portable Text document to HTML. Pure — no I/O, no media
 * resolution — which is what lets the whole vocabulary be unit-tested with
 * fixed input (`tests/portable-text.test.ts`).
 */
export function renderPortableText(document: unknown): string {
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
      out.push(renderGalleryNode(node));
      continue;
    }

    if (node._type === "videoNews") {
      out.push(renderVideoNewsNode(node));
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
