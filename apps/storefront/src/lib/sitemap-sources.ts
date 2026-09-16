/**
 * Registers every sitemap source this build knows about (issue #24).
 *
 * The ONE file `src/pages/sitemap-index.xml.ts` and `src/pages/
 * sitemap-[n].xml.ts` import for its side effect before calling
 * `getAllSitemapEntries()` — centralizing registration here, rather than
 * having each source register itself from inside its own page module,
 * means those two page files never need to know the full list of sources
 * that exist, and #27/#28 (products, news) add their own
 * `registerSitemapSource(...)` call to this file and nothing else.
 *
 * Static routes registered here are only the ones THIS issue actually
 * builds a page for (`/`, `/kontak`) — a route another issue has not built
 * yet (`/produk`, `/berita`, ...) has no page to point a crawler at, so it
 * is that issue's job to register it once the page exists.
 */
import { registerSitemapSource, type SitemapEntry } from "./sitemap";
import { absoluteUrl } from "../config/site";
import { ROUTES } from "../config/routes";
import { listStaticPages } from "./awcms/pages";

registerSitemapSource("static-routes", async (): Promise<SitemapEntry[]> => [
  { loc: absoluteUrl(ROUTES.home), changefreq: "daily", priority: 1.0 },
  { loc: absoluteUrl(ROUTES.contact), changefreq: "monthly", priority: 0.5 }
]);

registerSitemapSource("static-pages", async (): Promise<SitemapEntry[]> => {
  const pages = await listStaticPages();
  return pages.map((page) => ({
    loc: absoluteUrl(ROUTES.page(page.slug)),
    lastmod: page.updatedAt,
    changefreq: "monthly",
    priority: 0.3
  }));
});

/** The names this file registers, exported so a test can assert against them without re-typing the list. */
export const SITEMAP_SOURCE_NAMES = ["static-routes", "static-pages"] as const;
