import { describe, expect, test } from "bun:test";
import { renderBeritaRssXml, type BeritaFeedItem } from "../src/lib/berita";

/**
 * Feed XML validity, "parse it back" (issue #28's own Tests bullet) — a
 * small, purpose-built extraction rather than a new XML-parser dependency
 * (none exists anywhere in this workspace): `src/lib/sitemap.ts`'s own test
 * suite (`tests/sitemap.test.ts`) already establishes the precedent of
 * asserting generated XML via substring/structural checks rather than a
 * full DOM parse, for the same reason — this repo has no XML-parsing
 * library to reach for, and adding one for a test file would be more
 * machinery than the assertion needs.
 */

const ITEM: BeritaFeedItem = {
  title: "Bupati Kobar Resmikan Jembatan Baru",
  link: "https://example.test/berita/bupati-kobar-resmikan-jembatan-baru",
  guid: "https://example.test/berita/bupati-kobar-resmikan-jembatan-baru",
  description: "Bupati meresmikan jembatan baru.",
  contentHtml: "<p>Jembatan baru diresmikan.</p>",
  publishedAt: "2026-08-01T02:00:00.000Z"
};

const CHANNEL = { title: "BjekMart — Berita", link: "https://example.test/berita", description: "Berita terbaru." };

/** Extracts every `<item>...</item>` block's title/link/pubDate/content:encoded — enough structure to prove the renderer's own escaping and CDATA round-trip, without a full XML parser. */
function extractItems(xml: string): Array<{ title: string; link: string; pubDate: string; contentEncoded: string }> {
  const items: Array<{ title: string; link: string; pubDate: string; contentEncoded: string }> = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;

  for (const match of xml.matchAll(itemPattern)) {
    const block = match[1]!;
    const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? "";
    const link = /<link>([\s\S]*?)<\/link>/.exec(block)?.[1] ?? "";
    const pubDate = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1] ?? "";
    const contentEncoded = /<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/.exec(block)?.[1] ?? "";
    items.push({ title, link, pubDate, contentEncoded });
  }

  return items;
}

describe("lib/berita: renderBeritaRssXml", () => {
  test("produces a well-formed rss/channel document with exactly one balanced <item> per entry", () => {
    const xml = renderBeritaRssXml(CHANNEL, [ITEM]);

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">');
    expect((xml.match(/<item>/g) ?? []).length).toBe(1);
    expect((xml.match(/<\/item>/g) ?? []).length).toBe(1);
    expect(xml).toContain("<channel>");
    expect(xml).toContain("</channel></rss>");
  });

  test("parses back to the same title/link and a full, un-truncated content:encoded body", () => {
    const xml = renderBeritaRssXml(CHANNEL, [ITEM]);
    const [parsed] = extractItems(xml);

    expect(parsed?.title).toBe(ITEM.title);
    expect(parsed?.link).toBe(ITEM.link);
    expect(parsed?.contentEncoded).toBe(ITEM.contentHtml);
  });

  test("pubDate is RFC 822 (Date#toUTCString), not a bare ISO string", () => {
    const xml = renderBeritaRssXml(CHANNEL, [ITEM]);
    const [parsed] = extractItems(xml);
    expect(parsed?.pubDate).toBe(new Date(ITEM.publishedAt).toUTCString());
    expect(parsed?.pubDate).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  });

  test("a title containing '&' round-trips through entity-escaping", () => {
    const xml = renderBeritaRssXml(CHANNEL, [{ ...ITEM, title: "Kobar & Sukamara" }]);
    expect(xml).toContain("Kobar &amp; Sukamara");
    expect(xml).not.toContain("Kobar & Sukamara<");
  });

  test("a body containing the literal CDATA close sequence is split, not left to break the section", () => {
    const xml = renderBeritaRssXml(CHANNEL, [{ ...ITEM, contentHtml: "<p>a]]>b</p>" }]);
    // The naive, un-split sequence must never appear verbatim.
    expect(xml).not.toContain("a]]>b");
    expect(xml).toContain("a]]]]><![CDATA[>b");
  });

  test("zero items still renders a valid, empty channel", () => {
    const xml = renderBeritaRssXml(CHANNEL, []);
    expect(xml).not.toContain("<item>");
    expect(xml).toContain("</channel></rss>");
  });
});
