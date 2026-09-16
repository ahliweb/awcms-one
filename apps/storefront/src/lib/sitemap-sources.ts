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
import {
  getPosts,
  getVideo,
  getRubrikTree,
  listDaerahLinks,
  getTags,
  flattenRubrikTree
} from "./berita";
import { getMitraList } from "./awcms/lembaga";

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

// --- issue #28: news surface — each source below registers under its own
// name, so a textual merge with #27's own additions to this file succeeds.

registerSitemapSource("berita-front", async (): Promise<SitemapEntry[]> => [
  { loc: absoluteUrl(ROUTES.news), changefreq: "hourly", priority: 0.9 },
  { loc: absoluteUrl(ROUTES.video), changefreq: "daily", priority: 0.6 },
  { loc: absoluteUrl(ROUTES.newsSearch), changefreq: "monthly", priority: 0.2 }
]);

registerSitemapSource("berita-posts", async (): Promise<SitemapEntry[]> => {
  const posts = await getPosts();
  return posts.map((post) => ({
    loc: absoluteUrl(ROUTES.article(post.slug)),
    lastmod: post.updatedAt,
    changefreq: "daily",
    priority: 0.7
  }));
});

registerSitemapSource("berita-video", async (): Promise<SitemapEntry[]> => {
  const video = await getVideo();
  return video.map((post) => ({
    loc: absoluteUrl(ROUTES.videoArticle(post.slug)),
    lastmod: post.updatedAt,
    changefreq: "daily",
    priority: 0.6
  }));
});

registerSitemapSource("berita-rubrik", async (): Promise<SitemapEntry[]> => {
  const tree = await getRubrikTree();
  return flattenRubrikTree(tree).map((rubrik) => ({
    loc: absoluteUrl(ROUTES.rubric(rubrik.slug)),
    changefreq: "hourly",
    priority: 0.6
  }));
});

registerSitemapSource("berita-daerah", async (): Promise<SitemapEntry[]> => {
  const regions = await listDaerahLinks();
  return regions.map((region) => ({
    loc: absoluteUrl(ROUTES.region(region.slug)),
    changefreq: "daily",
    priority: 0.5
  }));
});

registerSitemapSource("berita-mitra", async (): Promise<SitemapEntry[]> => {
  const mitra = await getMitraList();
  return mitra.map((m) => ({
    loc: absoluteUrl(ROUTES.partner(m.slug)),
    changefreq: "weekly",
    priority: 0.4
  }));
});

registerSitemapSource("berita-tag", async (): Promise<SitemapEntry[]> => {
  const tags = await getTags();
  return tags.map((tag) => ({
    loc: absoluteUrl(ROUTES.tag(tag.slug)),
    changefreq: "daily",
    priority: 0.3
  }));
});

/** The names this file registers, exported so a test can assert against them without re-typing the list. */
export const SITEMAP_SOURCE_NAMES = [
  "static-routes",
  "static-pages",
  "berita-front",
  "berita-posts",
  "berita-video",
  "berita-rubrik",
  "berita-daerah",
  "berita-mitra",
  "berita-tag"
] as const;
