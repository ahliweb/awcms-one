/** `/rubrik/[slug]/feed.xml` — one rubrik's own RSS 2.0 feed (issue #28), same shape as `src/profil/berita/pages/berita/feed.xml.ts`. */
import type { APIRoute, GetStaticPaths } from "astro";
import { getRubrikTree, getRubrik, getPost, renderBeritaRssXml, flattenRubrikTree, type BeritaFeedItem } from "../../../../../lib/berita";
import { renderPortableText } from "../../../../../lib/portable-text";
import { absoluteUrl } from "../../../../../config/site";
import { ROUTES } from "../../../../../config/routes";
import { getSiteIdentity } from "../../../../../lib/awcms/profil";

export const prerender = true;

const FEED_ITEM_LIMIT = 20;

export const getStaticPaths: GetStaticPaths = async () => {
  const tree = await getRubrikTree();
  return flattenRubrikTree(tree).map((node) => ({ params: { slug: node.slug } }));
};

export const GET: APIRoute = async ({ params }) => {
  const slug = params.slug as string;
  const archive = await getRubrik(slug);

  if (!archive) {
    return new Response("Not found", { status: 404 });
  }

  const identity = await getSiteIdentity();

  const items: BeritaFeedItem[] = await Promise.all(
    archive.posts.slice(0, FEED_ITEM_LIMIT).map(async (summary) => {
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
      title: `${identity.name} — ${archive.term.name}`,
      link: absoluteUrl(ROUTES.rubric(slug)),
      description: `Berita rubrik ${archive.term.name}.`
    },
    items
  );

  return new Response(body, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" }
  });
};
