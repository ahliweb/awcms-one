/**
 * `/index/pengalihan-legacy.json` — the static `sourcePath -> targetPath`
 * legacy-URL redirect map (issue #28), read once, at server startup, by
 * `server/penyaji.mjs`'s additive redirect hook — never at request time.
 * See `src/lib/pengalihan-legacy.ts` for the mapping rule.
 */
import { getLegacyRedirectRows } from "../../lib/awcms/blog";
import { buildLegacyRedirectMap } from "../../lib/pengalihan-legacy";

export const prerender = true;

export async function GET(): Promise<Response> {
  const rows = await getLegacyRedirectRows();
  const map = buildLegacyRedirectMap(rows);

  return new Response(JSON.stringify(map), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
