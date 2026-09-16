/**
 * An RSS 2.0 feed of products (issue #24: "products newest-first for now;
 * #28 switches to posts").
 *
 * ## "Newest-first" is approximated, and here is why
 *
 * `CommerceProduct` (`src/lib/catalog.ts`, verified against `apps/cms`'s
 * `product-directory.ts` `toRecord()`) carries no timestamp field at all —
 * no `createdAt`, no `publishedAt`. There is therefore no field this feed
 * can sort by to produce a genuine "newest first" ordering; it emits
 * `getProducts()`'s own list order instead (the commerce list route's
 * default ordering) and says so here rather than inventing a fake
 * `<pubDate>` that would silently claim a precision this DTO does not have.
 * Once a real timestamp lands on the product DTO, sorting by it is a
 * one-line change to `orderedProducts` below.
 *
 * Bounded to the first 50 products (mirroring `apps/cms`'s own
 * `FEED_ITEM_LIMIT` for the blog feed it will replace this with in #28) so
 * this file never emits an unbounded feed as the catalog grows.
 */
import { getProducts, formatPrice } from "../lib/catalog";
import { getSiteIdentity } from "../lib/awcms/profil";
import { siteConfig, absoluteUrl } from "../config/site";

export const prerender = true;

const FEED_ITEM_LIMIT = 50;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET(): Promise<Response> {
  const identity = await getSiteIdentity();
  const products = await getProducts();
  const orderedProducts = products.slice(0, FEED_ITEM_LIMIT);

  const items = orderedProducts
    .map((product) => {
      const url = absoluteUrl(`/product/${product.slug}`);
      const description = product.description ?? formatPrice(product.price);
      return (
        `  <item>\n` +
        `    <title>${escapeXml(product.name)}</title>\n` +
        `    <link>${escapeXml(url)}</link>\n` +
        `    <guid isPermaLink="true">${escapeXml(url)}</guid>\n` +
        `    <description>${escapeXml(description)}</description>\n` +
        `  </item>`
      );
    })
    .join("\n");

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0"><channel>\n` +
    `  <title>${escapeXml(identity.name)}</title>\n` +
    `  <link>${escapeXml(siteConfig.siteUrl)}</link>\n` +
    `  <description>${escapeXml(identity.description)}</description>\n` +
    `${items}\n` +
    `</channel></rss>\n`;

  return new Response(body, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" }
  });
}
