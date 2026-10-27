/**
 * `/sw-notifikasi.js` - the storefront-origin push service worker (issue #431,
 * ADR-0048 section 7). Injected as a route by `integrations/profil.mjs` ONLY
 * when `PUBLIC_CUSTOMER_PUSH` is on and the profile carries customer accounts;
 * with the flag off this file is never routed, so the build has no worker at
 * all. It lives under `src/push/` (not `src/pages/`) so Astro's own file-based
 * routing cannot pick it up.
 *
 * The worker itself is plain JavaScript in `pekerja/sw-notifikasi.js` - served
 * verbatim, unbundled and unhashed, because a registration is keyed by script
 * URL (see that file's header). `?raw` inlines its text at build time; no
 * template, no environment value and no tenant data is ever interpolated into
 * it, so the file is byte-identical on every deployment.
 */
import worker from "./pekerja/sw-notifikasi.js?raw";

export const prerender = true;

export function GET(): Response {
  return new Response(worker, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      // The server (`server/penyaji.mjs`) already sends `public, max-age=0,
      // must-revalidate` for everything outside `/_astro/`; named here too so
      // a reader of this file sees the requirement and a dev server honours it.
      "Cache-Control": "public, max-age=0, must-revalidate"
    }
  });
}
