/**
 * tools/lib/html-to-portable-text.ts — issue #58.
 *
 * A conservative, hand-rolled converter from seputarborneo's `isi_berita`
 * (CKEditor HTML, mixed CRLF, `&nbsp;`) to the CLOSED Portable Text
 * vocabulary `apps/cms`'s `blog_content` module accepts on
 * `POST /api/v1/blog/posts` (ADR-0100 — see
 * `apps/cms/src/modules/blog-content/domain/portable-text.ts`, read at
 * <https://github.com/ahliweb/awcms> for the shape this file targets).
 *
 * ## Why this is a new, small converter rather than a dependency or a
 * cross-workspace import
 *
 * `apps/cms` already has `convertLegacyHtmlToPortableText` for its own
 * `blog:legacy:import` NDJSON pipeline. This repo's workspace boundary
 * (`AGENTS.md` "Workspace boundaries") is explicit: nothing outside
 * `apps/cms/` may depend on its internals, only its public HTTP API — and
 * this importer talks to that public API, not the database directly. That
 * boundary applies even to a TYPE-only import: `apps/cms` is upstream code
 * vendored whole via `git subtree` ("The subtree embed"), so a compile-time
 * dependency on one of its internal file paths is still a path a future
 * `git subtree pull` can move or rename out from under this file. The
 * Portable Text node/span/annotation shapes below are therefore DUPLICATED
 * (structurally, not imported) from `apps/cms/src/modules/blog-content/
 * domain/portable-text.ts`, the same deliberate choice seputarborneo's own
 * `include/nav_menu.php` documents for its `seputarborneo_rubrik_slug()` /
 * `include/view_helpers.php`'s `sb_slug()` pair: two copies that must be kept
 * in step by a comment, not one import that would point the wrong way. A
 * general-purpose HTML parser (a real DOM) is also not a dependency this
 * root workspace carries today, and pulling one in for a single, bounded tag
 * vocabulary is more than the job needs. So this is a small, purpose-built
 * tokenizer over the specific tag set issue #58 names, tested against
 * hand-authored fixtures.
 *
 * ## Reject-nothing, drop-and-report instead
 *
 * Unlike the internal CLI (which REFUSES a whole article over one unmanaged
 * `<img>`), this converter never fails an article: `<script>`/`<style>`/
 * `<iframe>`/`<embed>`/`<object>` are dropped outright (content and all —
 * never rendered as visible text, which would just move an XSS payload from
 * markup into "prose"); an `<img>` with no resolver, or whose `src` the
 * resolver does not map, is dropped and its `src` is returned in
 * `droppedImages` for the caller's manifest; a disallowed/malformed `<a
 * href>` degrades to plain text instead of a link. An unrecognised tag is
 * transparent — its own markup disappears, its inner text still flows into
 * the surrounding paragraph — which is what issue #58 calls "unknown ->
 * paragraph text".
 */
/**
 * Structural duplicates of `apps/cms`'s closed Portable Text vocabulary
 * (ADR-0100) — see this file's header for why these are copied rather than
 * imported. Kept deliberately narrow: only the members this converter ever
 * produces (no `videoNews`, no `code`/list beyond bullet+number, no `h1`/
 * `h5`/`h6`) — a member added here without also adding it upstream would be
 * silently accepted by nothing, since `apps/cms`'s own validator is what
 * actually enforces the vocabulary at write time.
 */
export type PortableTextBlockStyle =
  "normal" | "h2" | "h3" | "h4" | "blockquote";
export type PortableTextListItem = "bullet" | "number";
export type PortableTextSpan = {
  _type: "span";
  _key: string;
  text: string;
  marks: string[];
};
export type PortableTextLinkAnnotation = {
  _type: "link";
  _key: string;
  href: string;
};
export type PortableTextAnnotation = PortableTextLinkAnnotation;
export type PortableTextBlock = {
  _type: "block";
  _key: string;
  style: PortableTextBlockStyle;
  listItem?: PortableTextListItem;
  level?: number;
  children: PortableTextSpan[];
  markDefs: PortableTextAnnotation[];
};
export type PortableTextGalleryBlock = {
  _type: "gallery";
  _key: string;
  items: Array<{
    mediaType: "image";
    mediaObjectId: string;
    caption?: string;
  }>;
};
export type PortableTextNode = PortableTextBlock | PortableTextGalleryBlock;

export type ImageResolver = (src: string) => string | null | undefined;

export type ConvertHtmlOptions = {
  /**
   * Resolves a legacy image `src` to a verified media object id. Omit it
   * entirely for a run with no `--media-map` yet — every image is then
   * dropped and reported, which is the intended state for a first pass
   * (see `tools/import-seputarborneo.ts`'s `--images` handoff).
   */
  resolveImage?: ImageResolver;
};

export type ConversionResult = {
  document: PortableTextNode[];
  /** Deduplicated `src` values this body needed uploaded but could not resolve. */
  droppedImages: string[];
};

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const ALLOWED_LINK_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Mirrors `isAllowedPortableTextHref` in `apps/cms` (duplicated, not imported — see this file's header). */
function isAllowedHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
  const schemeMatch = SCHEME_PATTERN.exec(trimmed);
  if (!schemeMatch) return false;
  return ALLOWED_LINK_SCHEMES.has(`${schemeMatch[1]!.toLowerCase()}:`);
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“"
};

/** Decodes the small set of entities CKEditor exports actually use. Unknown entities pass through unchanged rather than being guessed at. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const codePoint = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** Collapses runs of ASCII whitespace/newlines to a single space — CKEditor/legacy HTML indentation carries no meaning. `\n` inserted by `<br>` handling is NOT run through this (see `HtmlToPortableTextConverter.text`). */
function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\r\n\f]+/g, " ");
}

type TagToken = {
  kind: "tag";
  closing: boolean;
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
};
type TextToken = { kind: "text"; text: string };
type Token = TagToken | TextToken;

const TOKEN_RE = /<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\/?>|[^<]+/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(raw))) {
    const name = match[1]!.toLowerCase();
    attrs[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(html))) {
    const raw = match[0];
    if (raw.startsWith("<!--")) continue; // comments carry nothing this vocabulary keeps.
    if (raw[0] !== "<") {
      tokens.push({ kind: "text", text: raw });
      continue;
    }
    const closing = raw[1] === "/";
    const nameMatch = /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(raw)!;
    const name = nameMatch[1]!.toLowerCase();
    const selfClosing = /\/>$/.test(raw);
    const attrsRaw = raw.slice(nameMatch[0].length, raw.length - (selfClosing ? 2 : 1));
    tokens.push({
      kind: "tag",
      closing,
      name,
      attrs: closing ? {} : parseAttrs(attrsRaw),
      selfClosing
    });
  }
  return tokens;
}

/** Tags whose ENTIRE content (including nested markup) is dropped, never rendered as text. */
const DROP_ENTIRELY = new Set(["script", "style", "iframe", "embed", "object"]);

/** `<h2>`-`<h4>` per issue #58's listed tag set — `h1`/`h5`/`h6` are not legacy CKEditor output for a body and are treated as unrecognised (transparent) rather than guessed at. */
const HEADING_STYLE: Record<string, PortableTextBlockStyle> = {
  h2: "h2",
  h3: "h3",
  h4: "h4"
};

const DECORATOR_TAG: Record<string, "strong" | "em"> = {
  strong: "strong",
  b: "strong",
  em: "em",
  i: "em"
};

type OpenBlock = {
  style: PortableTextBlockStyle;
  listItem?: PortableTextListItem;
  level?: number;
  spans: PortableTextSpan[];
  markDefs: PortableTextAnnotation[];
};

type ListFrame = { kind: PortableTextListItem; level: number };

/**
 * One converter instance per article body — it is not reusable across calls,
 * since `_key` generation and list nesting are both stateful per document.
 */
class HtmlToPortableTextConverter {
  private readonly document: PortableTextNode[] = [];
  private readonly droppedImages = new Set<string>();
  private readonly resolveImage?: ImageResolver;

  private current: OpenBlock | null = null;
  private readonly markStack: Array<
    { kind: "strong" | "em" } | { kind: "link"; key: string }
  > = [];
  private readonly listStack: ListFrame[] = [];
  private blockCounter = 0;
  private spanCounter = 0;
  private markCounter = 0;

  constructor(options: ConvertHtmlOptions) {
    this.resolveImage = options.resolveImage;
  }

  private ensureBlock(style: PortableTextBlockStyle = "normal"): OpenBlock {
    if (!this.current) {
      this.current = { style, spans: [], markDefs: [] };
    }
    return this.current;
  }

  private activeMarks(): string[] {
    const marks: string[] = [];
    for (const mark of this.markStack) {
      if (mark.kind === "link") marks.push(mark.key);
      else marks.push(mark.kind);
    }
    return marks;
  }

  private flush(): void {
    const block = this.current;
    this.current = null;
    if (!block) return;

    // Trim the block's OWN leading/trailing whitespace without disturbing
    // meaningful inter-tag spacing that already survived inside each span.
    if (block.spans.length > 0) {
      const first = block.spans[0]!;
      first.text = first.text.replace(/^\s+/, "");
      const last = block.spans[block.spans.length - 1]!;
      last.text = last.text.replace(/\s+$/, "");
    }

    const nonEmpty = block.spans.filter((span) => span.text.length > 0);
    if (nonEmpty.length === 0) return; // an empty paragraph carries nothing worth storing.

    this.document.push({
      _type: "block",
      _key: `b${this.blockCounter++}`,
      style: block.style,
      ...(block.listItem ? { listItem: block.listItem, level: block.level } : {}),
      children: nonEmpty,
      markDefs: block.markDefs
    });
  }

  private appendText(raw: string): void {
    if (raw.length === 0) return;
    const marks = this.activeMarks();
    const block = this.ensureBlock();
    const last = block.spans[block.spans.length - 1];
    if (last && JSON.stringify(last.marks) === JSON.stringify(marks)) {
      last.text += raw;
      return;
    }
    block.spans.push({
      _type: "span",
      _key: `b${this.blockCounter}-s${this.spanCounter++}`,
      text: raw,
      marks
    });
  }

  private startBlock(style: PortableTextBlockStyle): void {
    this.flush();
    this.current = { style, spans: [], markDefs: [] };
  }

  private startListItem(): void {
    this.flush();
    const top = this.listStack[this.listStack.length - 1];
    this.current = {
      style: "normal",
      listItem: top?.kind ?? "bullet",
      level: top?.level ?? 1,
      spans: [],
      markDefs: []
    };
  }

  private emitGallery(src: string, alt: string): void {
    const mediaObjectId = this.resolveImage?.(src);
    if (!mediaObjectId) {
      this.droppedImages.add(src);
      return;
    }
    this.flush();
    this.document.push({
      _type: "gallery",
      _key: `b${this.blockCounter++}`,
      items: [
        {
          mediaType: "image",
          mediaObjectId,
          ...(alt ? { caption: alt } : {})
        }
      ]
    });
  }

  convert(html: string): ConversionResult {
    const withoutDangerousBlocks = html.replace(
      /<(script|style|iframe|embed|object)\b[\s\S]*?(?:<\/\1\s*>|$)/gi,
      ""
    );

    for (const token of tokenize(withoutDangerousBlocks)) {
      if (token.kind === "text") {
        this.appendText(collapseWhitespace(decodeHtmlEntities(token.text)));
        continue;
      }

      const { name, closing, attrs, selfClosing } = token;

      if (DROP_ENTIRELY.has(name)) continue; // an unmatched opening/closing tag of a dangerous element — the content between was already stripped above.

      if (name === "br") {
        this.appendText("\n");
        continue;
      }

      if (name === "img") {
        if (!closing) {
          this.emitGallery(attrs.src ?? "", attrs.alt ?? "");
        }
        continue;
      }

      if (name === "p") {
        if (!closing) this.startBlock("normal");
        else this.flush();
        continue;
      }

      const heading = HEADING_STYLE[name];
      if (heading) {
        if (!closing) this.startBlock(heading);
        else this.flush();
        continue;
      }

      if (name === "blockquote") {
        if (!closing) this.startBlock("blockquote");
        else this.flush();
        continue;
      }

      if (name === "ul" || name === "ol") {
        if (!closing) {
          this.listStack.push({
            kind: name === "ul" ? "bullet" : "number",
            level: this.listStack.length + 1
          });
        } else {
          this.listStack.pop();
        }
        continue;
      }

      if (name === "li") {
        if (!closing) this.startListItem();
        else this.flush();
        continue;
      }

      const decorator = DECORATOR_TAG[name];
      if (decorator) {
        if (!closing && !selfClosing) this.markStack.push({ kind: decorator });
        else if (closing) {
          const idx = [...this.markStack].reverse().findIndex((m) => m.kind === decorator);
          if (idx !== -1) this.markStack.splice(this.markStack.length - 1 - idx, 1);
        }
        continue;
      }

      if (name === "a") {
        if (!closing && !selfClosing) {
          const href = attrs.href ?? "";
          if (isAllowedHref(href)) {
            const key = `b${this.blockCounter}-a${this.markCounter++}`;
            const block = this.ensureBlock();
            const annotation: PortableTextLinkAnnotation = {
              _type: "link",
              _key: key,
              href
            };
            block.markDefs.push(annotation);
            this.markStack.push({ kind: "link", key });
          } else {
            // Disallowed/missing href — degrade to plain text (push a no-op
            // frame so the matching `</a>` still pops correctly).
            this.markStack.push({ kind: "link", key: "" });
          }
        } else if (closing) {
          const idx = [...this.markStack].reverse().findIndex((m) => m.kind === "link");
          if (idx !== -1) this.markStack.splice(this.markStack.length - 1 - idx, 1);
        }
        continue;
      }

      // Unrecognised tag: transparent. Its own markup disappears; content
      // (including any nested tags this tokenizer DOES understand) still
      // flows through normally.
    }

    this.flush();

    return {
      document: this.document,
      droppedImages: [...this.droppedImages]
    };
  }
}

/** Converts one article/video body. Pure — no I/O, no database; `resolveImage` is a plain function the caller may back with a pre-verified map. */
export function convertHtmlToPortableText(
  html: string,
  options: ConvertHtmlOptions = {}
): ConversionResult {
  return new HtmlToPortableTextConverter(options).convert(html ?? "");
}
