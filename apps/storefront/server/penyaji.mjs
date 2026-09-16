#!/usr/bin/env bun
/**
 * Production server: the Bun process that serves this app's build, behind
 * whatever reverse proxy terminates TLS.
 *
 * ## Why this file exists, and why it stays this short
 *
 * `@astrojs/node`'s standalone adapter already does the part that is
 * dangerous to reimplement: turning a request URL into a file under
 * `dist/client/` — traversal, double-encoding, symlinks are a solved
 * problem in the library it uses (`send`), and re-solving it here would
 * only add a second place that check could be wrong. What the adapter does
 * NOT do is set the security headers this app needs, or tell a hashed,
 * cacheable build asset apart from an HTML page that must always be
 * revalidated. Those two things, plus one hardcoded URL-continuity
 * redirect (`isProductsRedirect` below), are this file's whole job.
 *
 * No compression middleware here: a reverse proxy in front of this
 * container commonly already handles gzip/brotli, and a second compression
 * layer here would be scope this app was not asked to carry. `isProductsRedirect`
 * is one hardcoded rule for one URL this app itself used to serve, not the
 * generated `asal-pengalihan`-style redirect data file issue #5's file
 * checklist excludes; see that issue's "Scope amendment: match the live
 * site's URL shape" comment.
 *
 * Issue #24 adds two more small, self-contained jobs, both still read-only
 * against files `astro build` already wrote — neither reads an `AWCMS_*`
 * variable, so "a finished build never contacts awcms again" still holds:
 *
 *   - `/healthz` — reports the build id `scripts/write-build-id.mjs` wrote
 *     to `dist/client/build-id.txt` as part of `bun run build`, so an
 *     operator can tell which build a running container is actually
 *     serving without shelling in.
 *   - `Link: rel=preload` for every CSS file `astro build` emitted under
 *     `dist/client/_astro/`, on every non-asset (HTML) response — the
 *     browser can start fetching a page's stylesheet(s) the moment the
 *     response headers arrive, instead of waiting to parse far enough into
 *     `<head>` to find the `<link rel="stylesheet">` tag.
 *
 * Issue #28 adds a third: a legacy-URL redirect MAP this time (unlike
 * `isProductsRedirect`'s one hardcoded rule) — `readLegacyRedirectMap`/
 * `legacyRedirectLocation` below, read once at startup from a build-time
 * artifact (`src/pages/index/pengalihan-legacy.json.ts`), never per
 * request, so the same "no live awcms credential at runtime" invariant
 * holds for it too.
 */
import http from "node:http";
import { posix } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

/** Prefix Astro gives its content-hashed build assets (`build.assets`, default `_astro`). */
const ASSET_PREFIX = "/_astro/";

/**
 * The live site's old catalog URL, matched on path only so a query string
 * (e.g. `?category_slug=…`) does not prevent the match — see
 * `isProductsRedirect` below.
 */
const PRODUCTS_REDIRECT_PATH = "/products";

/** Where `PRODUCTS_REDIRECT_PATH` sends a reader. */
const PRODUCTS_REDIRECT_LOCATION = "/";

export const CACHE_ASSET = "public, max-age=31536000, immutable";
export const CACHE_PAGE = "public, max-age=0, must-revalidate";

/**
 * Content-Security-Policy for this storefront.
 *
 * Every directive is `'self'` or `'none'` — no exemption, no configured
 * external origin, because this app has none to allow: `CommerceProduct`
 * (`src/lib/catalog.ts`) carries no image/media field, so there is no
 * product-photo origin to widen `img-src` for, and no page here makes a
 * browser-side fetch/XHR call that would need `connect-src` widened either.
 * That is what "CSP-strict" (issue #5) means in practice for this app: not
 * a policy with exemptions carefully justified, but a policy that needs
 * none.
 *
 * The one thing that would normally tempt an inline `style=""` or a
 * hand-written `<style>` block — coloring a product's label badge from its
 * CMS-supplied `labelColor` — is instead a build-time-generated EXTERNAL
 * stylesheet (`src/pages/product-labels.css.ts`), specifically so
 * `style-src 'self'` never needs `'unsafe-inline'`.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

/** This storefront has no form, collects no reader data, and loads no third-party script — so every one of these stays off. */
export const PERMISSIONS_POLICY = "geolocation=(), camera=(), microphone=(), payment=()";

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": CSP,
  "Permissions-Policy": PERMISSIONS_POLICY
};

/**
 * `Strict-Transport-Security` — sent only in production (see
 * `securityHeaders` below).
 *
 * HSTS cannot be undone from this site's side: once a browser accepts it,
 * that browser refuses plain HTTP to this host for the whole `max-age`.
 * `bun run serve` / `bun run preview` run THIS file on localhost, and
 * sending HSTS there would lock a developer's own browser out of
 * `http://localhost` for a year, with no way back short of clearing
 * browser-internal HSTS state by hand.
 */
export const HSTS = "max-age=31536000";

const PRODUCTION_HEADERS = { ...SECURITY_HEADERS, "Strict-Transport-Security": HSTS };

/**
 * The headers sent for this environment — five, or six in production.
 *
 * @param {boolean} [isProduction]
 */
export function securityHeaders(
  // Bracket access, not `process.env.NODE_ENV` — and that is not a style
  // choice. `bun build --target=bun` folds a DOTTED `process.env.NODE_ENV`
  // read into a literal at BUNDLE time, so a default parameter written the
  // dotted way bakes `isProduction = false` into `dist/server/penyaji.mjs`
  // regardless of the container's real `NODE_ENV` at run time — the
  // production image would then never send HSTS no matter what is set.
  // Bracket access, `Bun.env`, and `globalThis.process.env` all survive
  // that folding; the dotted form does not.
  isProduction = process.env["NODE_ENV"] === "production"
) {
  return isProduction ? PRODUCTION_HEADERS : SECURITY_HEADERS;
}

/**
 * The request path, decoded and normalized the same way the adapter's file
 * lookup will see it — so the cache-control decision below agrees with
 * what actually gets served.
 *
 * @param {string} url `req.url` as received.
 * @returns {string}
 */
export function normalizedPath(url) {
  const withoutFragment = url.includes("#") ? url.slice(0, url.indexOf("#")) : url;
  const [path] = withoutFragment.split("?");

  let decoded = path;
  try {
    decoded = decodeURI(path);
  } catch {
    // A URL that fails to decode is answered 400 by the adapter; treating
    // it as "not an asset" here is enough for a header decision.
  }

  return posix.normalize(decoded.startsWith("/") ? decoded : `/${decoded}`);
}

/** @param {string} url @returns {string} */
export function cacheControlFor(url) {
  return normalizedPath(url).startsWith(ASSET_PREFIX) ? CACHE_ASSET : CACHE_PAGE;
}

/**
 * Whether `url` is the live site's old catalog URL (`/products`, with or
 * without a query string like `?category_slug=…`) and should 301 to
 * `PRODUCTS_REDIRECT_LOCATION` instead of reaching the adapter's file
 * lookup, which has nothing at that path any more.
 *
 * The `category_slug` filter such a URL might carry is dropped BY DESIGN,
 * not lost by oversight: category listing pages are not in this slice
 * (issue #5's own out-of-scope list), so there is no page left for that
 * filter to select on. This is one hardcoded rule in the same file that
 * already sets every other response header — not the generated
 * `asal-pengalihan`-style redirect *data file* issue #5 excludes; see that
 * issue's "Scope amendment: match the live site's URL shape" comment for
 * why the two are different things.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isProductsRedirect(url) {
  return normalizedPath(url) === PRODUCTS_REDIRECT_PATH;
}

/** The path `/healthz` reports on (issue #24). Never `/api/*` — this app has no API of its own, and the name must not collide with `Disallow: /api/` in `robots.txt.ts`. */
const HEALTHZ_PATH = "/healthz";

/** @param {string} url @returns {boolean} */
export function isHealthzRequest(url) {
  return normalizedPath(url) === HEALTHZ_PATH;
}

// --- issue #28: legacy URL compatibility (seputarborneo/beritasampit) ------
//
// `src/pages/index/pengalihan-legacy.json.ts` bakes the CMS's own
// `awcms_seo_redirects` rows (`origin: "legacy_blog"`) into a static
// `sourcePath -> targetPath` map at build time
// (`src/lib/pengalihan-legacy.ts`'s `buildLegacyRedirectMap`). This block
// reads that SAME artifact once, at server startup — never at request
// time, so a finished build still never contacts awcms again — and 301s a
// matching request before it ever reaches the adapter's file lookup,
// exactly the pattern `isProductsRedirect`/`PRODUCTS_REDIRECT_LOCATION`
// above already established for one hardcoded URL.

/** Where `astro build` writes the legacy-redirect artifact, relative to `dist/client/` — a sibling of `build-id.txt`. */
const LEGACY_REDIRECTS_PATH = "index/pengalihan-legacy.json";

/**
 * The `sourcePath -> targetPath` map, or `{}` when the file is missing/
 * unreadable/malformed (a fresh checkout with no `dist/` yet, or a build
 * predating this issue) — degrades to "no legacy redirects configured"
 * rather than throwing, the same posture `readBuildId` already takes for
 * its own sibling artifact.
 *
 * @param {URL} clientDir
 * @returns {Record<string, string>}
 */
export function readLegacyRedirectMap(clientDir) {
  try {
    const raw = readFileSync(new URL(LEGACY_REDIRECTS_PATH, clientDir), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The destination for `url`'s path in `map`, or `null` when there is no
 * matching legacy rule — a plain object lookup, not a loop, so a large
 * redirect table costs no more per request than a small one.
 *
 * `normalizedPath` alone is not enough: `path.posix.normalize` PRESERVES a
 * trailing slash (`/2024/01/15/x/` stays `/2024/01/15/x/`), but
 * `src/lib/pengalihan-legacy.ts`'s `normalizeLegacyPath` — which built this
 * map's keys at build time — STRIPS one (beritasampit's own
 * `/{yyyy}/{mm}/{dd}/{slug}/` shape is a trailing-slash URL). Without
 * stripping it here too, every beritasampit-shaped legacy URL would
 * silently miss this map and fall through to the adapter, which redirects
 * it to strip the slash anyway (`trailingSlash: "never"`) but to ITS OWN
 * unchanged path — never to `/berita/{slug}` — one hop short of where a
 * reader actually needs to land.
 *
 * @param {string} url
 * @param {Record<string, string>} map
 * @returns {string | null}
 */
export function legacyRedirectLocation(url, map) {
  const path = normalizedPath(url);
  const key = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

/**
 * `dist/client/build-id.txt` — written by `scripts/write-build-id.mjs` as
 * part of `bun run build`, AFTER `astro build` and BEFORE this file is
 * bundled. Never re-derived here: computing "the current build id" inside
 * the SERVED process would answer "what am I running right now", which is
 * not the question `/healthz` exists to answer — a stale container
 * serving an old image should report the OLD id it was actually built
 * with.
 *
 * Missing/unreadable degrades to `"unknown"` rather than throwing: a
 * health check that 500s because a diagnostic file is absent is worse than
 * one that answers with a value that says, honestly, "no build id was
 * recorded".
 *
 * @param {URL} clientDir
 * @returns {string}
 */
export function readBuildId(clientDir) {
  try {
    const contents = readFileSync(new URL("build-id.txt", clientDir), "utf8").trim();
    return contents.length > 0 ? contents : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Every CSS file `astro build` emitted under `dist/client/_astro/`, as
 * `/_astro/<file>` paths — the `Link: rel=preload` targets (issue #24).
 * Sorted so the header is byte-stable across a rebuild that changes
 * nothing.
 *
 * An unreadable/missing directory (a fresh checkout with no `dist/` yet)
 * degrades to an empty list — no `Link` header is sent, not a crash.
 *
 * @param {URL} clientDir
 * @returns {string[]}
 */
export function discoverCssPreloadPaths(clientDir) {
  try {
    const assetsDir = new URL("_astro/", clientDir);
    return readdirSync(assetsDir)
      .filter((name) => name.endsWith(".css"))
      .sort()
      .map((name) => `${ASSET_PREFIX}${name}`);
  } catch {
    return [];
  }
}

/** @param {string[]} paths @returns {string} */
export function preloadLinkHeaderValue(paths) {
  return paths.map((path) => `<${path}>; rel=preload; as=style`).join(", ");
}

/**
 * Writes the `/healthz` response directly — this is a plain `node:http`
 * handler, not the Fetch-API adapter, so `res.end()` is how a response
 * completes here, the same way `createServer`'s 301 branch below does.
 *
 * `Cache-Control: no-store` overrides whatever `applyHeaders` already set:
 * an operator polling this path must never be shown a cached answer from
 * before a redeploy.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {string} buildId
 */
export function writeHealthzResponse(res, buildId) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ ok: true, build: buildId }));
}

/**
 * Sets every response header BEFORE the application handler touches the
 * response.
 *
 * Order matters: `send` (inside the adapter) only sets its own
 * `Cache-Control` when none is present yet, so the value set here wins.
 *
 * `context.cssPreloadLinks` is injected (see `createServer` below) so this
 * function stays testable with a fixed, known list rather than a real
 * `dist/client/_astro/` directory.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ cssPreloadLinks?: string[] }} [context]
 */
export function applyHeaders(req, res, context = {}) {
  for (const [name, value] of Object.entries(securityHeaders())) {
    res.setHeader(name, value);
  }

  const path = normalizedPath(req.url ?? "/");
  res.setHeader("Cache-Control", cacheControlFor(req.url ?? "/"));

  // Only on a page response, never on the asset itself: a stylesheet
  // preloading ITSELF is meaningless, and `_astro/*` is exactly the prefix
  // `cacheControlFor` above already treats as an immutable asset.
  const cssPreloadLinks = context.cssPreloadLinks ?? [];
  if (!path.startsWith(ASSET_PREFIX) && cssPreloadLinks.length > 0) {
    res.setHeader("Link", preloadLinkHeaderValue(cssPreloadLinks));
  }

  // Node does not send `Server`, and nothing here uses Express (the only
  // thing that would send `X-Powered-By`). Removed anyway: "not sent
  // today" and "will never be sent" are different claims, and
  // `removeHeader` on a header that is not present is a no-op either way.
  res.removeHeader("Server");
  res.removeHeader("X-Powered-By");
}

/**
 * Wraps an application handler with the header logic above, plus the two
 * routes that answer before the adapter ever sees the request: the
 * `/products` redirect (unchanged from before issue #24) and `/healthz`.
 *
 * `appHandler` is injected so this file's header behaviour is testable
 * without a real `dist/` build present; so is `context` — see
 * `applyHeaders`/`readBuildId`/`discoverCssPreloadPaths`.
 *
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => unknown} appHandler
 * @param {{ buildId?: string, cssPreloadLinks?: string[], legacyRedirects?: Record<string, string> }} [context]
 */
export function createServer(appHandler, context = {}) {
  return http.createServer((req, res) => {
    applyHeaders(req, res, context);

    if (isHealthzRequest(req.url ?? "/")) {
      writeHealthzResponse(res, context.buildId ?? "unknown");
      return;
    }

    if (isProductsRedirect(req.url ?? "/")) {
      res.statusCode = 301;
      res.setHeader("Location", PRODUCTS_REDIRECT_LOCATION);
      res.end();
      return;
    }

    const legacyTarget = legacyRedirectLocation(req.url ?? "/", context.legacyRedirects ?? {});
    if (legacyTarget) {
      res.statusCode = 301;
      res.setHeader("Location", legacyTarget);
      res.end();
      return;
    }

    appHandler(req, res);
  });
}

/**
 * `HOST` defaults to `0.0.0.0` because this process normally runs inside a
 * container behind a reverse proxy: one that listens on `localhost` only is
 * unreachable from outside the container, which shows up as a health check
 * failing for no stated reason. `PORT` defaults to `8080`.
 */
export async function run() {
  /**
   * The adapter's own entrypoint starts listening the moment it is
   * imported, unless this is set first — and it reads the SAME `PORT`, so a
   * double-start does not masquerade as success: `server.listen` below
   * would fail `EADDRINUSE` instead of silently serving through the wrong
   * process (the one with none of the headers below).
   *
   * The import is INSIDE this function, not at module load: a fresh
   * checkout has no `dist/` yet, and an import at the top of the file would
   * make this whole module — including the header logic above, which is
   * exactly what a test wants to exercise with no build present — fail to
   * import at all.
   */
  process.env.ASTRO_NODE_AUTOSTART = "disabled";
  const { handler } = await import("../dist/server/entry.mjs");

  // Resolved relative to THIS file's own `import.meta.url` rather than
  // `process.cwd()` — `run()` only ever executes as the BUNDLED
  // `dist/server/penyaji.mjs` (`bun run serve`/`build:penyaji`, never the
  // unbundled source), so "up one, into `client/`" is the one correct
  // literal — `readBuildId`/`discoverCssPreloadPaths` take the resulting
  // URL as a parameter precisely so a test can pass a fixture directory
  // instead of relying on this resolution at all.
  const clientDir = new URL("../client/", import.meta.url);
  const buildId = readBuildId(clientDir);
  const cssPreloadLinks = discoverCssPreloadPaths(clientDir);
  const legacyRedirects = readLegacyRedirectMap(clientDir);

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = createServer(handler, { buildId, cssPreloadLinks, legacyRedirects });

  server.listen(port, host, () => {
    console.log(`storefront served by Bun at http://${host}:${port}`);
  });

  // The container is stopped with SIGTERM. Without this it is force-killed
  // after the orchestrator's own grace period expires, and every deploy
  // pays that delay for no reason.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }

  return server;
}

if (import.meta.main) run();
