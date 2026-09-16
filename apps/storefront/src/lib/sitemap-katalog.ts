/**
 * Registers `/produk`, `/kategori/[slug]`, `/flash-sale`, and every
 * `/product/[slug]` with the sitemap (issue #24's registry,
 * `src/lib/sitemap.ts`). Imported once, for its side effect, from
 * `src/lib/sitemap-sources.ts` — see that file's own docblock for why
 * registration is centralized there.
 *
 * `/cari` is deliberately ABSENT: the issue's own SEO section calls for
 * `noindex` on search, and a URL excluded from every crawler's index has no
 * business in a sitemap either.
 */
import { registerSitemapSource, type SitemapEntry } from "./sitemap";
import { absoluteUrl } from "../config/site";
import { ROUTES } from "../config/routes";
import { getProducts, getCategories } from "./catalog";

registerSitemapSource("katalog-produk", async (): Promise<SitemapEntry[]> => [
  { loc: absoluteUrl(ROUTES.products), changefreq: "daily", priority: 0.9 },
  { loc: absoluteUrl(ROUTES.flashSale), changefreq: "hourly", priority: 0.7 }
]);

registerSitemapSource("katalog-kategori", async (): Promise<SitemapEntry[]> => {
  const categories = await getCategories();
  return categories.map((category) => ({
    loc: absoluteUrl(ROUTES.category(category.slug)),
    changefreq: "weekly",
    priority: 0.6
  }));
});

registerSitemapSource("katalog-product-detail", async (): Promise<SitemapEntry[]> => {
  const products = await getProducts();
  return products.map((product) => ({
    loc: absoluteUrl(`/product/${product.slug}`),
    changefreq: "weekly",
    priority: 0.5
  }));
});

/** The names this file registers, exported so a test can assert against them without re-typing the list — same convention `sitemap-sources.ts`'s own `SITEMAP_SOURCE_NAMES` uses. */
export const KATALOG_SITEMAP_SOURCE_NAMES = [
  "katalog-produk",
  "katalog-kategori",
  "katalog-product-detail"
] as const;
