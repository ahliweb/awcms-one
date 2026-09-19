/**
 * `/berita/feed.xml` — RSS 2.0, 20 latest posts, full `content:encoded`
 * (issue #28). Replaces the "products, for now" placeholder
 * `src/profil/toko/pages/feed.xml.ts` (issue #24) named in its own docblock — that file
 * is untouched (outside this issue's file ownership; it stays as the
 * catalog's own feed).
 */
import { getPosts, getPost, renderBeritaRssXml, type BeritaFeedItem } from "../../../../lib/berita";
import { renderPortableText } from "../../../../lib/portable-text";
import { absoluteUrl } from "../../../../config/site";
import { ROUTES } from "../../../../config/routes";
import { getSiteIdentity } from "../../../../lib/awcms/profil";

export const prerender = true;

const FEED_ITEM_LIMIT = 20;

export async function GET(): Promise<Response> {
  const identity = await getSiteIdentity();
  const posts = await getPosts({ limit: FEED_ITEM_LIMIT });

  const items: BeritaFeedItem[] = await Promise.all(
    posts.map(async (summary) => {
      const detail = await getPost(summary.slug);
      const link = absoluteUrl(ROUTES.article(summary.slug));

      return {
        title: summary.title,
        link,
        guid: link,
        description: summary.excerpt ?? "",
        contentHtml: detail ? renderPortableText(detail.bodyPortableText) : "",
        publishedAt: summary.publishedAt
      };
    })
  );

  const body = renderBeritaRssXml(
    {
      title: `${identity.name} — Berita`,
      link: absoluteUrl(ROUTES.news),
      description: identity.description
    },
    items
  );

  return new Response(body, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" }
  });
}
