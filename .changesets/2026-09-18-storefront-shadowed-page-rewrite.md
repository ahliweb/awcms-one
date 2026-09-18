---
bump: patch
type: fix
impact: public
---

# `/berita`, `/video` and every `/rubrik/{slug}` answered 404 on the served site

Issue #75. `apps/storefront` builds with `build.format: "file"` and
`trailingSlash: "never"`, so a landing page that also has children is
emitted as both a file and a directory — `dist/client/berita.html` beside
`dist/client/berita/`. `@astrojs/node`'s static handler (v11.1.5,
`serve-static.js`) checks for a directory before it asks `send` for a
file: a directory-shaped request with no trailing slash is rewritten to
`{path}/index.html`, which this build never writes, so `send`'s `.html`
fallback never runs and the request falls through to SSR — a 404 for a
page whose file exists, with every build gate green. The three news
landing surfaces (`/berita`, `/video`, and — one level down, not named in
the issue but found the same way — every `/rubrik/{slug}`) were the
affected pages; their children were never broken.

- `apps/storefront/server/penyaji.mjs` now walks `dist/client/` once at
  startup for every page shadowed by a same-named directory
  (`discoverShadowedHtmlPaths`) and, as the last step before the adapter —
  `/healthz`, `/products`, and both legacy-redirect layers keep precedence
  — rewrites `req.url` for exactly those paths to `{path}.html`
  (`shadowedHtmlUrl`). An internal rewrite, not a redirect: the reader's
  URL is unchanged, `/berita/` still 301s to `/berita` exactly as before,
  and the adapter's own `send` still serves the file (traversal,
  conditional GET, content type) — nothing new reads or streams a page.
- Why not `build.format: "directory"`: it would cure the shadow but move
  every page to `{slug}/index.html` and hand `trailingSlash: "never"` a
  directory-index rewrite on every request — the pairing
  `astro.config.mjs`'s `format` comment exists to avoid. Why not a
  per-request `stat`: which pages are shadowed is a fact about the build,
  fixed for the life of the process, and this file's rule is "no I/O at
  request time" for such facts.

Only felt while developing:

- `apps/storefront/tests/penyaji-bayangan-html.test.ts` covers the walk
  against a synthetic `dist/` tree (nested shadow included) and the
  `createServer` hook; `penyaji-bayangan-build-smoke.test.ts` builds
  against the stub and serves it through the real bundled
  `dist/server/penyaji.mjs` — the first test in the suite to do so — and
  fails with the fix removed.
- `docs/routing.md` (+ `.id.md`) gains a section on the rule.
