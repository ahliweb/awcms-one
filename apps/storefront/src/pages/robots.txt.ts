/**
 * `robots.txt` (issue #24) — allow everything except the two pages a crawler
 * has no business indexing (a cart and a checkout are per-visitor state, not
 * content) and the API path this app itself never calls at runtime but a
 * misconfigured crawler might still probe.
 *
 * Issue #27 adds `/cari`: its own acceptance criteria call for `noindex` on
 * the search page, but `BaseLayout.astro` (outside this issue's file
 * ownership) has no per-page `<meta name="robots">` slot to set one from —
 * disallowing the crawl here is the closest equivalent this issue can
 * deliver without touching that shared file, and is a stronger signal than
 * a meta tag alone for a page whose whole point is arbitrary `?q=` query
 * strings a crawler should never index in the first place.
 *
 * Issue #30 adds `/pesanan` (order tracking — the code AND the phone travel
 * as query string/`sessionStorage`, never content a crawler has business
 * fetching) and `/wishlist` (pure `localStorage` state, no content of its
 * own to index, same reasoning as `/cari`). Both also carry `<meta
 * name="robots" content="noindex, follow">` via `BaseLayout.astro`'s `head`
 * slot (issue #27), for the same "Disallow stops the FETCH, noindex stops
 * the INDEX of a URL linked from elsewhere" reason `/cari`'s own comment
 * above already gives.
 *
 * Issue #50 adds `/newsletter/confirm` and `/newsletter/unsubscribe` — both
 * carry a one-time reader-specific `?token=`, so both get the same
 * Disallow+noindex pair for the same reason as `/pesanan` above. Both paths
 * are fixed by an `apps/cms` contract (`NEWSLETTER_CONFIRM_PATH`/
 * `NEWSLETTER_UNSUBSCRIBE_PATH`, see `apps/storefront/README.md`'s
 * "Newsletter" section), not this app's own naming. `/buletin` itself (the
 * subscribe form) is deliberately NOT disallowed: it has real, shareable
 * content and no per-reader query string.
 *
 * Issue #88 adds `/masuk`, `/daftar`, and `/akun` — a sign-in form, a
 * registration form, and a signed-in dashboard are none of them content a
 * crawler has any business fetching, and a bare `Disallow: /akun` covers
 * every child route (`/akun/pesanan`, `/akun/alamat`, …) as they land in
 * S2/S3 without this file needing to grow a new line per child. Each of the
 * three also carries `<meta name="robots" content="noindex, follow">` via
 * `BaseLayout.astro`'s `head` slot, for the same "Disallow stops the FETCH,
 * noindex stops the INDEX of a URL linked from elsewhere" reason this file's
 * own comments above already give.
 *
 * Issue #137: the `Disallow` list is `src/config/profil.ts`'s
 * `ROBOTS_DISALLOW` — every rule above tagged with the page group that owns
 * the path, filtered to the active build profile. `toko` emits exactly the
 * list this file always emitted; `berita` drops the commerce paths (they do
 * not exist in that build) and keeps the newsletter pair and `/api/`;
 * `landing` keeps `/api/` only.
 */
import { siteConfig } from "../config/site";
import { ROBOTS_DISALLOW } from "../config/profil";

export const prerender = true;

export function GET(): Response {
  const body = [
    "User-agent: *",
    "Allow: /",
    ...ROBOTS_DISALLOW.map((path) => `Disallow: ${path}`),
    "",
    `Sitemap: ${siteConfig.siteUrl}/sitemap-index.xml`,
    ""
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
