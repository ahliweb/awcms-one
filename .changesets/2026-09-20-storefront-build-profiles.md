---
bump: minor
type: structure
impact: public
---

# Storefront build profiles: `SITE_PROFILE` = `toko` | `berita` | `landing` (issue #137)

`apps/storefront` now builds one of three sites from the same tree, decided at build time by
`SITE_PROFILE` ([ADR-0018](../docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md)
D2/D3/D7) — the mechanism that lets this repository be a template a derived deployment can
start from without a second codebase. `toko` (the default when unset) is BjekMart's own
commerce + news site, byte-for-byte what the app built before; `berita` is a news portal only;
`landing` is a company-profile site (home, static pages, contact). An unknown value fails the
build naming the variable.

- **Page groups.** `apps/storefront/src/pages/**` now holds only the `shared` group (ten files
  every profile serves). The other 42 page files moved (`git mv`, history kept) to
  `apps/storefront/src/profil/<group>/pages/**` — 23 under `toko`, 19 under `berita` — with the
  same relative paths, per the profile matrix in `docs/template.md` (including its three
  code-decided edge cases: `mitra/[slug]` is `berita`, the root `feed.xml` is `toko`'s product
  feed, `index/wilayah-*` is `toko`'s checkout address cascade). A new Astro integration,
  `apps/storefront/integrations/profil.mjs`, `injectRoute`s every file of every ACTIVE group in
  `astro:config:setup` with project-root-relative entrypoints; an inactive group is never walked,
  so its pages, data fetches and artifacts never reach `dist/`. `apps/storefront/src/pages/index.astro` stays the
  one `/` route and imports `@profil/beranda`, an alias the integration points at the profile's
  own `src/profil/<profile>/Beranda.astro`.
- **One source of truth.** `apps/storefront/src/config/profil.ts` reads `SITE_PROFILE` and
  derives, from `routes.ts`'s new `ROUTE_GROUPS` annotation (every `ROUTES` key carries its
  group), the nav set, search surface, footer links, sitemap sources, feeds, `robots.txt` rules and
  CSP needs per profile. `Header`/`Footer`/`BaseLayout`, `robots.txt.ts`,
  `sitemap-sources.ts`/`sitemap-katalog.ts`, `csp.json.ts` and the server's rule-based legacy
  news redirects (now applied only when the build has a `berita.html`) all read it; nothing
  hardcodes a group twice. `PRIMARY_NAV`/`FOOTER_PAGE_LINKS` moved from `routes.ts` to
  `profil.ts`; `ROUTES` gains `newsletter`, `newsletterConfirm`, `newsletterUnsubscribe`,
  `orderTracking`.
- **CSP correction to the ADR matrix.** `connect-src` carries `PUBLIC_AWCMS_ORIGIN` on every
  profile (the visitor beacon posts there from every page), not only `toko`; what varies is which
  content the `img-src`/`frame-src` derivation reads.
- **Tests.** `profil-konfig` (pure config), `profil-integrasi` (the integration's pure half; the
  tree must match `docs/template.md`'s matrix row for row), `profil-routes` (no built page links
  outside the active profile, every internal link resolves), `profil-build-smoke` (every profile
  built against the stub CMS: excluded routes absent from `dist/` and `sitemap-*.xml`, robots/
  feeds/CSP per profile). Existing build-smoke tests pin `SITE_PROFILE: "toko"`; the
  no-`prerender = false` and no-`/news/**` guards now walk `src/profil/**` too.
- **CI.** The storefront `Check` job is a 3-leg matrix over `profile: [toko, berita, landing]`
  (`fail-fast: false`, shared install cache): each leg type-checks and builds/smoke-tests its
  profile; the root `bun test` and audits run once on the `toko` leg. `STUB_START_DEADLINE_MS`
  unchanged.
- **Docs.** `docs/routing.md`, `docs/seo.md`, `docs/pengujian.md`, `docs/arsitektur.md` (+ `.id.md`
  mirrors), `apps/storefront/README.md` and `.env.example` describe the profile mechanism, the
  `injectRoute` wiring and the CI matrix; page paths named in docs follow the moved files.

Operators of the BjekMart deployment need to do nothing: with `SITE_PROFILE` unset the build is
unchanged.
