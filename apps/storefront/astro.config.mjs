import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import profil from "./integrations/profil.mjs";

/**
 * `SITE_URL` is the canonical origin and must be absolute. Astro needs it at
 * config time — before `src/config/site.ts` runs — so it is read here
 * directly from the process environment rather than through that module.
 *
 * The localhost default keeps `bun run dev` working out of the box. It is
 * NOT a safe production value: a build that ships with it publishes
 * canonical links, Open Graph URLs, and JSON-LD pointing at a machine nobody
 * can reach.
 */
const SITE = (process.env.SITE_URL ?? "http://localhost:4321").replace(
  /\/+$/,
  ""
);

export default defineConfig({
  site: SITE,

  /**
   * The build profile (issue #137, ADR-0018 D2/D3). `SITE_PROFILE` (`toko`
   * default | `berita` | `landing`) is read by `src/config/profil.ts`; this
   * integration injects the routes of every page group that profile
   * composes from `src/profil/<group>/pages/**` and points
   * `src/pages/index.astro`'s `@profil/beranda` import at the profile's own
   * home variant. It is the only integration, and it runs in
   * `astro:config:setup` — before Astro scans `src/pages/`, so an injected
   * route and a file-based one are resolved together and a collision
   * would fail the build rather than shadow a page silently.
   */
  integrations: [profil()],

  /**
   * Static output is the whole premise of this app (issue #5). The catalog
   * is fetched from awcms at BUILD time and baked into flat files; the
   * running container never talks to awcms and holds no API token at
   * runtime, so a storefront compromise reaches no customer data — the
   * invariant the sibling `awcms-astro`/`media-lenterakalteng` family is
   * built on, and the one this app inherits rather than re-derives.
   *
   * The trade-off is stated plainly in the issue, not hidden here: price and
   * stock are only as fresh as the last build. That is the right trade for
   * increment 1 (catalog + detail, no cart). Once checkout exists, a runtime
   * read becomes necessary, and that must be a deliberate, separately
   * argued change to this line — not a drift.
   */
  output: "static",

  /**
   * Product pages publish at `/product/{slug}` with no trailing slash —
   * the live site's own URL shape (issue #5 comment "Scope amendment:
   * match the live site's URL shape"), so an indexed link, bookmark, or
   * shared URL keeps working unchanged at cutover instead of needing a
   * permanent 301 map. `"never"` makes that the site-wide rule rather than
   * a per-page opt-out, so a future page can't silently reintroduce a
   * trailing slash Astro itself would otherwise tolerate.
   */
  trailingSlash: "never",

  /**
   * The adapter is here to SERVE the build, not to render pages on demand.
   * `output` above stays `"static"` — every page is prerendered at build
   * time, no route declares `prerender = false`, and the container still
   * never talks to awcms. What the adapter contributes is the file lookup a
   * production process needs (URL to path, directory index, traversal,
   * symlinks) so `server/penyaji.mjs` does not have to reimplement it.
   *
   * `astro build` therefore writes `dist/client/` (the site) and
   * `dist/server/` (the entrypoint `server/penyaji.mjs` imports) instead of
   * a flat `dist/`. Response headers — including the CSP block below — are
   * NOT set here; they live in `server/penyaji.mjs`.
   */
  adapter: node({ mode: "standalone" }),

  /**
   * Astro compresses HTML with JSX whitespace rules by default. Kept
   * explicit rather than relied on as a default, matching the template this
   * app is modelled on.
   */
  compressHTML: true,

  build: {
    /**
     * Never inline a stylesheet into a `<style>` tag.
     *
     * Astro's default (`'auto'`) inlines any stylesheet under ~4 kB. That is
     * a size-dependent behaviour, and it decides whether this site can be
     * served behind a strict CSP: `style-src 'self'` (see
     * `server/penyaji.mjs`) without `'unsafe-inline'` blocks an inline
     * `<style>` exactly as it blocks a `style=""` attribute, and the page
     * loses its layout with nothing failing in the build. `"never"` makes
     * every stylesheet — including `src/styles/global.css` and any
     * component-scoped style — an external file the CSP already allows via
     * `'self'`, by construction rather than by luck.
     */
    inlineStylesheets: "never",

    /**
     * `"file"` writes `dist/client/product/{slug}.html` instead of the
     * default `"directory"` format's `dist/client/product/{slug}/index.html`
     * — so the file this build emits and the URL `trailingSlash: "never"`
     * above serves are byte-identical, with no directory-index rewrite and
     * no 301 between what is indexed and what is served.
     */
    format: "file"
  },

  /**
   * Never inline a bundled script or a small image/font as a `data:` URI
   * either.
   *
   * `build.inlineStylesheets: 'never'` above only covers CSS. Astro applies
   * the SAME size-dependent trick to hoisted `<script>` chunks and to small
   * assets referenced from CSS/HTML: anything under Vite's
   * `assetsInlineLimit` (4 kB by default) gets written straight into the
   * page. `script-src 'self'` blocks an inlined script exactly as
   * `style-src 'self'` blocks an inlined stylesheet, and a `data:` URI is
   * exactly what `img-src 'self'` / `font-src 'self'` refuse — silently, on
   * whichever asset happens to be small enough on a given day. Zero removes
   * the size threshold entirely: every script, image, and font this build
   * emits is always a same-origin file.
   */
  vite: {
    build: {
      assetsInlineLimit: 0
    }
  }
});
