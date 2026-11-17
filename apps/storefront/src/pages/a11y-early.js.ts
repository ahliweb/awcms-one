/**
 * `/a11y-early.js` — the reading-preferences panel's early-apply script
 * (issue #539, ADR-0057), served as a plain same-origin file.
 *
 * It has to be a CLASSIC, BLOCKING script file: a bundled module is deferred
 * (the page would flash in the wrong text size or contrast) and an inline
 * body is blocked by `script-src 'self'` (`server/penyaji.mjs`). Its source is
 * `src/lib/a11y-early.js`, inlined here as text at build time — never under
 * `public/`, where a script is served verbatim and unreviewed
 * (`tests/storefront-tanpa-service-worker.test.mjs` forbids that), the same
 * route-from-source pattern the push worker uses (`src/push/sw-notifikasi.js.ts`).
 *
 * Prerendered, so it lands in `dist/client/a11y-early.js`; the server already
 * sends `public, max-age=0, must-revalidate` for everything outside
 * `/_astro/`, so an edit reaches visitors on the next request.
 */
import script from "../lib/a11y-early.js?raw";

export const prerender = true;

export function GET(): Response {
  return new Response(script, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate"
    }
  });
}
