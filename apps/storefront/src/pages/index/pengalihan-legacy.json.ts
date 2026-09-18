/**
 * `/index/pengalihan-legacy.json` — the static `sourcePath -> targetPath`
 * legacy-URL redirect map (issue #28), read once, at server startup, by
 * `server/penyaji.mjs`'s additive redirect hook — never at request time.
 * See `src/lib/pengalihan-legacy.ts` for the mapping rule.
 *
 * `getVideo()` (one call, this build's own memoized index —
 * `src/lib/berita.ts`'s `getIndex()`) supplies the video-post slug set
 * `buildLegacyRedirectMap` needs to send a video's legacy URL to
 * `/video/{slug}` rather than the `/berita/{slug}` every other row gets —
 * see that function's own docblock for why a video post never lives at the
 * latter.
 */
import { getLegacyRedirectRows } from "../../lib/awcms/blog";
import { getVideo } from "../../lib/berita";
import { buildLegacyRedirectMap } from "../../lib/pengalihan-legacy";

export const prerender = true;

export async function GET(): Promise<Response> {
  const [rows, videoPosts] = await Promise.all([getLegacyRedirectRows(), getVideo()]);
  const videoSlugs = new Set(videoPosts.map((post) => post.slug));
  const map = buildLegacyRedirectMap(rows, videoSlugs);

  return new Response(JSON.stringify(map), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
