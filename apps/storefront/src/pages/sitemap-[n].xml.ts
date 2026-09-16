/**
 * One sitemap file — up to `SITEMAP_MAX_URLS_PER_FILE` (5000) URLs per the
 * sitemap protocol (issue #24). `n` is 1-indexed to match
 * `sitemap-index.xml.ts`'s `/sitemap-{i + 1}.xml` links.
 */
import type { APIRoute, GetStaticPaths } from "astro";
import "../lib/sitemap-sources";
import { getAllSitemapEntries, chunkSitemapEntries, renderUrlsetXml } from "../lib/sitemap";

export const prerender = true;

export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await getAllSitemapEntries();
  const chunks = chunkSitemapEntries(entries);

  return chunks.map((chunk, index) => ({
    params: { n: String(index + 1) },
    props: { chunk }
  }));
};

export const GET: APIRoute = ({ props }) => {
  const chunk = (props as { chunk: Awaited<ReturnType<typeof getAllSitemapEntries>> }).chunk;

  return new Response(renderUrlsetXml(chunk), {
    headers: { "Content-Type": "application/xml; charset=utf-8" }
  });
};
