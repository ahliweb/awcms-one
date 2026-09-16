import { describe, expect, test } from "bun:test";
import { newsArticleSchema, breadcrumbListSchema, combineSchemas } from "../src/lib/jsonld-berita";

describe("lib/jsonld-berita: newsArticleSchema", () => {
  test("a bylined post attributes author as a Person, name only", () => {
    const schema = newsArticleSchema({
      headline: "Judul",
      description: "Deskripsi",
      canonicalPath: "/berita/judul",
      publishedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      authorByline: "Ahmad Junaidi",
      publisherName: "BjekMart",
      rubricName: "Politik"
    });

    expect(schema["@type"]).toBe("NewsArticle");
    expect(schema.author).toEqual({ "@type": "Person", name: "Ahmad Junaidi" });
    expect(schema.publisher).toEqual({ "@type": "Organization", name: "BjekMart" });
    expect(schema.articleSection).toBe("Politik");
  });

  test("a post with NO byline attributes author to the publisher, as an Organization — never a fabricated Person", () => {
    const schema = newsArticleSchema({
      headline: "Judul",
      description: null,
      canonicalPath: "/berita/judul",
      publishedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      authorByline: null,
      publisherName: "BjekMart",
      rubricName: null
    });

    expect(schema.author).toEqual({ "@type": "Organization", name: "BjekMart" });
    expect(schema).not.toHaveProperty("description");
    expect(schema).not.toHaveProperty("articleSection");
  });

  test("headline is clamped to 110 characters", () => {
    const longHeadline = "x".repeat(200);
    const schema = newsArticleSchema({
      headline: longHeadline,
      description: null,
      canonicalPath: "/berita/x",
      publishedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      authorByline: null,
      publisherName: "BjekMart",
      rubricName: null
    });
    expect((schema.headline as string).length).toBe(110);
  });

  test("an all-whitespace byline is treated as no byline", () => {
    const schema = newsArticleSchema({
      headline: "Judul",
      description: null,
      canonicalPath: "/berita/judul",
      publishedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      authorByline: "   ",
      publisherName: "BjekMart",
      rubricName: null
    });
    expect(schema.author).toEqual({ "@type": "Organization", name: "BjekMart" });
  });
});

describe("lib/jsonld-berita: breadcrumbListSchema", () => {
  test("numbers positions from 1 and resolves each path to an absolute URL", () => {
    const schema = breadcrumbListSchema([
      { name: "Beranda", path: "/" },
      { name: "Berita", path: "/berita" }
    ]);

    expect(schema["@type"]).toBe("BreadcrumbList");
    const items = schema.itemListElement as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ "@type": "ListItem", position: 1, name: "Beranda" });
    expect(items[1]).toMatchObject({ position: 2, name: "Berita" });
    expect(typeof items[0]!.item).toBe("string");
    expect(items[0]!.item as string).toMatch(/^https?:\/\//);
  });
});

describe("lib/jsonld-berita: combineSchemas", () => {
  test("wraps every given schema in one @graph array", () => {
    const combined = combineSchemas({ "@type": "A" }, { "@type": "B" });
    expect(combined).toEqual({ "@graph": [{ "@type": "A" }, { "@type": "B" }] });
  });
});
