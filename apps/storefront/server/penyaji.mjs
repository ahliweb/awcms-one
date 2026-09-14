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
 * revalidated. Those two things are this file's whole job.
 *
 * No compression middleware and no redirect map here: issue #5 lists
 * `astro`, `@astrojs/node`, and `@astrojs/check` as this app's dependencies
 * and nothing else, and its file checklist carries no redirect config to
 * read. A reverse proxy in front of this container commonly already
 * handles gzip/brotli; a second compression layer here would be scope this
 * app was not asked to carry.
 */
import http from "node:http";
import { posix } from "node:path";

/** Prefix Astro gives its content-hashed build assets (`build.assets`, default `_astro`). */
const ASSET_PREFIX = "/_astro/";

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
 * Sets every response header BEFORE the application handler touches the
 * response.
 *
 * Order matters: `send` (inside the adapter) only sets its own
 * `Cache-Control` when none is present yet, so the value set here wins.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
export function applyHeaders(req, res) {
  for (const [name, value] of Object.entries(securityHeaders())) {
    res.setHeader(name, value);
  }
  res.setHeader("Cache-Control", cacheControlFor(req.url ?? "/"));

  // Node does not send `Server`, and nothing here uses Express (the only
  // thing that would send `X-Powered-By`). Removed anyway: "not sent
  // today" and "will never be sent" are different claims, and
  // `removeHeader` on a header that is not present is a no-op either way.
  res.removeHeader("Server");
  res.removeHeader("X-Powered-By");
}

/**
 * Wraps an application handler with the header logic above.
 *
 * `appHandler` is injected so this file's header behaviour is testable
 * without a real `dist/` build present.
 *
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => unknown} appHandler
 */
export function createServer(appHandler) {
  return http.createServer((req, res) => {
    applyHeaders(req, res);
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

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = createServer(handler);

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
