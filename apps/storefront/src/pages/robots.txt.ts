/**
 * `robots.txt` (issue #24) — allow everything except the two pages a crawler
 * has no business indexing (a cart and a checkout are per-visitor state, not
 * content) and the API path this app itself never calls at runtime but a
 * misconfigured crawler might still probe.
 *
 * Issue #27 adds `/cari`: its own acceptance criteria call for `noindex` on
 * the search page, but `BaseLayout.astro` (outside this issue's file
 * ownership) has no per-page `<meta name="robots">` slot to set one from —
 * disallowing the crawl here is the closest equivalent this issue can
 * deliver without touching that shared file, and is a stronger signal than
 * a meta tag alone for a page whose whole point is arbitrary `?q=` query
 * strings a crawler should never index in the first place.
 */
import { siteConfig } from "../config/site";

export const prerender = true;

export function GET(): Response {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /keranjang",
    "Disallow: /checkout",
    "Disallow: /cari",
    "Disallow: /api/",
    "",
    `Sitemap: ${siteConfig.siteUrl}/sitemap-index.xml`,
    ""
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
