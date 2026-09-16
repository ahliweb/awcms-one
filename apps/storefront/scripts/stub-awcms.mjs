#!/usr/bin/env bun
/**
 * A local stand-in for awcms, used ONLY to prove `bun run build` produces a
 * real `dist/client` without a live CMS (issue #5 acceptance: "builds
 * against a stubbed CMS response"). Serves the two commerce endpoints
 * `src/lib/catalog.ts` calls, reading their response bodies straight from
 * the fixtures committed at `tests/fixtures/awcms/` — the shape this script
 * answers with is exactly the shape a reviewer can already read as plain
 * JSON, not a shape hidden inside this script. Both fixtures hold the real
 * `{ items, nextCursor }` keyset page shape `apps/cms`'s commerce routes
 * actually return inside `ok({...})` (issue #6 caught this script previously
 * agreeing with an invented `{ products }` / `{ categories }` shape instead
 * of the true one).
 *
 * Not part of the production build or image: nothing under `scripts/` is
 * imported by `astro.config.mjs`, `src/`, or `server/penyaji.mjs`, and this
 * file is not wired into any `package.json` script — it is a manual,
 * explicit step for local/CI verification against a build that has no live
 * CMS to reach.
 *
 * Usage (two terminals):
 *   bun scripts/stub-awcms.mjs
 *   AWCMS_API_URL=http://localhost:4310 AWCMS_API_TOKEN=stub-token \
 *     SITE_URL=http://localhost:4321 bun run build
 *
 * Issue #24 adds four more routes, all read straight from committed
 * fixtures the same way the two commerce ones already are:
 *
 *   - `/api/v1/site-profile/composed` — `site-profile-composed.json`
 *     (`src/lib/awcms/profil.ts`).
 *   - `/api/v1/blog/pages/public` — `blog-pages-public.json`, and
 *     `/api/v1/blog/pages/public/{slug}` — one entry of
 *     `blog-pages-public-detail.json`, keyed by slug (`src/lib/awcms/
 *     pages.ts`).
 *   - `/theming/{tenantCode}/tokens.css` — `tokens.css`, served RAW
 *     (`text/css`, not the `{success,data}` envelope) and with NO
 *     Authorization check, because the real route
 *     (`apps/cms/src/modules/theming/presentation/theme-public-css.ts`) is
 *     genuinely public — see `src/lib/awcms/theme.ts`'s docblock for why
 *     this app calls that route and not `GET /api/v1/theming`. `tenantCode`
 *     in the path is accepted but ignored, same as every other stub route
 *     ignoring which tenant a token belongs to.
 *
 * Issue #28 adds six more, all read straight from committed fixtures the
 * same way, and all ignoring their query parameters exactly the way the
 * commerce routes above already do (one fixture page is "the whole
 * response", regardless of `?status=`/`?order=`/`?cursor=`/etc.):
 *
 *   - `/api/v1/blog/posts` — `blog-posts.json` (`src/lib/awcms/blog.ts`,
 *     `{ posts, nextCursor: null }`, `view=full` shape).
 *   - `/api/v1/blog/terms` — `blog-terms.json` (`{ terms, nextCursor: null }`).
 *   - `/api/v1/blog/institutions` — `blog-institutions.json`
 *     (`{ institutions }`, genuinely unpaginated — see that file's docblock).
 *   - `/api/v1/idn-regions/regions` — `regions-kalteng.json`
 *     (`src/lib/awcms/wilayah.ts`, `{ datasetCode, items, nextCursor: null,
 *     reason: null }`). `/api/v1/idn-regions/regions/{code}` (the by-code
 *     detail route) has NO stub entry: `wilayah.ts` only ever calls the list
 *     route.
 *   - `/api/v1/news-portal/ad-placements/active` — `ad-placements-active.json`
 *     (`{ slots }`).
 *   - `/api/v1/seo/redirects` — `seo-redirects-legacy.json`
 *     (`{ redirects, nextCursor: null }`).
 */
import { readFileSync } from "node:fs";

const PORT = Number(process.env.STUB_PORT ?? 4310);
const FIXTURES = new URL("../tests/fixtures/awcms/", import.meta.url);

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
}

function rawFixture(name) {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

const ROUTES = {
  "/api/v1/commerce/products": () => fixture("products.json"),
  "/api/v1/commerce/categories": () => fixture("categories.json"),
  "/api/v1/site-profile/composed": () => fixture("site-profile-composed.json"),
  "/api/v1/blog/pages/public": () => fixture("blog-pages-public.json"),
  // #28 news
  "/api/v1/blog/posts": () => fixture("blog-posts.json"),
  "/api/v1/blog/terms": () => fixture("blog-terms.json"),
  "/api/v1/blog/institutions": () => fixture("blog-institutions.json"),
  "/api/v1/idn-regions/regions": () => fixture("regions-kalteng.json"),
  "/api/v1/news-portal/ad-placements/active": () => fixture("ad-placements-active.json"),
  "/api/v1/seo/redirects": () => fixture("seo-redirects-legacy.json")
};

const TOKENS_CSS_PATTERN = /^\/theming\/[^/]+\/tokens\.css$/;
const BLOG_PAGE_DETAIL_PATTERN = /^\/api\/v1\/blog\/pages\/public\/([^/]+)$/;

const server = Bun.serve({
  port: PORT,
  fetch(request) {
    const url = new URL(request.url);

    // Public, no auth at all — matches the real route exactly (see file
    // header). Checked BEFORE the bearer-token gate below, not after: a
    // stub that demanded a header the real route never asks for would hide
    // a caller that forgot to send one wasn't actually required.
    if (TOKENS_CSS_PATTERN.test(url.pathname)) {
      return new Response(rawFixture("tokens.css"), {
        headers: { "content-type": "text/css; charset=utf-8" }
      });
    }

    const authorization = request.headers.get("authorization") ?? "";

    // Not a security boundary — this is a local fixture server — but a
    // build that sent NO Authorization header at all would be a real bug in
    // `awcmsGet`, and a stub that accepted it silently would hide exactly
    // that bug.
    if (!authorization.startsWith("Bearer ")) {
      return Response.json(
        { success: false, error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } },
        { status: 401 }
      );
    }

    const detailMatch = BLOG_PAGE_DETAIL_PATTERN.exec(url.pathname);
    if (detailMatch) {
      const slug = decodeURIComponent(detailMatch[1]);
      const detail = fixture("blog-pages-public-detail.json")[slug];
      if (!detail) {
        return Response.json(
          { success: false, error: { code: "RESOURCE_NOT_FOUND", message: `No stub page for slug ${slug}` } },
          { status: 404 }
        );
      }
      return Response.json({ success: true, data: detail });
    }

    const handler = ROUTES[url.pathname];
    if (!handler) {
      return Response.json(
        { success: false, error: { code: "NOT_FOUND", message: `No stub route for ${url.pathname}` } },
        { status: 404 }
      );
    }

    return Response.json({ success: true, data: handler() });
  }
});

console.log(`[stub-awcms] serving fixtures on http://localhost:${server.port}`);
