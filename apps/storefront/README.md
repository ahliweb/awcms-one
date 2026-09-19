# `apps/storefront` — the public BjekMart storefront

The public Astro storefront for `awcms-one` (borneojek-mart's re-platform):
catalog listing, product detail, site chrome (header/nav/search/footer),
CMS-driven identity and theme, static/contact pages, and the SEO/robots/
feed surface a public site needs. Fully static output, fetching
`apps/cms`'s API at BUILD time only — this document explains that rule in
full below, because it is the one invariant every file in this app is
written to protect.

## The static/runtime rule

This app builds once (`astro build`) into flat files under
`apps/storefront/dist/client/`, served afterwards by a plain Bun HTTP
process (`apps/storefront/server/penyaji.mjs`, bundled by `bun run build`
into that same `dist/` output tree). **The running container never talks to
`apps/cms` and holds no API credential at runtime.** Every page's
content — the catalog, the site's identity, its brand colors, its static
pages — is fetched once, while `astro build` runs, and baked into the
output.

This is a security property, not a performance one: a compromise of the
running storefront container reaches no customer data, because there is no
live credential in it to steal. The trade-off, stated plainly rather than
hidden: price, stock, identity, and every CMS-authored page are only as
fresh as the last build. That is the right trade for this stage of the
re-platform (see the root `AGENTS.md`/`README.md` for the wider "increment"
framing); once checkout exists, a runtime read becomes necessary, and that
must be a deliberate, separately argued change to
`apps/storefront/astro.config.mjs`'s `output: "static"` line — never a
drift.

Two files exist specifically to prove this rule holds without a live CMS:

- `apps/storefront/scripts/stub-awcms.mjs` — a local stand-in for
  `apps/cms`, answering every endpoint this app calls from the fixtures
  committed under `apps/storefront/tests/fixtures/awcms/`.
- `apps/storefront/tests/build-smoke.test.ts` — starts that stub, runs a
  real `astro build` against it, and asserts the pages below actually land
  in `dist/client/` with no inline `<script>`/`<style>` anywhere (the CSP
  invariant below).

## Page inventory

| Route | What it is | Data source |
| --- | --- | --- |
| `/` | Home: slider, popular categories, flash-sale strip, featured/recommended products, promo section, public vouchers, testimonials, recent news, promo popup (issue #27) | `GET /api/v1/commerce/products`, `/categories`, and the marketing read models |
| `/produk` | Catalog listing — grid + sidebar, client-side search/filter/sort/pagination over `/index/produk.json` | `GET /api/v1/commerce/products`, `/categories` |
| `/kategori/{slug}` | One page per category (its subtree's products, breadcrumb, `CollectionPage` JSON-LD) | same as above |
| `/flash-sale` | Active + scheduled flash sales, sale price vs. normal price, quota, live countdown | `GET /api/v1/commerce/flash-sales/active` |
| `/product/{slug}` | Product detail: image gallery, variant picker, tiered prices, service-form fields, size chart, promo banner, add-to-cart, share, related products, `Product`/`Offer`/`BreadcrumbList` JSON-LD | same as above |
| `/kontak` | Contact card + `mailto:`/WhatsApp links | `GET /api/v1/site-profile/composed` |
| `/cari` | Client-side product search over `/index/produk.json`; `noindex, follow` | `/index/produk.json` (build-time index) |
| `/halaman/{slug}` | CMS static/legal pages (privacy, TOS, shopping guide, and — once #28's news pages exist — Redaksi/Pedoman Media Siber/Disclaimer), rendered from Portable Text | `GET /api/v1/blog/pages/public[/​{slug}]` |
| `/404` | Not-found page with search + top nav links | none |
| `/robots.txt` | Allow-all + sitemap line + disallowed paths | deployment identity |
| `/sitemap-index.xml`, `/sitemap-{n}.xml` | Registry-driven sitemap, split at 5000 URLs/file | every registered source |
| `/feed.xml` | RSS of products (newest-first is approximated — see that route's own docblock for why the DTO has no timestamp to sort by) | `GET /api/v1/commerce/products` |
| `/manifest.webmanifest` | Web app manifest | site identity + theme + bundled favicon |
| `/theme-tokens.css` | Build-time-generated `--color-primary/secondary/accent` stylesheet | `GET /theming/{tenantCode}/tokens.css` |
| `/product-labels.css` | Build-time-generated per-product badge-color stylesheet | derived from the catalog fetch |
| `/berita`, `/berita/{slug}`, `/berita/feed.xml` | News front page, article detail (with the issue-#51 share row — see "Article share row" below), RSS 2.0 (issue #28); shared sidebar with a real "Terpopuler" (issue #49) | `GET /api/v1/blog/posts`/`terms`/`institutions` |
| `/rubrik/{slug}`, `/rubrik/{slug}/halaman/{n}`, `/rubrik/{slug}/feed.xml` | Hierarchical rubrik (category) archive + pagination + feed | same as above |
| `/daerah/{slug}` | Region archive, reached via an institution's `regionCode` | `GET /api/v1/blog/institutions`, `/api/v1/idn-regions/regions` |
| `/mitra/{slug}` | Institution ("Mitra") landing | `GET /api/v1/blog/institutions` |
| `/video`, `/video/{slug}` | Video-news index + detail (a post with a `videoNews` block) | `GET /api/v1/blog/posts` |
| `/tag/{slug}`, `/penulis/{slug}`, `/arsip/{yyyy}/{mm}` | Tag, author (byline-based), and monthly archives | `GET /api/v1/blog/posts`/`terms` |
| `/cari-berita` | Client-side search over `/index/berita.json` | `/index/berita.json` (build-time index) |
| `/index/produk.json` | The product search/listing index every client-side catalog surface reads | derived from the catalog fetch |
| `/csp.json` | The external origins this build references, read at startup by `apps/storefront/server/penyaji.mjs` to widen `img-src`/`connect-src`/`frame-src` — see "Content-Security-Policy" below | derived from every image URL the CMS sent, the resolved media origin, `PUBLIC_AWCMS_ORIGIN`, and (issue #47) the two YouTube origins when this build has a video post |
| `/index/berita.json`, `/index/pengalihan-legacy.json` | The search index, and the legacy-URL redirect map `apps/storefront/server/penyaji.mjs` reads at startup | `GET /api/v1/blog/posts`, `/api/v1/seo/redirects` |
| `/keranjang` | Cart — renders `localStorage`, re-quotes live, voucher/quantity/remove, "Lanjut ke checkout" (issue #30) | `POST <PUBLIC_AWCMS_ORIGIN>/api/v1/commerce/storefront/cart/quote` |
| `/checkout` | One-page, five-step checkout: contact → address → shipping → payment → review → place order | the same quote endpoint, plus `POST …/orders` |
| `/pesanan` | Order tracking by `?kode=`; phone from `sessionStorage`/a form, never the URL | `GET …/orders/{code}`, `POST …/orders/{code}/{payment-confirmations,cancel,payment-gateway/sessions}` |
| `/wishlist` | `localStorage`-only saved-products list; heart button on `ProductCard.astro` | none (client-side only) |
| `/index/wilayah-provinsi.json`, `/index/wilayah-kabupaten-{code}.json`, `/index/wilayah-kecamatan-{code}.json` | Checkout address region indexes, scoped to `PUBLIC_WILAYAH_PROVINSI` | `GET /api/v1/idn-regions/regions` |
| `/buletin` | Newsletter subscribe form (issue #50); not linked from anywhere yet — see "Newsletter" below | `POST <PUBLIC_AWCMS_ORIGIN>/api/v1/newsletter/subscribe` |
| `/newsletter/confirm`, `/newsletter/unsubscribe` | Double opt-in confirm/unsubscribe, token from `?token=`; `noindex, follow`; path is a fixed `apps/cms` contract, not this app's naming — see "Newsletter" below | `POST …/newsletter/{confirm,unsubscribe}` |

Every non-static-asset route above is prerendered — there is no
`prerender = false` anywhere in this app, and none should be added without
revisiting the static/runtime rule above first.

## Site chrome (issue #24)

`apps/storefront/src/layouts/BaseLayout.astro` renders a header/footer
component pair around every page: skip link first in the DOM, `<header>`/
`<nav aria-label>`/`<main id="konten">`/`<footer>` landmarks, and visible
`:focus-visible` styles throughout. The mobile nav is a native
`<details>`/`<summary>` disclosure — no JavaScript is involved in opening
or closing it; the only client-side `<script>` blocks in this app (the
header's cart-item count, and `/cari`'s query echo) are ordinary
Astro-bundled external modules, never inline — `script-src 'self'`
(`apps/storefront/server/penyaji.mjs`) does not allow any other kind.
Every route this issue's own chrome links to but does not build a page for
yet (`/produk`, `/kategori/{slug}`, `/flash-sale`, `/berita`, and the rest —
#27/#28/#30) is declared once, as a constant, so those issues never need to
touch the chrome files again.

Brand identity and colors come from `apps/cms` at build time:

- The site-identity client (`GET /api/v1/site-profile/composed`: store
  name, tagline, contact details, address, social links). A 403/404 (a
  build credential minted before the module existed, or an older `apps/cms`)
  degrades to BjekMart's own public defaults — a legitimate state, not an
  error. Anything else (5xx, timeout, unreachable) fails the build loudly,
  the same rule the product-catalog fetch already applies.
- The theme client (`GET /theming/{tenantCode}/tokens.css`, **not**
  `GET /api/v1/theming` as the original issue text names — that endpoint is
  session-gated and, verified against `apps/cms`'s own theming module, never
  actually exposes a published version's resolved token values, only
  descriptor defaults, an unpublished draft, and version metadata with no
  config). `tokens.css` is the public route `apps/cms` itself built for
  exactly this purpose — see that client's own docblock for the full
  reasoning, and for why `--color-secondary` has no CMS equivalent at all in
  the registered base theme and always renders BjekMart's own default.

Two known, deliberate deviations from the issue text, recorded here as the
brief this issue was implemented under asks:

1. **No `<img>` logo, and no CMS-uploaded favicon.** The composed identity
   endpoint returns a logo/favicon as media object ids, resolvable only
   through a media-object client this app does not have — increment 1
   (`AGENTS.md`) explicitly excludes product/media imagery from this
   re-platform slice, and issue #24's own file checklist names no such
   client for this app. The brand mark is the store NAME; a bundled default
   SVG icon serves as this deployment's favicon.
2. **`/kontak` has no maps iframe and no FAQ accordion.** Neither a
   maps-embed URL nor an FAQ list exists anywhere on the real site-profile
   schema (verified against `apps/cms`'s own module and its OpenAPI
   fragment) — the page renders every field the endpoint actually returns
   and omits the two that would otherwise have to be invented.

## News surface (issue #28)

`/berita`, `/rubrik/{slug}`, `/daerah/{slug}`, `/mitra/{slug}`, `/video`,
`/tag/{slug}`, `/penulis/{slug}`, `/arsip/{yyyy}/{mm}`, `/cari-berita` —
seputarborneo/beritasampit parity over the CMS's `blog_content` module.
`apps/storefront/src/lib/berita.ts` is the domain layer (mirrors
`apps/storefront/src/lib/catalog.ts`'s shape: one memoized, once-per-build
index; pages never see a term id, an institution id, or a keyset cursor);
`apps/storefront/src/lib/awcms/{blog,wilayah,lembaga,iklan}.ts` are the raw,
field-verified fetchers.

Deliberate deviations from the issue text, recorded here as the brief this
issue was implemented under asks:

1. **RESOLVED by issue #47** — see "Media (issue #47)" below for the hero
   `<img>`, real gallery/ad-creative images, and the click-to-load YouTube
   facade this deviation used to record as missing. Kept here, struck
   through in spirit rather than deleted, because issue #28's own reasoning
   (no media-object client existed yet) is still the correct explanation for
   why increment 2 shipped without them.
2. **No `article:published_time` Open Graph tag, no `rel=prev/next`, no
   `noindex` beyond page 1.** `BaseLayout.astro` (issue #24, outside this
   issue's file ownership) has no mechanism for a page to add extra
   `<meta>`/`<link>` tags. The same publish/update timestamps are present,
   machine-readable, in every article's `NewsArticle` JSON-LD.
3. **RESOLVED by issue #49** — see "News sidebar and homepage ad slots
   (issue #49)" below: "Terpopuler" is now ranked from `visitor_analytics`'s
   own `GET /api/v1/analytics/pages` and degrades to "latest" only when that
   module answers nothing. Issue #28's original reason (no such endpoint was
   in its verified-safe read scope) is kept here as the honest explanation
   of why increment 2 shipped it as "latest".
4. **No footer ad slot.** The verified `AD_PLACEMENT_KEYS`
   (`apps/storefront/src/lib/awcms/blog.ts`) has header/in-article/sidebar
   slots and no footer one at all.
5. **A region's URL slug is DERIVED from its name**
   (`apps/storefront/src/lib/berita.ts`'s `slugifyName`) —
   `idn_admin_regions` issues a `code`, never a slug. An
   institution's own slug, by contrast, passes through from the CMS
   unchanged.
6. **"Internal tag links" needed no renderer change.** Verified against
   `apps/cms`'s `internal-tag-linking.ts`: awcms's own auto-linking is a
   render-time HTML transform on the CMS's own themed pages, never an
   authored Portable Text node — a genuine internal link is already carried
   by the ordinary `link` annotation issue #24 built, and every article
   additionally renders an explicit tag list.
7. **No "transcript link" for a video post.** The verified `videoNews`
   schema (`provider`/`videoId`/`title`/`caption`/`thumbnailMediaObjectId`/
   `durationSeconds`/`sourceLabel`) has no transcript field of any kind —
   there is nothing for this app to link to without inventing one.

## Media (issue #47)

`apps/storefront/src/lib/awcms/media.ts` is this app's `media_library` read
client — batch-resolving a media object id to `{ id, publicUrl, alt, width,
height, creditLine, sourceName, copyrightStatus }` via `GET /api/v1/media/
objects?ids=` (chunked at 100 ids per call, verified against that route's
own `MAX_IDS`), and reading `GET /api/v1/media/public-origin` for the media
host `apps/storefront/src/pages/csp.json.ts` widens `img-src` with. The build credential
needs `media_library.media.read` for both — added to the seed's storefront
token permission set (`tools/seed-borneojek-mart.ts`'s
`MACHINE_CREDENTIAL_PERMISSION_KEYS`). A non-uuid-shaped id (a pre-migration
or hand-authored row) is filtered out BEFORE it is ever sent: the route
400s the WHOLE request over one malformed id rather than reporting just
that one, so sending it unfiltered would abort resolution for every other
id sharing its chunk — it is treated exactly like an id the CMS itself
reported unresolved instead.

`apps/storefront/src/lib/berita.ts` collects every visible post's
`featuredMediaId` plus every gallery item's `mediaObjectId`
(`apps/storefront/src/lib/portable-text.ts`'s `collectGalleryMediaObjectIds`) up front, once
per build, and resolves them in one batched `resolveMedia` call — `image:
ResolvedMedia | null` on `PostSummary`/`PostDetail`, and `getResolvedMedia()`
for `ArtikelView.astro` to pass into `renderPortableText` so a post's own
gallery images resolve too. An unresolved id (unverified, deleted, or not
yet uploaded) is logged ONCE (`console.warn`) and renders as no image —
never a broken `<img>`.

What actually renders now:

- **`ArtikelCard.astro`** — a fixed-aspect-ratio thumbnail
  (`.card-thumb`/`.card-thumb-placeholder`, `apps/storefront/src/styles/berita.css`) from
  `post.image`, falling back to a video post's own YouTube poster
  (`post.video.thumbnail`, no media resolution needed — a fixed CDN
  convention derived from `videoId`) when it has no `featuredMediaId` of its
  own.
- **`ArtikelView.astro`'s hero block** — a `<figure>` after the byline row
  when `post.image` resolved, with a `<figcaption>` joining the media's
  `alt` text and its credit (`creditLine`/`sourceName` — `null` unless the
  CMS has verified the rights, per that DTO's own fail-closed rule).
- **`apps/storefront/src/lib/portable-text.ts`** — a `gallery` item with `mediaType: "image"`
  and a resolving `mediaObjectId` renders a real `<figure><img>`. A
  `videoNews` block renders one of TWO shapes, chosen per render call by
  `renderPortableText`'s `options.videoMode` (default `"link"`): the
  original issue-#28 real outbound watch link (no script, safe on every
  page — this is what `apps/storefront/src/pages/halaman/[slug].astro`'s
  static pages and the RSS feeds' `content:encoded` get, since neither can
  run a click handler), or, only when a page explicitly opts in with
  `videoMode: "facade"`, a click-to-load facade (a `<button>` showing the
  `i.ytimg.com/vi/{id}/hqdefault.jpg` poster, swapped for a real
  `youtube-nocookie.com/embed/{id}` `<iframe>` by
  `apps/storefront/src/scripts/video-facade.ts` on a real click, never
  before). `apps/storefront/src/pages/video/[slug].astro` — the only route
  a playable `videoNews` block can ever appear on, and the only page that
  mounts `video-facade.ts` — is the one caller that passes `"facade"`
  (through `ArtikelView.astro`'s own `videoMode` prop); every other caller
  gets the always-safe link. A `<noscript>` fallback in the facade shape
  links straight to the YouTube watch page.
- **`IklanSlot.astro`** — a real `<img>` for `mediaPublicUrl` (re-checked as
  a genuine `http(s)` URL), keeping the editorial-disclosure label.

**CSP**: `apps/storefront/src/pages/csp.json.ts` pushes every ACTUAL
resolved article/gallery image and ad creative's own `publicUrl`/
`mediaPublicUrl` into `img-src` — the same way a product's own images
already are — so a row on a different (e.g. pre-host-migration) origin than
the CURRENTLY CONFIGURED one still widens the policy correctly. The
configured media origin itself (`GET /api/v1/media/public-origin`) is
pushed too, in addition, covering a build with zero resolved images yet.
`https://i.ytimg.com` is added to `img-src` and
`https://www.youtube-nocookie.com` to `frame-src`, both only when this
build has at least one video post (`apps/storefront/src/lib/berita.ts`'s
`getVideo()`), matching this file's "derived from content" philosophy for
every origin it adds. `apps/storefront/server/penyaji.mjs`'s `buildCsp`/
`readCspOrigins` consume the artifact's `frameSrc` field the same way they
already do `imgSrc`/`connectSrc` — the served `Content-Security-Policy`
widens `frame-src` to exactly the facade's origin on a build with a video
post, and stays `frame-src 'none'` otherwise.

## News sidebar and homepage ad slots (issue #49)

`apps/storefront/src/components/berita/Sidebar.astro` is the ONE sidebar every
news page with a side column renders — `/berita`, `/berita/{slug}`,
`/video`, `/video/{slug}`, `/rubrik/**`, `/tag/{slug}`, `/penulis/{slug}`,
`/arsip/{yyyy}/{mm}`, `/cari-berita` — replacing the inline `<aside>` only
`/berita` used to have. Ported from seputarborneo's `include/sidebar.php`
and in its order: the tabbed **Terbaru / Mitra Borneo** list, `sidebar_top`,
**Terpopuler** (this app's own addition, below), the Mitra Borneo directory
box (the same 24-institution list the footer renders), `sidebar_middle`,
the newsletter box (`FormBuletin variant="sidebar"`, issue #50),
`sidebar_bottom`, then the tag cloud kept from issue #28 so `/tag/{slug}`
stays reachable from the front page. `/daerah/{slug}` and `/mitra/{slug}`
keep their full-width layout and have no sidebar.

- **The tabs are the real WAI-ARIA pattern, and both panels are in the
  HTML.** `role="tablist"`/`tab`/`tabpanel`, `aria-selected`, roving
  `tabindex`, Left/Right/Home/End keys; the Mitra Borneo panel ships
  server-rendered with `hidden`. Without JavaScript the Terbaru panel shows
  and the buttons are inert — seputarborneo's own no-JS behaviour — and the
  Mitra content stays reachable through the directory box's `/mitra/{slug}`
  links. The tab script is an ordinary Astro-bundled external module.
- **Every sidebar slot, and every homepage slot, is `IklanSlot.astro`** —
  nothing renders for a key with nothing booked (no empty box). The
  homepage's slots follow seputarborneo `index.php`'s order, mapped onto the
  CMS's verified keys: `below_headline` right after the headline block,
  `homepage_middle` after the first three rubrik sections, `homepage_bottom`
  after the remaining sections and BEFORE the video strip. `homepage_bottom`
  is also the key `FooterBerita.astro` (issue #48) reuses for its
  leaderboard, so on `/berita` that creative renders twice — issue #49's
  explicit mapping, recorded rather than hidden; a dedicated footer key is
  an upstream `blog_content` change.
- **"Terpopuler" is real.** `apps/storefront/src/lib/awcms/analitik.ts` reads
  `GET /api/v1/analytics/pages?range=7d` (`apps/cms/src/pages/api/v1/analytics/pages.ts`,
  permission `visitor_analytics.dashboard.read` — added by name to the
  seed's storefront token permission set, `tools/seed-borneojek-mart.ts`'s
  `MACHINE_CREDENTIAL_PERMISSION_KEYS`; **that changes the credential's
  scope, so the seed's scope-reconcile (issue #57) revokes and reissues the
  live storefront credential on its next run against an already-seeded
  tenant — a build still holding the previous `AWCMS_API_TOKEN` gets `401`
  from then on and must be given the newly printed token**), folds every `path_sanitized`
  variant of one post (`/berita/x` and `/berita/x?utm_source=…` are separate
  rows in that route's answer — `sanitizePath` strips only SENSITIVE query
  parameters) into one count per slug, ranks every post by it and tops the
  list up with the newest posts. The route returns the tenant-wide top 50
  paths with no limit parameter — store pages and indexes included — so a
  post ranked 51st or lower overall is invisible to the ranking and loses
  its place to a zero-view post the top-up reaches first. A `403`/`404` (module off — it is off by
  default, see `docs/deployment.md`'s "The two switches" — credential
  minted before the permission existed, older CMS) or an empty answer
  degrades, SILENTLY, to exactly the "latest" list issue #28 rendered: the
  issue asks for that fallback to be stated in code (that file's own
  header), never as a caveat in the UI. Anything else (5xx, timeout) still
  fails the build, the rule every fetch in `src/lib/awcms/` follows.
- **The newsletter form renders twice on a sidebar page — and both work.**
  `BeritaLayout.astro` mounts `FormBuletin variant="footer"` in the footer's
  box of every news page and `apps/storefront/src/scripts/buletin.ts` once;
  `Sidebar.astro` renders its own `variant="sidebar"` copy, as seputarborneo
  does (`sidebar.php` and `layout_footer.php` each carry one). That needed a
  fix in `buletin.ts`: its `wireBuletinForm` used `document.querySelector`
  and wired the FIRST `[data-buletin-form]` only, so the footer form (second
  in DOM order) would have submitted nowhere — a bare `<form>` with no
  `action` GETs the reader's e-mail onto the page's own URL.
  `wireBuletinForms(root)` now wires every form, each with its own closure
  (own in-flight flag, status region, button — no shared mutable state), and
  takes its root as a parameter so `apps/storefront/tests/buletin-forms.test.ts`
  can drive two fake forms under plain `bun test` (this workspace has no DOM
  shim). `FormBuletin`'s `idPrefix` keeps the two forms' `id`/`for` pairs
  distinct (`buletin-sidebar-*`/`buletin-footer-*`).
- **Stub + fixture:** `GET /api/v1/analytics/pages` answers
  `apps/storefront/tests/fixtures/awcms/analytics-pages.json`, with the real
  route's `range` validation in front of it; `ad-placements-active.json`
  now books every sidebar and homepage slot so the build proves each one
  renders, and leaves `article_top`/`article_bottom` empty so it also proves
  "no empty box". `apps/storefront/tests/sidebar-build-smoke.test.ts`
  asserts all of the above on the built HTML, including that the sidebar is
  byte-identical across the article/video/rubrik/tag/search pages.

## Article share row (issue #51)

`apps/storefront/src/components/berita/BarisBagikan.astro` replaces the
WhatsApp+Facebook-only block issue #28 shipped at the foot of every
`ArtikelView.astro` page (`/berita/{slug}` and `/video/{slug}` alike) with
seputarborneo's `sb_bagikan()` row — seven controls of THREE different
kinds, and the distinction is the whole design:

| Control | Kind | Element | `rel` | Shown |
| --- | --- | --- | --- | --- |
| Facebook, X, WhatsApp, Threads | share — a real web intent URL | `<a target="_blank">` | `noopener nofollow` | always |
| Instagram | share — Web Share API, clipboard fallback | `<button>` | — | always (revealed by script) |
| TikTok, YouTube | FOLLOW this site's own account | `<a target="_blank">` | `noopener me` | only when `identity.socialLinks` has one |

- **`apps/storefront/src/lib/bagikan.ts`** (build-time, pure) builds the
  four intent URLs (`facebook.com/sharer/sharer.php?u=`,
  `twitter.com/intent/tweet?url=&text=`, `wa.me/?text=`,
  `threads.net/intent/post?text=`; title and URL each
  `encodeURIComponent`-ed) and resolves the follow links from
  `identity.socialLinks` through issue #48's `apps/storefront/src/lib/ikon-sosial.ts` —
  the SAME hostname detection and `http(s)`-only scheme filter the utility
  bar's icon row uses, not a second copy. A `javascript:`/`data:`/
  schemeless URL never reaches an `href`; a URL labelled "TikTok" by an
  editor but pointing elsewhere is not a TikTok link. WhatsApp's glyph is
  the one SVG path this row adds (the utility bar never renders a
  messenger); every other icon is `ikon-sosial.ts`'s.
- **`apps/storefront/src/scripts/bagikan.ts`** (browser) drives the
  Instagram button: `navigator.share({ title, url })` first (the OS share
  sheet — a dismissed sheet is silent), else
  `navigator.clipboard.writeText(url)` plus a visible "Tautan disalin…"
  status in a `role="status"`/`aria-live="polite"` region that ships EMPTY
  in the static HTML (a live region created and filled in the same tick is
  skipped by some screen readers). A denied/unavailable clipboard ends in a
  visible failure message, never a silent no-op and never `prompt()`.
  Instagram has no web share URL at all, so the button is not a link, does
  not read `identity.socialLinks`, and ships `hidden` until this script has
  attached its handler — a control that does nothing without JavaScript is
  not offered to a reader who has none. The four share links and the
  follow links need no script.
- Every control has a full accessible name naming the verb ("Bagikan ke
  Facebook" vs "Ikuti kami di TikTok"), a 44×44 target
  (`apps/storefront/src/styles/bagikan.css`, imported by the component
  alone — no shared stylesheet is edited), and the row wraps at 360px.
- No third-party script: no Facebook SDK, no Twitter widgets, no embed.js.
  `apps/storefront/tests/bagikan.test.ts` greps every file under `src/` for
  their hosts; `apps/storefront/tests/bagikan-build-smoke.test.ts` builds
  against the stub and asserts the rendered row on a real article page and
  the video page — with the stub's fixture (Instagram + a `javascript:`
  link, no TikTok/YouTube), the follow links are correctly absent.

## Ad popup (issue #53)

A reader who clicks an ad creative on any news-surface page opens one
shared native `<dialog id="iklan-popup">` — the creative at its natural size
(capped at 90vw/90vh), the advertiser's name, the disclosure label, and a
"Buka iklan" CTA to the real destination (`rel="sponsored noopener"`,
`target="_blank"`). A creative with no destination shows "Iklan ini belum
memiliki tautan tujuan" and no CTA. Closes on the ✕, the backdrop, and
`Escape`; focus returns to the trigger; `body` scroll is locked while open.
Ported from seputarborneo's `js/main.js` `initAdPopup()`, minus jQuery and
minus the hand-rolled modal.

- **`apps/storefront/src/scripts/iklan-popup.ts`**, mounted ONCE from
  `apps/storefront/src/layouts/BeritaLayout.astro` (an external module,
  `script-src 'self'`), attaches a single document-level delegated `click`
  listener for `.ad-slot [data-iklan-popup]` — so every slot, on every page
  that renders through the news layout (article pages, `/berita`, and any
  aside issue #49's `Sidebar.astro` places one in), is covered without the
  page knowing the module exists. The dialog is BUILT on the first click and
  reused; nothing is rendered server-side for it. Styles:
  `apps/storefront/src/styles/iklan-popup.css`, imported by the same layout.
- **`IklanSlot.astro` marks the trigger with three attributes**:
  `data-iklan-popup`, `data-iklan-nama` (advertiser name), `data-iklan-label`
  (the content-class disclosure label — "Advertorial"/"Konten Bersponsor" —
  or, for `standard`, the slot's own "Iklan"). On a LINKED creative they sit
  on the existing anchor and nothing else changes. An UNLINKED creative
  (`linkUrl: null`) had no anchor to decorate, and the "no destination"
  popup state is an acceptance criterion of #53, so that one branch now
  wraps the image in a `<button type="button" class="ad-slot-trigger">` — a
  real keyboard-operable control, never an `<img tabindex>`. A text-only ad
  (no resolvable image) is never a trigger.
- **Progressive enhancement, three cases.** No JavaScript: the anchor
  navigates normally and the button is inert (as non-interactive as the bare
  `<img>` it replaced). No `<dialog>.showModal` support: the module returns
  before attaching anything. A modified click (Ctrl/Cmd/Shift/Alt, middle
  button) on a linked creative is left to the browser, so "open in a new
  tab" keeps working.
- **The CTA's href is re-validated** (`safeHttpUrl`): anything that is not
  an absolute `http(s)` URL is treated as no destination — this module
  never trusts a CMS string into a new `href` unchecked, the same rule
  `IklanSlot.astro` already applies to `mediaPublicUrl`. Every string the
  dialog shows is set through `textContent`; no ad data passes through
  `innerHTML`.
- **Tests**: `apps/storefront/tests/e2e/iklan-popup.e2e.ts` (Playwright, via
  the existing `bun run test:e2e` harness — open, `Escape`/✕/backdrop close,
  focus restored, CTA href equals the ad link, missing link shows the
  message, one dialog reused, modifier-click not intercepted) and
  `apps/storefront/tests/iklan-popup.test.ts` (the DOM-free helpers plus
  source-level guards for the one mount and the trigger attributes). The
  e2e spec runs against an ARTICLE page rather than `/berita` — see its
  docblock: the preview server currently answers `/berita` (and `/video`)
  with the 404 page, because `build.format: "file"` emits `berita.html`
  beside the `berita/` directory and `@astrojs/node`'s static handler
  rewrites a directory-shaped URL to `berita/index.html` before `send`'s
  `.html` fallback runs. A pre-existing serving bug, outside this issue's
  files, tracked for follow-up.

## Read-aloud player (issue #52)

`apps/storefront/src/components/berita/PemutarDengar.astro` puts a "Dengarkan berita ini"
card between the article header and the body on every `/berita/{slug}` page
— and on no `/video/{slug}` page, where the reader is already watching the
thing the page is about (`ArtikelView.astro` renders both families, so the
guard is one `!post.isVideo` in that file).

**The engine is the reader's own device.** `window.speechSynthesis` with
`lang = "id-ID"`: no API key, no audio file built or stored anywhere, no
request leaving the page. The article text reaches the browser's own speech
engine and nothing else. That is what makes the feature affordable here at
all, and it is why this is not an `<audio src>` player.

**It is progressive enhancement in the strict sense.** The card is always
rendered with `hidden`; `apps/storefront/src/scripts/dengar.ts` removes that attribute only
when `speechSynthesis` exists *and* the device actually reports an
Indonesian voice. A browser without the API, or a reader with JavaScript
off, gets no control at all rather than one that looks clickable and does
nothing — asserted against the built HTML in
`apps/storefront/tests/dengar-build-smoke.test.ts`.

Three details worth knowing before editing any of the three files:

- **Speech is split per sentence, the highlight is per block.** Chrome
  silently truncates an utterance after roughly fifteen seconds, so a long
  paragraph must be spoken as several utterances; the read-along highlight
  nevertheless follows the whole block, because legacy article bodies have
  sentences that run through `<strong>`/`<br>` boundaries and a per-sentence
  highlight breaks on them.
- **The highlight never changes the box.** `outline` + `box-shadow` only
  (`apps/storefront/src/styles/dengar.css`) — a background or border change on a paragraph
  mid-read shifts every paragraph below it while the reader is listening.
- **`data-dengar-*` is a three-sided contract** between the component, the
  stylesheet and the script. The full attribute list is in
  `apps/storefront/src/components/berita/PemutarDengar.astro`'s docblock; renaming one without the other two
  breaks the player silently.

What is skipped inside the body: `figure`, `figcaption`, `script`, `style`,
`iframe`, `noscript` and `.ad-slot` — a photo credit or an advertiser's name
read out mid-article is worse than silence. Rate (0.75×–1.5×) and the chosen
voice persist in `localStorage`, every access wrapped in `try`/`catch` so a
private window degrades to "does not remember", never to a broken player.

## Institution emblem — "Logo Instansi" (issue #59)

`apps/storefront/src/components/berita/LogoInstansi.astro` renders a
regency's (or council's) emblem as a float beside an article's opening
paragraph, and `/mitra/{slug}` shows the same emblem on that institution's
own page.

**The emblem belongs to the INSTITUTION, not to the post.** seputarborneo
attaches it per article (a `logo` table plus `berita_red.id_logo` and a
picker in every news form); here every such article is already filed under
that institution, so one upload serves all of them and changing it updates
all of them — the property upstream's own "satu logo dipakai berulang" rule
was after, with one source of truth instead of a per-post picker that can
disagree with the channel the article is filed under. The field itself is
`logo_media_id`/`logo_alt` on `awcms_blog_institutions`, added by upstream
awcms#806 and received here through the `apps/cms` subtree pull.

- It resolves through the same batched `resolveMedia` call as post images
  (`apps/storefront/src/lib/awcms/media.ts`); the handful of ids shared by
  thousands of posts are de-duplicated into one chunked request.
- An article with no institution, an institution with no emblem, or a stale
  media id renders **nothing** — no empty frame, no broken `<img>`.
- `alt` is the CMS-authored `logoAlt` when there is one; with none the
  emblem is decorative (`alt=""`), because the institution's name is
  already beside it in the byline and in the link's accessible name.
- No background, border or padding: an emblem is nearly always a
  transparent PNG/SVG, and upstream's 2.3.2 release removed exactly those
  decorations for that reason.

`RawInstitution.logoMediaId`/`logoAlt` are optional on purpose — a build
pointed at an `apps/cms` older than that subtree pull renders no emblem
rather than crashing on a missing property
(`apps/storefront/tests/logo-instansi.test.ts` covers that case, and
`apps/storefront/tests/logo-instansi-build-smoke.test.ts` proves both the
present and the absent case on real built pages).

## Catalog surface (issue #27)

The full shopper-facing catalog: the home page, `/produk`, `/kategori/{slug}`,
`/flash-sale`, `/cari`, and a product detail page that renders everything the
product model carries — images, variants, tiered prices, service-form fields,
size chart, promo banner, flash-sale price.

Three things about it are load-bearing and easy to undo by accident:

1. **No price arithmetic happens here.** `price`, `finalPrice`, a variant's
   price, a flash-sale price and every tier price are displayed exactly as
   `apps/cms` computed them (ADR-0003); `apps/storefront/src/lib/harga.ts` is the only file
   that converts a price string to a number, and only to format it. A unit
   test greps `src/` for any other `Number(`/`parseFloat(` on a price-shaped
   field.
2. **The cart is a browser-local contract, not a server one.**
   `apps/storefront/src/lib/keranjang-kontrak.ts` defines it — `localStorage` key
   `awcms-one:keranjang:v1`, shape `{id, lines, updatedAt}`, a
   `keranjang:berubah` event dispatched on every write, which the header's
   count listens for. Issue #30's checkout reads exactly this shape; the
   `id` is also the idempotency key an order is created with.
3. **Every client-side script is an external module** under `apps/storefront/src/scripts/`,
   because `script-src 'self'` has no `'unsafe-inline'` and never will.

### Content-Security-Policy: the one exemption, and why it is derived

Product photos are the first thing this storefront references off its own
origin. `images[].publicUrl` comes from `apps/cms`'s `media_library` and
points at that deployment's public media origin (R2, a CDN, or the CMS host
— a deployment's choice, not this app's), so a bare `img-src 'self'` blocks
every one of them **silently**: correct HTML, green build, broken page.

So the policy is widened, by exactly the origins this build actually
references and no others:

- `apps/storefront/src/pages/csp.json.ts` collects every image URL from the same memoized
  fetches the pages rendered from, and writes `dist/client/csp.json`
  (`{version, imgSrc, connectSrc, frameSrc}` — `frameSrc` added by issue #47
  for the click-to-load YouTube facade, see "Media (issue #47)" above) via
  `apps/storefront/src/lib/csp-asal-media.ts`.
- `apps/storefront/server/penyaji.mjs` reads that file **once at startup**
  (`readCspOrigins`), re-validates every origin (`sanitizeOrigins` — an
  absolute `http(s)` origin with no path, credential, wildcard or separator
  character, or it is dropped), and composes the served policy with
  `buildCsp`.
- A missing, malformed or unknown-version artifact degrades to the baseline
  `img-src 'self'` — images stop rendering, which is visible and fixed by a
  rebuild, rather than a policy silently wider than any build asked for.

It is DERIVED rather than configured (`PUBLIC_MEDIA_ORIGIN`-style) because a
configured origin is one more value to keep in step with the CMS's own
configuration, and a wrong one fails in exactly the silent way this
mechanism exists to prevent. The trade: a catalog with no images yet emits
no origins, so the first product photo needs a rebuild before it renders —
the same rebuild that page already needs (ADR-0002).

### `BaseLayout.astro`'s `head` slot

`<slot name="head" />` is the single extension point in `<head>`, last in
document order so a page can override what the layout already declared
without displacing the charset declaration. `/cari` uses it for
`<meta name="robots" content="noindex, follow">` — `robots.txt`'s
`Disallow: /cari` asks a crawler not to fetch the page, the meta tag tells
one that already has it not to index it, and the two are not
interchangeable. **Never put a `<script>` in this slot**: that would escape
the `script-src 'self'` guarantee the whole app rests on.

## Cart, checkout, order tracking, wishlist (issue #30)

This is the one place ADR-0002's "static build, no runtime CMS credential"
rule meets a real WRITE — the architecture revision tracked at
https://github.com/ahliweb/awcms-one/issues/31 (to be recorded there as an
ADR). The chosen answer is not a runtime route (`prerender = false` stays
absent everywhere — see `apps/storefront/tests/checkout-guard-no-prerender.test.ts`)
but the anonymous, cross-origin commerce endpoint pattern awcms already uses
elsewhere (its own newsletter form, site search, comments): the **browser**
calls `<PUBLIC_AWCMS_ORIGIN>/api/v1/commerce/storefront/*` directly. The CMS
resolves the tenant from the request `Origin` header and answers with CORS —
no cookie, no bearer token, ever. The exact request/response shapes are
fixed by a contract document shared with the CMS-side issue (#29) building
the same routes in parallel; `apps/storefront/src/lib/toko-klien.ts` is this
app's one implementation of the BROWSER half of it.

- **`PUBLIC_AWCMS_ORIGIN`** (required, build-time, deliberately `PUBLIC_`) —
  the CMS origin cart/checkout/tracking POST to. Validated by
  `apps/storefront/src/lib/awcms/toko-origin.ts`, called from
  `apps/storefront/src/pages/csp.json.ts` (a page every build
  unconditionally prerenders) so an unset or malformed value **fails the
  build**, naming the variable — a checkout page that silently posts nowhere
  is the failure this exists to prevent. The same value becomes this
  build's `connect-src` CSP entry, via the identical `csp-asal-media.ts`
  artifact mechanism issue #27 built for `img-src` — never a second
  mechanism.
- **`PUBLIC_WILAYAH_PROVINSI`** (optional, default every Kalimantan
  province) — which provinces' administrative regions
  (`apps/storefront/src/lib/awcms/wilayah-checkout.ts`) get baked into the
  `/index/wilayah-*.json` files the checkout address step fetches
  client-side (same-origin, no CORS/CSP concern at all) — so a deployment
  never bakes in the ~90,000-village national dataset by default.
- **The cart contract stays issue #27's** (`keranjang-kontrak.ts`); this
  issue adds `clearCart()` (`keranjang-klien.ts`) — a FRESH cart id, not a
  cleared `lines` array on the same one, because `cart.id` doubles as the
  order's `idempotencyKey` and must never be reused after the order it
  named has already been placed.
- **The wishlist is a brand-new, parallel, `localStorage`-only contract**
  (`wishlist-kontrak.ts`/`wishlist-klien.ts`), the same pattern as the cart
  but with no server quote at all — a bookmark, not a purchase intent.
  `ProductCard.astro` gained an additive `[data-wishlist]` heart button;
  `apps/storefront/src/scripts/wishlist-tombol.ts` wires up every such
  button SITE-WIDE via event delegation, imported once from `Header.astro`
  (the same place the cart-count script already is) rather than from every
  page that happens to render a card.
- **Every page degrades**: a `<noscript>` block explains that JavaScript is
  required and offers a generic WhatsApp contact link; once JavaScript HAS
  run but a live quote/checkout call fails (CMS down, tenant unresolved), the
  same pages build a REAL cart-summary WhatsApp link instead
  (`apps/storefront/src/lib/wa-fallback.ts`) — pure and unit-tested with no
  DOM.
- **A phone number never appears in a URL.** `/pesanan?kode=` carries only
  the order code; the phone lives in `sessionStorage`
  (`apps/storefront/src/lib/pesanan-sesi.ts`'s `PESANAN_PHONE_KEY`), written
  once by `checkout.ts` on a successful order and read by `pesanan.ts`.
- **`/pesanan/{kode}` does not exist.** A per-code page cannot be
  prerendered (the order does not exist at build time, and enumerating every
  future order code is not a real option) — `/pesanan?kode={code}` is the
  actual URL shape, a documented, deliberate deviation from the issue's own
  `/pesanan/[kode]` naming.

### Browser-level tests (Playwright)

`apps/storefront/tests/e2e/checkout.e2e.ts` exercises add-to-cart → cart
quote renders totals → checkout submits an order → `/pesanan` shows it, plus
the neutral not-found state for a wrong phone — against a REAL built static
site (`bun run build`, stub-backed) served by `bun run serve`/preview and the
extended `apps/storefront/scripts/stub-awcms.mjs` state machine. Run it from
`apps/storefront`:

```bash
bun install   # once — @playwright/test is a devDependency of this workspace only
bun run test:e2e
```

This is a SEPARATE script (`test:e2e`), never part of `bun run build`/`bun
test`/the root suite: `bunfig.toml`'s root exclusion only ever kept
`apps/cms` out, and a browser dependency in the root `bun test` invocation
would make every contributor's `bun test` need Chromium installed to pass.
The spec file's own `*.e2e.ts` suffix (not `*.test.ts`) is what keeps it out
of `bun test`'s own file discovery, the same trap-avoidance the repo's
`playwright` skill documents for any project mixing a unit-test runner with
Playwright.

**Running it in CI later** (not wired into `.github/workflows/ci.yml` by
this change — that file is out of this issue's scope): a job would need (1)
`bunx playwright install chromium` (no `--with-deps` unless the runner image
already has the OS libraries, or is given root), (2) start
`apps/storefront/scripts/stub-awcms.mjs`, (3) a stub-backed `bun run build` with
`PUBLIC_AWCMS_ORIGIN` pointed at the stub's own origin, (4) `bun run serve`
(or `astro preview`) against that build, with `STUB_ALLOWED_ORIGIN` (the
stub's CORS allow-list) set to match whatever port step 4 actually listens
on, then (5) `bun run test:e2e` with `E2E_BASE_URL` pointed at step 4's
origin. Steps 2–4 are exactly what `apps/storefront/tests/checkout-build-smoke.test.ts`
already automates for the build-only assertions; the e2e job would be that
same shape with a real browser added on top.

## Customer accounts — sign-in, sign-up, and the account shell (issue #88, S1)

Part of the increment-4 accounts epic (#32); the API contract is https://github.com/ahliweb/awcms-one/issues/86 (ADR-0016 is that issue's own deliverable — not yet in this tree at the time this section was written). No env variable is added by this issue — it reuses `PUBLIC_AWCMS_ORIGIN` (above) and the same CSP/CORS story cart/checkout already established.

- **`apps/storefront/src/lib/akun-sesi.ts`** — the customer session store: `localStorage` key `awcms-one:akun:v1` = `{token, expiresAt, account}`. `bacaSesi()` returns `null` (and clears the key) once `expiresAt` has passed; `simpanSesi()`/`hapusSesi()` both dispatch `akun:berubah` on `window`. The DOM-free validate/parse logic lives in `apps/storefront/src/lib/akun-kontrak.ts`, mirroring `wishlist-kontrak.ts`'s own "pure kontrak + thin browser klien" split, so it is unit-tested with no DOM (`apps/storefront/tests/akun-kontrak.test.ts`).
- **`apps/storefront/src/lib/akun-klien.ts`** — one function per #86 endpoint S1 needs: `mintaKode`, `verifikasiKode` (anonymous), `ambilProfil`, `ubahProfil`, `keluar` (bearer, `Authorization: Bearer <token>` from `akun-sesi.ts`). The addresses/wishlist/orders/reviews endpoints #86 also documents were added by issue #90 (S2, see below); the affiliate endpoints remain S3's own scope. A `401 UNAUTHENTICATED` from any bearer call clears the local session before rethrowing.
- **`apps/storefront/src/lib/toko-permintaan.ts`** — the shared request/envelope plumbing (`kirimPermintaan`, `TokoApiError`), extracted out of `toko-klien.ts` so `akun-klien.ts` reuses it rather than duplicating it. `toko-klien.ts`'s own public exports and behaviour are unchanged by the split (it re-exports `TokoApiError`); `apps/storefront/tests/toko-klien.test.ts` passes unmodified.
- **Routes**: `ROUTES.login` (`/masuk`), `ROUTES.register` (`/daftar`), `ROUTES.account` (`/akun`) get real pages in this issue. `ROUTES.accountOrders`/`accountOrder(kode)`/`accountAddresses`/`accountReviews`/`accountAffiliate` are declared now (S2/S3 build the pages behind them) so `/akun`'s own navigation cards and `Header.astro` can link at a named constant rather than a hand-typed path. `ROUTES.wishlist` (already existing) is reused as-is for the wishlist card.
- **`Header.astro`** gained a `<a data-akun-tautan>` beside wishlist/cart, server-rendered as "Masuk" → `/masuk` (works with no JavaScript). `apps/storefront/src/scripts/akun-header.ts`, imported from the same `<script>` block that already mounts `keranjang-hitung.ts`/`wishlist-tombol.ts`, swaps its text to the account's first name and its `href` to `/akun` when `bacaSesi()` finds a session, re-checking on `akun:berubah` and the native `storage` event.
- **Pages**, all static (`output: "static"`, no `prerender = false`), one `<h1>` each, `noindex, follow`:
  - **`/masuk`** (`apps/storefront/src/pages/masuk.astro` + `apps/storefront/src/scripts/masuk.ts`) — e-mail → "Kirim kode" (`mintaKode({email, purpose:"login"})`) → a 6-digit code step (`inputmode="numeric"`, `autocomplete="one-time-code"`, focus moves to it, "Kirim ulang" disabled for 60 seconds) → `verifikasiKode` → `simpanSesi` → redirect to a validated same-origin `?kembali=` path or `/akun`. `404 ACCOUNT_NOT_FOUND` shows a link to `/daftar?email=` (pre-filled); `401 OTP_INVALID` shows "Kode salah atau kedaluwarsa"; `429 RATE_LIMITED` shows the `Retry-After` seconds.
  - **`/daftar`** (`daftar.astro` + `daftar.ts`, same directories) — name, phone (`type="tel"`), e-mail → `mintaKode({purpose:"register", name, phone, email})` → the same code step → verify. `409 PHONE_ALREADY_REGISTERED` shows a link to `/masuk`.
  - **`/akun`** (`apps/storefront/src/pages/akun/index.astro` + `apps/storefront/src/scripts/akun.ts`) — no session: a card linking to `/masuk`/`/daftar`. A session: a profile card (name, e-mail, phone, "Level {n}"), an inline "Ubah nama" form (`PATCH /me`), a "Keluar" button (`POST /logout`, clearing the local session unconditionally — even on a network error), and navigation cards for Pesanan/Alamat/Wishlist/Ulasan/Afiliasi. **Pesanan/Alamat/Ulasan link to real pages as of issue #90 (S2); Afiliasi still 404s until S3** — labelled plainly, no "coming soon" placeholder text.
  - Every page carries a `<noscript>` explaining JavaScript is required (with the store's WhatsApp link) and a JS-ran-but-CMS-unreachable WhatsApp fallback (`wa-fallback.ts`'s new `buildWhatsappAccountMessage`), an `aria-live="polite"` status region, and field errors via `[data-error-for]`, the same conventions `checkout.astro`/`checkout.ts` already established.
  - `apps/storefront/src/styles/akun.css` is a dedicated, feature-scoped stylesheet (imported by these three pages alongside `toko.css`) — tokens from `global.css`, 44px control targets, contrast checked the same way `apps/storefront/tests/warna.test.ts` already checks the default theme colors.
- **`robots.txt.ts`** disallows `/masuk`, `/daftar`, and `/akun` — the bare `/akun` prefix also covers every child route (`/akun/pesanan`, …) as S2/S3 add them, with no new line needed per child.
- **`apps/storefront/scripts/stub-awcms.mjs`** implements the `/account/*` state machine from a new fixture (`apps/storefront/tests/fixtures/awcms/customer-accounts.json`, seeding `budi@example.test` / `+6281234567890`): `otp/request` (always `202`, remembers `purpose`+registration data per e-mail), `otp/verify` (code is always `123456`; unknown e-mail on `login` → `404 ACCOUNT_NOT_FOUND`; a phone already bound to another account on `register` → `409 PHONE_ALREADY_REGISTERED`; anything else → `401 OTP_INVALID`), `GET`/`PATCH /account/me`, `POST /account/logout` (bearer-only, `401 UNAUTHENTICATED` otherwise), and answers the `OPTIONS` preflight with `authorization` in `Access-Control-Allow-Headers`.

## Addresses, orders, synced wishlist, and reviews (issue #90, S2 of #32)

Everything #86's contract left for S2: `/akun/alamat`, `/akun/pesanan`, `/akun/ulasan`, the account-synced wishlist, and the saved-address autofill on `/checkout`. No new env variable.

- **`apps/storefront/src/lib/akun-klien.ts`** grows one function per remaining #86 endpoint: `ambilAlamat`/`tambahAlamat`/`ubahAlamat`/`hapusAlamat`/`jadikanAlamatUtama` (addresses), `ambilWishlistAkun`/`simpanWishlistAkun`/`hapusWishlistAkunItem` (the account wishlist), `ambilPesananAkun` (keyset)/`ambilPesananAkunByKode` (orders), and `ambilUlasanAkun` (reviews) — every one bearer-only, wrapped in the same `denganPembersihanSesi` a `401 UNAUTHENTICATED` clears the local session through, exactly like S1's `ambilProfil`/`ubahProfil`/`keluar`. `kirimPermintaan` (`toko-permintaan.ts`) gained a `"PUT"` method (the wishlist's own union-merge verb).
- **`apps/storefront/src/lib/wilayah-region-select.ts`** — the province/city/district cascading-select wiring, EXTRACTED out of `checkout.ts`'s original inline code so `/akun/alamat`'s own form reuses the exact same module rather than a second copy (the task's own "do not duplicate region logic" rule). `wireCascadingRegionSelects` wires the three `<select>`s; `applyRegionSelection` programmatically fills and selects them for a saved address (checkout's autofill) or an address being edited.
- **`checkout.astro`/`checkout.ts`** — a "Pilih alamat tersimpan" `<select>` (`data-alamat-tersimpan`, wrapped in `data-alamat-tersimpan-wrap`), hidden until `bacaSesi()` confirms a session, fetched from `ambilAlamat()` and applied through `wilayah-region-select.ts`'s `applyRegionSelection`. `toko-klien.ts`'s `createOrder` gained an OPTIONAL second `bearerToken` argument — every existing anonymous caller is unaffected; `checkout.ts` passes `bacaSesi()?.token` so a signed-in shopper's order is bound to their account. `submitReview` (not yet wired to any UI — see below) gained the same optional-token pattern.
- **`/akun/alamat`** (`alamat.astro` + `akun-alamat.ts`) — list with an "Utama" (default) badge; add/edit form (label, recipient, phone, province/city/district via the shared region module, postal code, street, notes, "Jadikan alamat utama"); delete with a confirmation dialog; a max of 10 addresses (#86's own limit) enforced client-side with a clear inline message BEFORE the "Tambah Alamat" button is ever shown, not just as a `400` after submitting.
- **`/akun/pesanan`** (`pesanan.astro` + `akun-pesanan.ts`) — a keyset-paginated order list ("Muat lebih banyak"), each row linking to `ROUTES.accountOrder(kode)`; `?kode=` renders the order detail via `GET …/account/orders/{kode}` (owned, no phone prompt) reusing `apps/storefront/src/lib/pesanan-render.ts` — the DOM-rendering half of `/pesanan`'s own `pesanan.ts`, EXTRACTED so both pages render an `Order` identically. `/pesanan` itself is behaviourally unchanged (`pesanan.ts` now calls `createPesananRenderer` instead of declaring the render functions inline); its own tests pass unmodified. The account detail view omits the confirm-payment/cancel controls — #86 names no account-authenticated equivalent of those phone-gated CMS routes, a deliberate scope reduction recorded here rather than silently.
- **Wishlist sync** (`apps/storefront/src/lib/wishlist-sinkron.ts`, `wishlist-akun-sync.ts`) — `gabungkanWishlist` is a PURE function (union by `productId`, earliest `addedAt` wins, capped at 200 items, unit-tested with no DOM in `apps/storefront/tests/wishlist-sinkron.test.ts`). On `akun:berubah` with a new session, the local wishlist's product ids are `PUT` to `/account/wishlist`, and the local copy is replaced with `gabungkanWishlist(local, serverResponse)` — the server's response is authoritative for WHICH items exist; the merge keeps each item's true local `addedAt` rather than the "now" a fresh server-side row would otherwise carry. While signed in, `wishlist-tombol.ts` (every heart button, mounted site-wide from `Header.astro`) and `wishlist.ts` (the `/wishlist` listing) write through to the account on every add/remove (`PUT`/`DELETE`); logging out leaves the local copy untouched. A network failure degrades to local-only operation, reported through one shared, page-wide `aria-live="polite"` status region rather than a thrown error.
- **`/akun/ulasan`** (`ulasan.astro` + `akun-ulasan.ts`) — the account's own reviews: product name, rating as both `{n}/5` text and a star row (`aria-label="{n} dari 5 bintang"`, the glyphs themselves `aria-hidden`), and the Indonesian status label (Menunggu moderasi / Terbit / Ditolak).
- **`/akun` dashboard** — the Pesanan/Alamat/Ulasan/Wishlist navigation cards (already present from S1) now link to real pages instead of 404s. No item counts were added: a count would need an extra network request this page's own build-time data does not already carry (the dashboard fetches no session-scoped data at build time at all — a customer session only exists in the browser), so per this issue's own "skip counts that are not cheap" rule, none are shown.
- **A deliberate scope note on `produk-detail.ts`'s review submission.** The task brief asks for that script's review-submit call to send the Bearer token the same optional way `createOrder` does — but this tree's `produk-detail.ts` (verified before starting this work) has NO review-submission UI at all yet; `toko-klien.ts`'s `submitReview` is not called from anywhere in `src/`. The optional-token PATTERN is still added to `submitReview` itself (mirroring `createOrder` exactly) so the next issue that actually builds a review form only has to pass the token, not invent the plumbing.
- **`apps/storefront/scripts/stub-awcms.mjs`** — every account additionally carries `addresses`/`wishlist`/`reviews` arrays. `budi@example.test` is seeded with two addresses (one `isDefault`) and two orders built from the same product catalog every other stub order uses — one dated BEFORE `historyFrom` (must NOT appear in `GET /account/orders`, proving the SERVER enforces #86's D4 history window, not the client) and one after (must appear; both are exercised by `apps/storefront/tests/akun-klien.test.ts`/the stub itself). `PUT /account/wishlist` returns the merged list annotated with product summaries from `products.json`, skipping any id its own catalog does not know. `POST /orders` and `POST /reviews` (the pre-existing ANONYMOUS routes) now accept an OPTIONAL Bearer and bind the created record to that account when one is present and valid.

## Affiliate program — `?ref=` capture, checkout attribution, `/akun/afiliasi` (issue #93, S3 of #32)

The shopper-facing half of #86's own D5 (the CMS/staff side is issue #92, tracked separately): a fresh code + link + commission design, no legacy columns to match.

- **`apps/storefront/src/lib/afiliasi-kontrak.ts`** — unlike `akun-kontrak.ts`/`akun-sesi.ts`'s two-file split, this ONE file combines the pure shape validation AND the `localStorage` read/write: `localStorage` key `awcms-one:afiliasi:v1` = `{code, capturedAt}`; `validasiKodeAfiliasi` accepts exactly the contract's 8-character unambiguous-base32 shape (`A`–`Z` without `I`/`O`, digits `2`–`9`), lenient on case only (upper-cased before matching); `AFILIASI_TTL_MS` is 30 days, and `bacaKodeAfiliasi` drops (and removes from storage) an entry past that TTL. Every storage access is wrapped in try/catch, unit-tested with no DOM via a minimal `window` stand-in (`apps/storefront/tests/afiliasi-kontrak.test.ts`), the same pattern `apps/storefront/tests/akun-klien.test.ts` already established for `akun-sesi.ts`.
- **`apps/storefront/src/scripts/afiliasi-tangkap.ts`**, mounted from `BaseLayout.astro`'s existing script block — the SAME block as `analitik.ts`/`ga-init.ts` — on EVERY page, not one route: a `?ref=CODE` link can land a shopper anywhere on this site. On load: read `?ref=`; if it validates, `simpanKodeAfiliasi` (a newer valid code always replaces an older one — this function simply overwrites, so the most recent capture wins by construction) and `history.replaceState` to remove ONLY the `ref` parameter, leaving every other query string on the URL untouched. An invalid/absent `?ref=` is a silent no-op — no URL rewrite, no error.
- **`checkout.ts`** sends `affiliateCode: bacaKodeAfiliasi()?.code ?? null` with every order, re-read at submit time (same reasoning as its own `bacaSesi()` re-read: an expired capture must not attribute a sale). `toko-klien.ts`'s `CreateOrderRequest` gains the field additively — every other field is unchanged.
- **`apps/storefront/src/lib/awcms/pemasaran.ts`**'s `StoreSettings` gains an optional `affiliateProgramEnabled: boolean` — read from the public store-settings fetch at BUILD time, defaulting to `false` (never assumed `true`) when an awcms predating this feature omits it, the same pattern `payment.proofUpload` already established.
- **`/akun/afiliasi`** (`afiliasi.astro` + `akun-afiliasi.ts`) — when `affiliateProgramEnabled` is `false` at build time, the page renders a one-paragraph explanation and NO enrol/link/stats controls at all (a build-time decision, not re-checked client-side). Otherwise: signed out → a link to `/masuk`; signed in with `GET …/account/affiliate` answering `{affiliate: null}` → a "Gabung program afiliasi" button (`POST`, `409 AFFILIATE_PROGRAM_DISABLED` shown inline rather than left looking like it might still work); enrolled → the referral link (`SITE_URL/?ref={code}`, the CMS's own precomputed value, not re-derived client-side) in a read-only input with a copy button reusing `voucher-copy.ts`'s own clipboard-API-plus-silent-fallback shape, the commission rate, an Indonesian status label (Aktif/Ditangguhkan), stats (referred orders, pending/approved/paid amounts) formatted with `harga.ts`'s `formatPrice` — never computed client-side, these are the CMS's own numbers — and a keyset-paginated commissions list ("Muat lebih banyak") with order code, amount, an Indonesian status label per row (Menunggu/Disetujui/Dibayar/Dibatalkan), and date. `aria-live="polite"`, a `<noscript>` WhatsApp-fallback message, 44px controls (`akun.css`'s own existing rule already covers every `input`/`button` under `.akun-card`), one `<h1>`, `noindex, follow` (the existing bare `Disallow: /akun` in `robots.txt.ts` already covers this child route — verified, not a new line added).
- **`/akun` dashboard** — its "Afiliasi" card (declared since issue #88, `ROUTES.accountAffiliate`) now resolves to a real page instead of a 404; no change to `akun/index.astro` itself was needed.
- **`apps/storefront/src/lib/akun-klien.ts`** gains `ambilAfiliasi` (`GET …/account/affiliate`), `gabungAfiliasi` (`POST`, `201`), `ambilKomisiAfiliasi(cursor)` (`GET …/account/affiliate/commissions?cursor=`) — bearer-only, wrapped in the same `denganPembersihanSesi` every other function in that file already uses.
- **`apps/storefront/scripts/stub-awcms.mjs`** — every account additionally carries `affiliate`/`commissions`. `budi@example.test` is seeded ALREADY ENROLLED (a deterministic, contract-shaped code derived from the account) with three commissions, one per status (pending/approved/paid), so `/akun/afiliasi`'s enrolled view can be exercised with no manual "Gabung" click first; a freshly registered account starts unenrolled, so `POST …/account/affiliate` itself is exercised by enrolling that one. `POST /orders` records `body.affiliateCode` on the created order verbatim when present, per #86's own "the CMS ignores unknown/suspended codes" — this stub does not go further and simulate a commission being created when an order later reaches `completed`. `apps/storefront/tests/fixtures/awcms/store-settings-public.json` sets `affiliateProgramEnabled: true`.

## Real courier rates at checkout (issue #109, S1 of #33, contract: issue #106 D4)

The checkout shipping step's courier row stops being a permanent "segera" placeholder and starts pricing real services once the address step's district is known — coded against the contract issue #106 (D4) names, so wiring in `apps/cms`'s own RajaOngkir adapter later needs no storefront change.

- **`apps/storefront/src/lib/toko-klien.ts`** — `QuoteRequest` gains an optional `destination?: {districtCode: string} | null`; `ShippingOption` gains optional `etd?: string | null` (shown beside the price) and `note?: string | null` (the disabled placeholder's own reason); `ShippingSelection`'s `courier` variant now carries its own `serviceId: string | null`, matching `alternative`'s shape rather than being a bare `{method:"courier"}` — a courier method can now mean several different priced services at once.
- **`apps/storefront/src/lib/kurir-opsi.ts`** (new) — the pure option → display mapping extracted out of `checkout.ts`'s `renderShippingOptions`: `describeShippingOption` decides the name/etd/price/note text for one radio row, `isShippingOptionSelected` decides whether it is the shopper's current choice (courier/alternative match on `serviceId` too, not `method` alone), and `shippingOptionKey` builds the radio's own `{method, serviceId}` JSON value. Unit-tested with no DOM (`apps/storefront/tests/kurir-opsi.test.ts`).
- **`checkout.ts`** — the district `<select>`'s own `change` event (and the saved-address autofill, which sets it programmatically and so re-quotes explicitly after `applyRegionSelection` resolves) re-quotes with `destination: {districtCode}` whenever it has a value. `renderShippingOptions` now renders each courier service as its own radio (`{name} ({etd}) — {price}`), keeps the single disabled placeholder's `note` as visible help text (`aria-describedby`, not a tooltip), and an `aria-live="polite"` status line (`[data-shipping-status]`, `checkout.astro`) announces "Menghitung ongkir…" while a quote is in flight and a short failure message otherwise. No client-side arithmetic was added — every price still comes from the quote, formatted only through `formatPrice`.
- **`apps/storefront/src/lib/awcms/pemasaran.ts`**'s `ShippingSettings` gains an optional `courier?: {enabled: boolean; couriers: string[]}`, additive beside the older `courierEnabled` boolean (kept for an awcms build that only ever sends that one) — modelled for parity with the public read model; this app itself never reads it (the quote endpoint alone decides what to render).
- **`apps/storefront/scripts/stub-awcms.mjs`** — `shippingOptionsFor`/`buildCourierOptions` price real services from the new `apps/storefront/tests/fixtures/awcms/shipping-rates.json` (three district codes from the existing region fixtures × three couriers × two services each, `baseCost` for the first kilogram plus `perExtraKg` per kilogram after, rounded UP), honouring `shipping.courier.enabled`/`.couriers` (falling back to the older `shipping.courierEnabled` with no allow-list). The single disabled placeholder returns with a `note` naming which of three reasons applies: courier off, no destination yet, or this destination has no rate row. `POST /orders` derives `destination` from `body.address.districtCode` (no separate field on `CreateOrderRequest` — the address already names the district) and re-validates the chosen `{method, serviceId}` against a fresh quote, answering `409 CART_CHANGED` with that quote on any mismatch — a stale rate is treated exactly like a stock/price change. `apps/storefront/tests/fixtures/awcms/store-settings-public.json` gains `shipping.courier: {enabled: true, couriers: ["jne", "jnt", "sicepat"]}` and flips `courierEnabled` to `true` (an awcms build predating this issue would still enable rates this way alone). `apps/storefront/tests/fixtures/awcms/regions-kalteng.json` gains a third district (`Kota Palangka Raya`'s `PAHANDUT`) so the rate fixture can cover three real, distinct destinations.
- **`apps/storefront/tests/kurir-build-smoke.test.ts`** (new) — a real `astro build` against the stub, asserting `/checkout`'s shipping step carries the `aria-live` status region and no inline `<script>`/`<style>`. `apps/storefront/tests/e2e/checkout.e2e.ts` gains a courier scenario: no district yet shows the disabled placeholder's own note, picking a district prices real JNE/J&T/SiCepat rates, and choosing one carries through to a placed order.

## Visitor analytics and the optional GA4 switch (issue #56)

`apps/storefront/src/scripts/analitik.ts`, mounted once in `BaseLayout.astro`
so it runs on **every page, store and news alike**, is this site's own
first-party visitor beacon: on `DOMContentLoaded` (and on `pageshow` when a
browser restores a page from its back/forward cache — `DOMContentLoaded`
does not fire again for that), it reports one page view to `apps/cms`'s
`visitor_analytics` module, `POST /api/v1/analytics/collect`, feeding the
same rollups A3's "Terpopuler" section reads.

- **`fetch`, never `navigator.sendBeacon`.** The obvious beacon API cannot
  send this endpoint a request it accepts cross-origin — see
  `analitik.ts`'s own docblock, and
  `apps/cms/src/modules/visitor-analytics/domain/beacon-cors.ts`'s "## What
  was actually broken" for why. The call actually made is `fetch` with
  `content-type: application/json`, `credentials: "include"` (the anonymous,
  server-set `awcms_visitor_key` cookie — never read or written by this
  app's own code), and `keepalive: true` (the property that made
  `sendBeacon` attractive in the first place, kept here).
- **The payload is exactly `{ tenantCode, path, referrer? }`** — verified
  against `apps/cms/src/pages/api/v1/analytics/collect.ts` and its module's
  README directly. `tenantCode` is the SAME `AWCMS_TENANT_CODE` build-time
  variable `theme.ts` already reads (see below), baked into
  `<body data-analytics-tenant-code>` rather than read from a second env
  variable — this app never introduces a `PUBLIC_`-prefixed alias of it.
- **Privacy-respecting by construction.** `Do Not Track`
  (`navigator.doNotTrack`, and the legacy `window.doNotTrack`) and Global
  Privacy Control (`navigator.globalPrivacyControl`) both suppress the
  request outright, checked before any network call. No cookie or
  `localStorage` value of this script's own making; silent on any failure
  (ad blocker, offline, an unconfigured `AWCMS_TENANT_CODE`/
  `PUBLIC_AWCMS_ORIGIN`) — a visitor counter must never become a console
  error.
- **Server-side, the module is off by default** (`VISITOR_ANALYTICS_ENABLED`,
  `apps/cms`'s own switch — see `docs/deployment.md`'s "The two switches").
  This app's beacon fires unconditionally either way; an operator who never
  turns that switch on simply gets `202 Accepted` responses that record
  nothing, not an error.
- **Known limitation, stated rather than silently missing:** `/produk`'s and
  `/cari`'s own client-side pagination/filtering
  (`produk-listing.ts`/`cari-listing.ts`) changes the visible grid via
  `history.pushState`, with no full navigation — no second beacon fires for
  it. This is a page-view counter, not a full single-page-app route tracker.

**GA4 is entirely optional and OFF by default.** Setting `PUBLIC_GA_ID` to a
real GA4 Measurement ID (`G-…`, validated by `apps/storefront/src/lib/ga.ts`) makes
`BaseLayout.astro` load `gtag.js` from `https://www.googletagmanager.com`
with `anonymize_ip` set, and widens the served CSP's `script-src`/
`connect-src` for GA's own origins (`apps/storefront/src/pages/csp.json.ts`'s GA branch,
applied by `apps/storefront/server/penyaji.mjs`'s `buildCsp`) — a build with no `PUBLIC_GA_ID`
references no Google origin anywhere, provably (`tests/analitik-build-smoke
.test.ts` builds both ways and asserts it). The `dataLayer`/`gtag` bootstrap
Google's own snippet normally inlines is instead `apps/storefront/src/scripts/ga-init.ts`, an
ordinary same-origin bundled module: an inline `<script>` body is blocked by
this app's CSP regardless of what `script-src` allows, and a fully static
site has no per-request value to mint a CSP nonce from.

## Newsletter (issue #50)

The same anonymous, cross-origin, browser-calls-`apps/cms`-directly pattern
as cart/checkout above, applied to `apps/cms`'s `newsletter` module — an
`awcms` ADR (ADR-0103, in `ahliweb/awcms`'s own decision log, not this
repo's `docs/adr/`): `apps/storefront/src/scripts/buletin.ts` re-implements
`toko-klien.ts`'s own request contract (`mode: "cors"`, `credentials:
"omit"`, one `Content-Type` header, one error type) against a DIFFERENT
base path, `/api/v1/newsletter/*`, rather than widening `toko-klien.ts` past
the base path its own docblock commits it to. `PUBLIC_AWCMS_ORIGIN` is the
same variable, reused unchanged — the newsletter routes live on the same
CMS origin cart/checkout already call, so **no new `connect-src` entry is
needed**: `apps/storefront/src/pages/csp.json.ts` already widens `connect-src` to
`PUBLIC_AWCMS_ORIGIN` for issue #30, and that origin covers every path on
it, this module's included. Verified by re-reading `dist/client/csp.json`
after a build in this issue's own review, not asserted by a new test — a
`connect-src` entry keyed by ORIGIN, not by path, cannot regress per-route.

- **Mounted by issue #49.** `FormBuletin.astro` (`variant: "footer" |
  "sidebar"`) was built here unmounted (placing it in the chrome was a
  separate, parallel change so the two never edited the same shared file
  at once); it now renders in the news sidebar on every page that has one
  and in the footer's box on every news page — two forms on a sidebar page,
  both wired, see "News sidebar and homepage ad slots (issue #49)" above.
  `/buletin` remains the standalone page for links from an e-mail/social
  post.
- **The three CMS routes answer one neutral body for every outcome** — a
  new address, an already-active one, a suppressed one, all read alike, by
  design (`apps/cms/src/pages/api/v1/newsletter/subscribe.ts`'s own
  docblock: a distinguishing response would let this endpoint be used to ask
  whether a named person subscribes to this newsroom's list). That body is
  also in English; this storefront's own copy is Indonesian throughout, so
  `buletin.ts` never renders the CMS's `data.message` verbatim — every
  string a reader sees is written by `buletin.ts` itself, mapped from the
  response's `success`/`error.code`, never its `message`.
- **The subscribe form validates the address BEFORE ever calling `fetch()`.**
  `FormBuletin.astro`'s `<form novalidate>` and `buletin.ts`'s
  `emailInput.checkValidity()`/`reportValidity()` (the same pattern
  `checkout.ts` already uses for its own required fields) stop a malformed
  address from ever reaching the network. This matters more here than it
  would on a same-origin form: a cross-origin `400 VALIDATION_ERROR` from
  these routes carries no CORS grant at all (see the next bullet), so
  without this check a typo would surface to the reader as "could not reach
  the server" — the wrong cause entirely.
- **`VALIDATION_ERROR`/`RATE_LIMITED` are real route behaviour that this
  app's ACTUAL, cross-origin deployment can never actually observe.** All
  three CMS routes answer their own `400`/`429` BEFORE classifying the
  request's `Origin`, and that response carries only `vary: "Origin"` —
  never `access-control-allow-origin`. For a cross-origin `fetch()` (what
  every real deployment of this storefront makes — ADR-0007 (revised, issue
  #30) puts the CMS on a different origin from this app, same as the
  `awcms`-side ADR-0070 already cited below), a response with no CORS
  grant is invisible to JS entirely: the `fetch()` promise itself rejects,
  landing in `buletin.ts`'s own `NETWORK_ERROR` handling, not in a readable
  `400`/`429` body. `buletinErrorMessage`'s `NETWORK_ERROR` copy is worded
  to fit both causes — a genuine dropped connection AND a CORS-hidden
  validation/rate-limit failure — rather than asserting "check your
  connection" for what is very often really a bad e-mail address.
- **`RATE_LIMITED`'s wait comes from the `Retry-After` response HEADER, not
  the JSON body.** The CMS's own `fail(429, "RATE_LIMITED", "...", {},
  undefined, { "retry-after": "<seconds>", vary: "Origin" })` call
  (`apps/cms/src/modules/_shared/api-response.ts`'s `fail` signature is
  `(status, code, message, meta, details, headers)`) never puts the wait in
  `error.details` — an earlier version of this file read `details.retryAfter`
  and would have always gotten `null` in production. `buletin.ts`'s
  `request()` reads `response.headers.get("retry-after")` directly.
- **The honeypot is client-side only.** The CMS route validates exactly
  `email`/`locale` and nothing else, so a third form field would never
  reach it either way; `FormBuletin.astro`'s hidden `website` field is
  checked by `buletin.ts` BEFORE any request is sent — a bot that fills it
  sees the same neutral success message and no request is made at all. Kept
  invisible with the plain HTML `hidden` attribute (removes it from the
  accessibility tree, needs no CSS), not a scoped `<style>`/inline
  `style=""` — this app's CSP is `style-src 'self'` with no inline
  exemption, and neither would even render.
- **`/newsletter/confirm`/`/newsletter/unsubscribe` read `?token=` from the
  URL the reader actually arrived at**, never a form, never storage — the
  token IS the credential the e-mail link carries. A missing or malformed
  token (checked against the same shape the CMS itself validates,
  `apps/cms/src/modules/newsletter/domain/subscription-token.ts`'s
  `isWellFormedSubscriptionToken`) never reaches the network at all, and
  never reveals a button there is nothing correct for it to do.
- **The state-changing POST fires only on a deliberate click, never on page
  load.** A mail gateway's inbound link-scanner (Outlook Safe Links,
  Google's/Microsoft's own scanners, many corporate proxies) routinely
  fetches and fully renders — executes JS on — every link in an incoming
  e-mail before the recipient ever sees it. An eager POST as soon as the
  token parses would let the SCANNER confirm the subscription or unsubscribe
  the reader, not a choice the reader made. Both token pages therefore ship
  an inert, `hidden` button in their static HTML; `buletin.ts`'s
  `wireTokenPage` unhides it once a well-formed token is confirmed present
  and wires the request to its `click` event — see that function's own
  docblock for the full reasoning.
  `apps/storefront/tests/buletin-build-smoke.test.ts` asserts the button
  ships `hidden` in the built HTML.
- **The two token pages live at a CMS-imposed path, not this app's own
  naming.** `apps/cms/src/modules/newsletter/domain/newsletter-mail.ts`
  bakes every confirmation/unsubscribe e-mail's link from two FIXED, non-
  configurable constants:

  ```
  NEWSLETTER_CONFIRM_PATH = "/newsletter/confirm"
  NEWSLETTER_UNSUBSCRIBE_PATH = "/newsletter/unsubscribe"
  ```

  `subscribe.ts`'s own docblock says explicitly that the public site in
  front of this CMS (this storefront, per ADR-0070) is expected to serve
  exactly these two paths — so this app serves `src/pages/newsletter/
  {confirm,unsubscribe}.astro` at those literal paths rather than at a
  storefront-chosen URL with a redirect layered in front of it: a redirect
  would be a workaround for a contract this app can simply honour.
  `apps/storefront/tests/newsletter-path-contract.test.ts` asserts, by file existence at
  those exact strings (importing nothing from `apps/cms`, which this repo
  does not own), that a future upstream rename of either constant fails
  loudly here rather than silently 404ing a real subscriber's e-mail link.
  `/buletin` (the form itself) keeps its own `/buletin` naming — only the
  two CMS-linked pages are pinned to the CMS's path.
- **The link only ever points at THIS storefront if its origin is a
  verified, active tenant domain.** `withPublicNewsletterTenant`
  (`apps/cms/src/modules/newsletter/application/public-newsletter-tenant.ts`)
  resolves a cross-origin subscribe/confirm/unsubscribe call's tenant from
  its `Origin` header via `resolvePublicTenantByHost` — which only ever
  answers a hostname registered in `awcms_tenant_domains` with `status:
  "active"`. An unregistered/unverified origin gets **no CORS grant at
  all** (the browser's `fetch` fails before this app's own error handling
  ever runs) and — for a request that does reach the CMS same-origin —
  falls back to the CMS's OWN host, where `/newsletter/confirm` does not
  exist. **An operator must register this storefront's origin** with `POST
  /api/v1/tenant/domains` and activate it with `POST /api/v1/tenant/domains/
  {id}/verify` (manual-first, no outbound DNS check — see
  `apps/cms/src/modules/tenant-domain/README.md`) before the newsletter
  form works at all, cross-origin subscribe included, not only before the
  e-mailed links resolve correctly.

## Environment variables

See `apps/storefront/.env.example` for the full, current list with
rationale. New in issue #24: `AWCMS_TENANT_CODE` (optional) — this tenant's
public code, used only by the theme client above **and, since issue #56, the
visitor beacon's `tenantCode`**; unset is a normal state that falls back to
BjekMart's default palette, and — for the beacon — to sending nothing at
all. New in issue #56: `PUBLIC_GA_ID` (optional) — see above; unset, empty,
or not shaped like a GA4 id keeps GA off.

Every variable is read at BUILD time only. `apps/storefront/server/
penyaji.mjs` reads `PORT`/`HOST` and nothing else — a finished build never
contacts `apps/cms` again, and `/healthz` (added in issue #24) proves it: it
reports `{ ok: true, build: <id> }` from a build id file `astro build`'s
companion step writes, never a live CMS check.

## The stub workflow

Two terminals, from `apps/storefront`:

```bash
bun scripts/stub-awcms.mjs
# in a second terminal:
AWCMS_API_URL=http://localhost:4310 AWCMS_API_TOKEN=stub-token \
  SITE_URL=http://localhost:4321 bun run build
```

The stub answers every endpoint this app calls (`/api/v1/commerce/*`,
`/api/v1/site-profile/composed`, `/api/v1/blog/pages/public[/​{slug}]`,
`/theming/{tenantCode}/tokens.css`, and — issue #28 —
`/api/v1/blog/{posts,terms,institutions}`, `/api/v1/idn-regions/regions`,
`/api/v1/news-portal/ad-placements/active`, `/api/v1/seo/redirects`, and —
issue #49 — `/api/v1/analytics/pages`)
straight from the committed fixtures under
`apps/storefront/tests/fixtures/awcms/` — a reviewer can read the exact
response shape this app was built against as plain JSON/CSS, not a shape
hidden inside the script. Since issue #30 it also answers
`/api/v1/commerce/storefront/*` as a small in-memory state machine (quote →
create order → track → confirm payment → cancel) rather than a fixed
fixture, since these routes are mutations; `STUB_ALLOWED_ORIGIN` (default
`http://localhost:4321`) is the one `Origin` it answers, matching the
anonymous cross-origin CORS contract these routes implement for real. It
is not part of the production build or image: nothing under
`apps/storefront/src/`, `apps/storefront/
astro.config.mjs`, or `apps/storefront/server/penyaji.mjs` imports it, and
no `package.json` script wires it into `bun run build` — it is a manual,
explicit step for local/CI verification against a build with no live CMS to
reach.

### Build-time request concurrency against a real CMS (issue #71)

The stub never refuses a request, so it cannot show the one way a build
that passes here still fails against a real `apps/cms`: too many requests
at once. `apps/cms/src/lib/database/work-class.ts` admits at most
`WORK_CLASS_MAX.interactive` = 8 running `interactive` requests plus a
bounded queue of 8 × `DATABASE_WORK_CLASS_QUEUE_MULTIPLIER` (default 4) =
32 waiting — 40 in total — and rejects the 41st outright with a 503
(`WorkClassQueueFullError`, logged as `database.pool.rejected`).
`/index/wilayah-kecamatan-{code}.json`'s `getStaticPaths` used to fire one
`GET /api/v1/idn-regions/regions?level=3&parentCode=…` per regency in the
same tick — 56 with the default `PUBLIC_WILAYAH_PROVINSI`, 16 of them
rejected, build failed. Every region request now passes through one
module-level limiter in `apps/storefront/src/lib/awcms/wilayah-checkout.ts`
(`MAX_IN_FLIGHT_REGION_REQUESTS` = **6**): under the 8 running slots — not
merely under the 40 admitted — so the region walk never even queues on an
idle CMS and leaves two running slots plus the whole queue to the rest of
the same `astro build` (catalog, news, marketing fetches run in parallel
with it) and to the CMS's own admin users. Fewer, bigger calls were
considered and rejected: that route filters by `parentCode` as an exact
match on the direct parent (no ancestor or code-prefix filter — see
`apps/cms/src/modules/idn-admin-regions/application/region-lookup.ts`), so
the only single-walk alternative is a whole-country `level=3` walk or
seeding the `after` cursor as a range start, which the route does not
document. `apps/storefront/tests/wilayah-checkout.test.ts` asserts the
ceiling over the real 56-regency fan-out with a mocked client; the
end-to-end proof (zero `database.pool.rejected` in the CMS log for a default
build) is a real-CMS build per `docs/deployment.md`'s "Local database".

## Test tiers

Run from the ROOT (`bun test`) — `bunfig.toml` only excludes `apps/cms`, so
this app's tests are part of the same root gate suite:

1. **Pure unit tests** (color math, the Portable Text renderer, the sitemap
   registry, theme-token parsing, site-identity merging, the route
   constants) — no network, no filesystem beyond a fixture, fast. These are
   what a change to any of that logic should be caught by.
2. **The server test** — the server's pure helpers directly (cache-control
   classification, the old `/products` redirect, build-id reading, CSS
   preload discovery), then real HTTP requests against a server built
   in-process (no `dist/` build needed) to assert headers, `/healthz`, and
   the CSS preload `Link` header end to end.
3. **The build smoke tests** — run a REAL `astro build` against the stub CMS
   above and inspect the actual `dist/client/*` output; each issue that
   needs one adds its OWN file rather than editing a prior issue's
   (`build-smoke.test.ts` #24, `katalog-build-smoke.test.ts` #27,
   `berita-build-smoke.test.ts` #28, `checkout-build-smoke.test.ts` #30,
   `buletin-build-smoke.test.ts` #50, `bagikan-build-smoke.test.ts` #51, `sidebar-build-smoke.test.ts` #49).

   `buletin-build-smoke.test.ts` #50, `bagikan-build-smoke.test.ts` #51, `dengar-build-smoke.test.ts` #52,
   `gateway-build-smoke.test.ts` #112).
   Each is bounded under ~60s; if `bun` cannot be spawned in the environment
   running the suite, it reports SKIPPED with a named reason rather than a
   false pass.
4. **Browser-level Playwright tests** (issue #30, `apps/storefront/tests/
   e2e/`) — the top of the pyramid, run by their OWN `bun run test:e2e`
   script from `apps/storefront`, never by `bun test`/the root suite (a
   browser dependency has no business gating every contributor's unit-test
   run). See "Cart, checkout, order tracking, wishlist" above for how to run
   it and how CI could run it later.

## Payment gateway checkout — "Bayar sekarang" + polling (issue #112, S2 of #33, contract: #106 D3)

Checkout gains a fourth payment method, `gateway`, redirect-based per [ADR-0010](../../docs/adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md) — the order itself is placed exactly as any other method, then a SEPARATE call starts a hosted payment session this app sends the whole browser tab to.

- **`apps/storefront/src/lib/toko-klien.ts`** — `PaymentMethodAvailability.method`/`OrderPaymentInput.method` gain `"gateway"`; `Order` gains an optional `gateway?: {provider, status} | null`; a new `createGatewaySession(orderCode, phone, bearerToken?)` calls `POST …/orders/{code}/payment-gateway/sessions`, matching `createOrder`'s own "phone for a guest, an optional Bearer for a signed-in shopper" shape.
- **`apps/storefront/src/lib/gateway-redirect.ts`** (new) — `isValidGatewayRedirectUrl`, the ONE gate every `redirectUrl` this app ever receives passes through before `window.location.assign` gets it: `https:` always, `http:` only when this build's own `PUBLIC_AWCMS_ORIGIN` is itself `http:` (the local/CI stub, never a real deployment).
- **`checkout.ts`** — `PAYMENT_LABELS.gateway = "Bayar online (kartu, VA, e-wallet)"`. After a successful `createOrder` for a `gateway` order, the cart is cleared and the phone stashed exactly as for every other method, then `createGatewaySession` is called; a valid `redirectUrl` sends the whole tab there, and any failure (the session call itself, or an invalid `redirectUrl`) falls through to `/pesanan?kode=` instead — the order already exists, so this is never surfaced as a checkout failure.
- **`apps/storefront/src/lib/pesanan-render.ts`** — `renderPaymentSection` (renamed from `renderPaymentInstructions`) now branches: a `gateway` order still `pending_payment` shows the "Bayar sekarang" button (`data-gateway-pay`) and an `aria-live` status line (`data-gateway-status`, "Menunggu konfirmasi pembayaran…" → "Pembayaran diterima.") INSTEAD of manual-transfer instructions. `PesananRenderRefs` gains `gatewayPayButton`/`gatewayStatusEl`, both optional like every other ref.
- **`apps/storefront/src/lib/pesanan-poll.ts`** (new) — `nextPollDecision`, a PURE scheduler (`{status, expiresAt, elapsedMs, pageHidden, nowMs}` → poll-in-5s or stop-with-a-reason: `status` left `pending_payment`, `expired`, 15-minute `timeout`, or a `hidden`-page PAUSE, not a stop) unit-tested with no timer/`document` at all (`apps/storefront/tests/pesanan-poll.test.ts`); `wirePesananPolling` is the impure wiring on top, used identically by `pesanan.ts` and `akun-pesanan.ts` — re-fetches the order every 5 s, re-renders, and resumes on `visibilitychange` after a hidden-page pause.
- **`pesanan.ts`/`akun-pesanan.ts`** — both wire the "Bayar sekarang" click to `createGatewaySession` (phone from `sessionStorage` on `/pesanan`, the signed-in Bearer with no phone on `/akun/pesanan`, matching that page's own "no phone prompt at all" rule) and start the poller once a `gateway`/`pending_payment` order first renders. `akun-pesanan.ts` additionally clears the local session (`hapusSesi()`) and falls back to the guest view on a `401 UNAUTHENTICATED` from the session call, the same rule every other bearer-secured call in this app already follows.
- **`apps/storefront/src/lib/awcms/pemasaran.ts`**'s `PaymentSettings` gains an optional `gatewayEnabled?: boolean` — modelled for parity with the public read model, `?? false`-defaulted like `proofUpload`; this app itself never branches on it directly (the quote's own `paymentMethods[]` alone decides what checkout renders).
- **`apps/storefront/scripts/stub-awcms.mjs`** — `store-settings-public.json` gains `payment.gatewayEnabled: true`; `computeQuote`'s `paymentMethods[]` lists `gateway` when it is on; `POST …/orders/{code}/payment-gateway/sessions` is idempotent per order (a repeat call returns the SAME session), `409 PAYMENT_NOT_APPLICABLE` outside `pending_payment`/`gateway`, `503 GATEWAY_UNAVAILABLE` when the flag is off. Its `redirectUrl` points at THIS SAME process's own `GET /stub/gateway/{sessionId}` — a tiny, un-styled HTML page (deliberately served OUTSIDE the storefront-commerce CORS/`Origin` gate, since a real gateway's hosted page is the PROVIDER's own origin, not the CMS's) with "Bayar (simulasi)"/"Batal" forms. "Bayar" flips the order to `paid` (`paidAt`, a timeline entry, `gateway.status: "paid"`); "Batal" only sets `gateway.status: "failed"`. Both then `302` back to `{returnBase}/pesanan?kode=…`, where `returnBase` is resolved once at SESSION-CREATION time: `SITE_URL` when set, else the create-session request's own `Referer` origin, else the stub's one known `ALLOWED_ORIGIN` — documented as a genuine choice in that function's own docblock, since a real awcms would instead read its own configured storefront origin, which this fixture-only stub has no equivalent of.
- **Tests** — `apps/storefront/tests/gateway-build-smoke.test.ts` (new file, never editing `checkout-build-smoke.test.ts`/`akun-build-smoke.test.ts`): a real `astro build` proving the "Bayar sekarang" button ships `hidden` on both `/pesanan` and `/akun/pesanan`, with no inline `<script>`/`<style>`. `apps/storefront/tests/pesanan-poll.test.ts` (new) covers `nextPollDecision`'s every stop/pause condition. `apps/storefront/tests/toko-klien.test.ts` gains coverage for `createGatewaySession`'s request shape (phone-only vs. bearer-only) and its `409`/`503` errors. `apps/storefront/tests/e2e/checkout.e2e.ts` gains a full gateway scenario: choose "Bayar online", land on the stub's own hosted page (a DIFFERENT origin), click "Bayar (simulasi)", and land back on `/pesanan` showing "Sudah dibayar" with the button gone.

## WhatsApp OTP, marketing consent, and `/akun/pesan` (issue #115, S3 of #33, contract: #106 D5/D8/D9)

- **`apps/storefront/src/lib/akun-klien.ts`** — `MintaKodeInput`/`VerifikasiKodeInput` gain `via?: "email"|"whatsapp"` and `phone?: string`; `via:"whatsapp"` is LOGIN-only (the server ignores it for `purpose:"register"`) and both request/verify then key on `phone` instead of `email`. `UbahProfilInput` becomes `{name?, marketingConsent?}` — both optional, so `/akun`'s "Ubah Nama" form and its new consent toggle each send only the ONE field they are changing. New: `ambilPercakapan(cursor?)`, `buatPercakapan({subject, body})`, `ambilPercakapanById(id)`, `kirimPesanPercakapan(id, body)` — every one bearer-only, wrapped in the same `denganPembersihanSesi` every other function in that file already uses.
- **`apps/storefront/src/lib/akun-kontrak.ts`** — `Akun` gains `marketingConsent: boolean`; `validateAkun` defaults it to `false` (never rejects) when a stored session predates this field.
- **`apps/storefront/src/lib/awcms/pemasaran.ts`** — `StoreSettings` gains an optional `whatsappOtpEnabled?: boolean`, the same `?? false` precedent `affiliateProgramEnabled` already set — `/masuk` reads this at BUILD time to decide whether to render the channel choice at all.
- **`ROUTES`** gains `accountMessages` (`/akun/pesan`) and `accountMessage(id)` (`/akun/pesan?id=`), the same shape `accountOrder(kode)` already established.
- **`/masuk`** (`masuk.astro` + `masuk.ts`) — when `whatsappOtpEnabled` is `true` at build time, a "Kirim kode lewat: E-mail | WhatsApp" radio group appears above the identifier field; choosing WhatsApp swaps to a phone field (`type="tel"`, `autocomplete="tel"`, an Indonesian-format hint) and both "Kirim kode" and the verify step send `phone` (not `email`). `409 CHANNEL_UNAVAILABLE` shows "Kode via WhatsApp sedang tidak tersedia di toko ini." When the flag is off (or absent, an awcms that predates #106 D5), the page degrades to the e-mail-only form it always had — no radio group at all.
- **`/daftar`** — a one-line note above the form: registration always uses e-mail OTP, with a link to `/masuk` for a WhatsApp-enabled tenant's existing customers. No functional change: `/daftar` never sends `via`.
- **`/akun`** (`akun/index.astro` + `akun.ts`) — a "Preferensi Promo" card with a real `<input type="checkbox">` inside its own `<label>` ("Terima promo lewat e-mail/WhatsApp"). It saves on `change` (`PATCH …/account/me {marketingConsent}`), confirms through an `aria-live="polite"` region, and reverts its own checked state (no reload) if the save fails — the checkbox is never left showing a state the server did not confirm. The dashboard's navigation grid gains a "Pesan" card linking to `ROUTES.accountMessages`.
- **`/akun/pesan`** (new: `pesan.astro` + `akun-pesan.ts`) — mirrors `/akun/pesanan`'s own list/detail split, keyed by `?id=` instead of `?kode=`: a keyset-paginated conversation list ("Muat lebih banyak"), each row with an unread badge (`aria-label="{n} pesan belum dibaca"`) when `unreadForCustomer > 0`; a "Pesan baru" form (subject + body) that redirects into the new thread; a thread view (every message, oldest first) with a reply form shown only while `status` is `"open"` — a closed thread shows a note instead. `noindex, follow` is inherited from `robots.txt.ts`'s existing bare `Disallow: /akun` (verified, no new line needed).
- **`apps/storefront/scripts/stub-awcms.mjs`** — `POST …/account/otp/request` accepts `via`/`phone`, answering `409 CHANNEL_UNAVAILABLE` when `store-settings-public.json`'s `whatsappOtpEnabled` is not `true`; `POST …/otp/verify` accepts `{phone, code, purpose:"login"}`, resolving the account by phone. The fixture account (`budi@example.test`, `+6281234567890`) authenticates over WhatsApp with the same `123456` code as the e-mail path. Every account gains `marketingConsent` (seeded `true` for the fixture account) and `conversations` — the fixture account is seeded with one OPEN thread carrying an unread store reply and one CLOSED thread, so the unread badge and "closed thread" behaviours are both exercised with no manual message first; every new customer message schedules a SIMULATED store auto-reply 2 seconds later (in-memory `setTimeout`, never persisted), incrementing `unreadForCustomer` — this issue's own "so unread flags are exercised" requirement. `store-settings-public.json` sets `whatsappOtpEnabled: true`.
- **Tests** — `apps/storefront/tests/pesan-build-smoke.test.ts` (new file): a real `astro build` proving `/akun/pesan` ships with `noindex`, no inline `<script>`/`<style>`, and that `/masuk`/`/daftar`/`/akun` render the new channel choice/note/checkbox. `apps/storefront/tests/akun-klien.test.ts` gains coverage for the `via`/`phone` request shapes, the consent-only PATCH, and every conversations function's request shape plus its `401`/`409` handling. `apps/storefront/tests/akun-kontrak.test.ts` gains coverage for `marketingConsent`'s default-to-`false` behaviour.
