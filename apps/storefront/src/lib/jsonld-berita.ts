/**
 * `NewsArticle` + `BreadcrumbList` JSON-LD for the news surface (issue #28)
 * — PATTERN modeled on `src/pages/product/[slug].astro`'s inline `Product`
 * schema (issue #5): a plain object handed to `BaseLayout`'s `schema` prop,
 * which `jsonForScript()` (`BaseLayout.astro`) serializes and HTML-escapes.
 * This file never touches a `<script>` tag or does its own escaping —
 * safety is pushed to that one render boundary, same as the product page.
 *
 * `BaseLayout`'s `schema` prop accepts exactly one object, so a page that
 * needs BOTH `NewsArticle` and `BreadcrumbList` (`/berita/[slug]`) combines
 * them with JSON-LD's own `@graph` array (`combineSchemas` below) rather
 * than this app growing a second `<script type="application/ld+json">` —
 * `BaseLayout.astro` itself is out of this issue's file ownership.
 */
import { absoluteUrl } from "../config/site";

export type NewsArticleSchemaInput = {
  headline: string;
  description: string | null;
  canonicalPath: string;
  /** ISO 8601 — the raw `publishedAt`/`updatedAt` from `src/lib/awcms/blog.ts`, not the WIB display string (`src/lib/tanggal.ts`); JSON-LD wants a machine-readable timestamp. */
  publishedAt: string;
  updatedAt: string;
  /**
   * `null` when the author has not opted in to a public byline (ADR-0109) —
   * `author` then attributes to the PUBLISHER as an `Organization`, never a
   * fabricated `Person`. Only a real, opted-in byline becomes a `Person`,
   * and even then carries `name` only (no `@id`/`url`/`sameAs` — a byline
   * is credit for one piece of writing, not a followable identity),
   * matching the sibling template's own documented choice for this field.
   */
  authorByline: string | null;
  publisherName: string;
  rubricName: string | null;
};

/** Google's own guidance clamps `headline` around 110 characters; longer values are truncated, not rejected, matching the sibling template's own choice for the same field. */
const HEADLINE_MAX_LENGTH = 110;

export function newsArticleSchema(input: NewsArticleSchemaInput): Record<string, unknown> {
  const author =
    input.authorByline && input.authorByline.trim().length > 0
      ? { "@type": "Person", name: input.authorByline.trim() }
      : { "@type": "Organization", name: input.publisherName };

  return {
    "@type": "NewsArticle",
    headline: input.headline.slice(0, HEADLINE_MAX_LENGTH),
    ...(input.description ? { description: input.description } : {}),
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": absoluteUrl(input.canonicalPath)
    },
    datePublished: input.publishedAt,
    dateModified: input.updatedAt,
    author,
    publisher: { "@type": "Organization", name: input.publisherName },
    ...(input.rubricName ? { articleSection: input.rubricName } : {})
  };
}

export type BreadcrumbItem = { name: string; path: string };

/** `path` is site-relative (e.g. `/berita`, `/rubrik/politik`) — resolved to an absolute URL here, the same convention `BaseLayout`'s own `canonicalPath` prop already uses. */
export function breadcrumbListSchema(items: readonly BreadcrumbItem[]): Record<string, unknown> {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path)
    }))
  };
}

/** Combines two or more `@type` objects into one JSON-LD document via `@graph` — the standard way to publish multiple structured-data entities from one `<script>` block. */
export function combineSchemas(
  ...schemas: readonly Record<string, unknown>[]
): Record<string, unknown> {
  return { "@graph": schemas };
}
