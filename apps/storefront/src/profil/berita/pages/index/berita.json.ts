/**
 * `/index/berita.json` — the build-time search index `/cari-berita.astro`
 * fetches client-side (issue #28, same pattern as issue #27's own product
 * index): `slug`, `title`, `excerpt`, `rubrik`, `region`, `date` per post —
 * exactly the fields a client-side substring search over a static file
 * needs, never the full body (that stays behind `/berita/{slug}` — this
 * index is not a second copy of the article).
 */
import { getPosts } from "../../../../lib/berita";

export const prerender = true;

export type BeritaIndexEntry = {
  slug: string;
  title: string;
  excerpt: string | null;
  rubrik: string | null;
  region: string | null;
  date: string;
};

export async function GET(): Promise<Response> {
  const posts = await getPosts();

  const index: BeritaIndexEntry[] = posts.map((post) => ({
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    rubrik: post.rubric?.name ?? null,
    region: post.region?.name ?? null,
    date: post.publishedAt
  }));

  return new Response(JSON.stringify(index), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
