/**
 * Renders awcms's canonical CMS-page body — Portable Text — to HTML at
 * build time (issue #24). PATTERN adapted from the sibling
 * `media-lenterakalteng`/`apps/situs`'s `src/lib/portable-text.ts`, not
 * ported verbatim: that renderer also handles `gallery`/`videoNews` object
 * blocks by resolving them against a media-object map this app does not
 * have (see `src/lib/awcms/profil.ts`'s "Media ids, not URLs" note) — here
 * both degrade to a stated placeholder instead of an `<img>`/embed.
 *
 * Vocabulary verified against `apps/cms/src/modules/blog-content/domain/
 * portable-text.ts` — the CLOSED vocabulary ADR-0100 defines: block styles
 * `normal`/`h1`-`h6`/`blockquote`, list items `bullet`/`number`, decorators
 * `strong`/`em`/`code` (no `underline` — an underlined span that is not a
 * link is a usability defect), one annotation type `link`, and two object
 * blocks `gallery`/`videoNews`.
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
      const items = Array.isArray(node.items) ? node.items.length : 0;
      out.push(
        renderPlaceholder(
          `Galeri (${items} gambar) — belum dapat ditampilkan di halaman ini.`
        )
      );
      continue;
    }

    if (node._type === "videoNews") {
      out.push(renderPlaceholder("Video — belum dapat ditampilkan di halaman ini."));
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
