import { afterEach, describe, expect, test } from "bun:test";
import {
  registerSitemapSource,
  resetSitemapSourcesForTests,
  resetSitemapEntriesCacheForTests,
  collectSitemapEntries,
  chunkSitemapEntries,
  renderUrlsetXml,
  renderSitemapIndexXml,
  SITEMAP_MAX_URLS_PER_FILE
} from "../src/lib/sitemap";

afterEach(() => {
  resetSitemapSourcesForTests();
  resetSitemapEntriesCacheForTests();
});

describe("lib/sitemap: registry", () => {
  test("registering the same name twice throws rather than silently replacing", () => {
    registerSitemapSource("a", async () => []);
    expect(() => registerSitemapSource("a", async () => [])).toThrow();
  });

  test("collectSitemapEntries concatenates every registered source, in registration order", async () => {
    registerSitemapSource("first", async () => [{ loc: "https://example.test/1" }]);
    registerSitemapSource("second", async () => [{ loc: "https://example.test/2" }]);

    const entries = await collectSitemapEntries();
    expect(entries.map((e) => e.loc)).toEqual([
      "https://example.test/1",
      "https://example.test/2"
    ]);
  });

  test("no registered sources yields an empty list, not an error", async () => {
    expect(await collectSitemapEntries()).toEqual([]);
  });
});

describe("lib/sitemap: chunking", () => {
  test("an empty entry list still yields one (empty) chunk — /sitemap-1.xml is always a valid URL", () => {
    expect(chunkSitemapEntries([])).toEqual([[]]);
  });

  test("splits at SITEMAP_MAX_URLS_PER_FILE, never producing an oversized chunk", () => {
    const entries = Array.from({ length: SITEMAP_MAX_URLS_PER_FILE + 1 }, (_, i) => ({
      loc: `https://example.test/${i}`
    }));

    const chunks = chunkSitemapEntries(entries);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(SITEMAP_MAX_URLS_PER_FILE);
    expect(chunks[1]).toHaveLength(1);
  });

  test("a list under the limit is exactly one chunk", () => {
    const entries = [{ loc: "https://example.test/1" }, { loc: "https://example.test/2" }];
    expect(chunkSitemapEntries(entries)).toEqual([entries]);
  });
});

describe("lib/sitemap: XML rendering", () => {
  test("renderUrlsetXml escapes an ampersand in a loc and includes optional fields when present", () => {
    const xml = renderUrlsetXml([
      { loc: "https://example.test/?a=1&b=2", lastmod: "2026-01-01", changefreq: "daily", priority: 0.8 }
    ]);
    expect(xml).toContain("https://example.test/?a=1&amp;b=2");
    expect(xml).toContain("<lastmod>2026-01-01</lastmod>");
    expect(xml).toContain("<changefreq>daily</changefreq>");
    expect(xml).toContain("<priority>0.8</priority>");
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  });

  test("renderUrlsetXml omits optional fields entirely when absent, rather than emitting empty tags", () => {
    const xml = renderUrlsetXml([{ loc: "https://example.test/" }]);
    expect(xml).not.toContain("<lastmod>");
    expect(xml).not.toContain("<changefreq>");
    expect(xml).not.toContain("<priority>");
  });

  test("renderSitemapIndexXml lists every given sitemap URL", () => {
    const xml = renderSitemapIndexXml([
      "https://example.test/sitemap-1.xml",
      "https://example.test/sitemap-2.xml"
    ]);
    expect(xml).toContain("https://example.test/sitemap-1.xml");
    expect(xml).toContain("https://example.test/sitemap-2.xml");
    expect(xml).toContain("<sitemapindex");
  });
});
