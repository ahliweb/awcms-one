/**
 * The sitemap index (issue #24) — one `<sitemap>` entry per chunk
 * `sitemap-[n].xml.ts` will serve. `src/lib/sitemap-sources.ts` is imported
 * for its side effect (registration) before anything here reads the
 * registry — see that file's docblock.
 */
import "../lib/sitemap-sources";
import { getAllSitemapEntries, chunkSitemapEntries, renderSitemapIndexXml } from "../lib/sitemap";
import { absoluteUrl } from "../config/site";

export const prerender = true;

export async function GET(): Promise<Response> {
  const entries = await getAllSitemapEntries();
  const chunkCount = chunkSitemapEntries(entries).length;

  const sitemapUrls = Array.from({ length: chunkCount }, (_, i) =>
    absoluteUrl(`/sitemap-${i + 1}.xml`)
  );

  return new Response(renderSitemapIndexXml(sitemapUrls), {
    headers: { "Content-Type": "application/xml; charset=utf-8" }
  });
}
