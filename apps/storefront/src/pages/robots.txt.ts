/**
 * `robots.txt` (issue #24) — allow everything except the two pages a crawler
 * has no business indexing (a cart and a checkout are per-visitor state, not
 * content) and the API path this app itself never calls at runtime but a
 * misconfigured crawler might still probe.
 */
import { siteConfig } from "../config/site";

export const prerender = true;

export function GET(): Response {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /keranjang",
    "Disallow: /checkout",
    "Disallow: /api/",
    "",
    `Sitemap: ${siteConfig.siteUrl}/sitemap-index.xml`,
    ""
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
