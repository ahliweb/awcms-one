🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](routing.id.md)

# Routing

Every route `apps/storefront` publishes — 52 route files, all of it statically generated (`output: "static"`, `trailingSlash: "never"`, `build.format: "file"`, no `prerender = false` anywhere — enforced by [`apps/storefront/tests/checkout-guard-no-prerender.test.ts`](../apps/storefront/tests/checkout-guard-no-prerender.test.ts), which greps every page source rather than compiling it, under `src/pages/**` AND `src/profil/*/pages/**`). Cart/checkout/order-tracking pages are static too — see [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md) for why their client-side JavaScript can call `apps/cms` live without the page itself being server-rendered.

Since issue #137 the route files live in **page groups**, and which groups a build includes is decided by the build profile — see the next section before reading the tables: a `Source` column that starts with `apps/storefront/src/profil/toko/` or `.../profil/berita/` names a route that exists only in a profile composing that group.

## Build profiles: `SITE_PROFILE` decides which groups are routes (issue #137, [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) D2/D3)

`SITE_PROFILE` (`toko` — the default, BjekMart's own hybrid site — `berita`, or `landing`) is read once, at build time, by [`apps/storefront/src/config/profil.ts`](../apps/storefront/src/config/profil.ts) through the same `readEnv` chain `SITE_URL` uses. An unknown value fails the build with a message naming the variable; unset means `toko`. A profile is a composition of three page groups:

| Profile | Groups | What it is |
| --- | --- | --- |
| `toko` (default) | `shared` + `toko` + `berita` | Commerce and news together — today's BjekMart, byte-for-byte what it built before #137 |
| `berita` | `shared` + `berita` | A news portal only, no commerce |
| `landing` | `shared` | A company profile / landing site — home, static pages, contact, SEO chrome |

**Where the files are.** `apps/storefront/src/pages/**` holds only the `shared` group — the ten files every profile serves (`index.astro`, `404.astro`, `kontak.astro`, `halaman/[slug].astro`, `robots.txt.ts`, `sitemap-index.xml.ts`, `sitemap-[n].xml.ts`, `csp.json.ts`, `manifest.webmanifest.ts`, `theme-tokens.css.ts`) — as ordinary Astro file-based routes. Every other page file was moved (`git mv`, history preserved) to `apps/storefront/src/profil/<group>/pages/**`, keeping exactly the relative path it had under `apps/storefront/src/pages/`: 23 files under `profil/toko/pages/`, 19 under `profil/berita/pages/`. The full file-by-file assignment, including the three edge cases decided from the code rather than the file names (`mitra/[slug]` is `berita`, the root `feed.xml` is the `toko` product feed, `index/wilayah-*` is the `toko` checkout address cascade), is the profile matrix in [`docs/template.md`](template.md); [`apps/storefront/tests/profil-integrasi.test.ts`](../apps/storefront/tests/profil-integrasi.test.ts) parses that table and fails if the tree disagrees with it.

**How the groups become routes.** [`apps/storefront/integrations/profil.mjs`](../apps/storefront/integrations/profil.mjs), the app's only Astro integration (registered in `apps/storefront/astro.config.mjs`), runs in the `astro:config:setup` hook — before Astro scans `apps/storefront/src/pages/` — and calls `injectRoute({ pattern, entrypoint })` for every file under an ACTIVE group's `pages/` directory. `pattern` is the route Astro's own file-based routing would have derived from the same relative path (`produk.astro` → `/produk`, `berita/index.astro` → `/berita`, `feed.xml.ts` → `/feed.xml`, `rubrik/[slug]/halaman/[n].astro` → `/rubrik/[slug]/halaman/[n]`); `entrypoint` is the file's path relative to the project root (`./src/profil/toko/pages/produk.astro`), the form Astro's integration API resolves against `config.root`. An inactive group's directory is never walked: its pages are not routes, their `getStaticPaths()` never runs, their data is never fetched, nothing of them reaches `dist/`. No route ever sets `prerender` — the guard test above walks `src/profil/**` too.

**The home page.** `/` is `shared`, but its content is per profile. `apps/storefront/src/pages/index.astro` imports `@profil/beranda`, a Vite alias the same integration points at `apps/storefront/src/profil/<profile>/Beranda.astro`: `toko/Beranda.astro` is the pre-#137 home page moved verbatim; `berita/Beranda.astro` renders the `/berita` front page's body ([`apps/storefront/src/components/berita/HalamanDepanBerita.astro`](../apps/storefront/src/components/berita/HalamanDepanBerita.astro), shared with `/berita` itself) under the news chrome with the site name as its `<h1>`; `landing/Beranda.astro` is a hero, the published static pages and a contact section. An alias rather than a three-way `import` inside `index.astro` because Astro collects a page's stylesheets from everything it imports — statically or dynamically — so only the active variant may be in the module graph if `toko`'s home is to stay byte-identical.

**Everything else reads `profil.ts`, nothing re-decides a group.** The header nav and search form, the footer's help and legal links, the `<link rel="alternate">` feed and the `/product-labels.css` stylesheet in `BaseLayout`, `robots.txt`'s `Disallow` list, `sitemap-sources.ts`/`sitemap-katalog.ts`'s registrations, `csp.json.ts`'s content reads, and `routes.ts`'s own `ROUTE_GROUPS` annotation (every `ROUTES` key carries its group; `satisfies` makes an unannotated key a type error) all come from that one module. Per profile:

| | `toko` | `berita` | `landing` |
| --- | --- | --- | --- |
| Header nav | Beranda, Produk, Flash Sale, Berita, Kontak + cart/wishlist/account tools | Beranda, Berita, the recognised top-level rubrik (dynamic), Video, Buletin, Kontak | Beranda, every published static page (dynamic), Kontak |
| Header/404 search form | `/cari` (products) | `/cari-berita` (news) | none |
| Footer legal links | all six | Redaksi, Pedoman Media Siber, Disclaimer, Kebijakan Privasi, Syarat & Ketentuan | Kebijakan Privasi, Syarat & Ketentuan |
| `robots.txt` `Disallow` | `/keranjang`, `/checkout`, `/pesanan`, `/wishlist`, `/cari`, `/newsletter/confirm`, `/newsletter/unsubscribe`, `/masuk`, `/daftar`, `/akun`, `/api/` (unchanged) | `/newsletter/confirm`, `/newsletter/unsubscribe`, `/api/` | `/api/` |
| Sitemap sources | all twelve | `static-routes`, `static-pages`, every `berita-*` | `static-routes`, `static-pages` |
| Feeds | `/feed.xml` (products, advertised in `<head>`), `/berita/feed.xml`, `/rubrik/{slug}/feed.xml` | `/berita/feed.xml` (advertised), `/rubrik/{slug}/feed.xml` | none |
| `csp.json` | `connect-src` = `PUBLIC_AWCMS_ORIGIN`; `img-src` from products, marketing, article media; `frame-src` YouTube when a video post exists | `connect-src` = `PUBLIC_AWCMS_ORIGIN` (the visitor beacon and the newsletter form post there); `img-src` from article media; YouTube as above | `connect-src` = `PUBLIC_AWCMS_ORIGIN` (the visitor beacon runs on every page); `img-src` = the media host and the site logo only; no `frame-src` |

The server ([`apps/storefront/server/penyaji.mjs`](../apps/storefront/server/penyaji.mjs)) needs no profile flag: it derives what it can serve from `dist/` at startup, as it already did for the CSP artifact and the legacy-redirect map — the rule-based legacy news redirects (below) now run only when `berita.html` exists in the build, so a `landing` deployment never 301s a reader into a `/berita` it does not have.

## Catalog

| Path | Source | Notes |
| --- | --- | --- |
| `/` | `apps/storefront/src/pages/index.astro` | Slider, popular categories, flash-sale strip, featured/recommended products, testimonials, recent news, promo popup |
| `/produk` | `apps/storefront/src/profil/toko/pages/produk.astro` | Grid + sidebar (category tree, sort, price range, stock, flash-sale-only); client-side search/filter/sort/pagination over `/index/produk.json`, first page server-rendered so it stays indexable |
| `/kategori/{slug}` | `apps/storefront/src/profil/toko/pages/kategori/[slug].astro` | One page per live category |
| `/flash-sale` | `apps/storefront/src/profil/toko/pages/flash-sale.astro` | |
| `/product/{slug}` | `apps/storefront/src/profil/toko/pages/product/[slug].astro` | Gallery, variant picker, tiered/flash-sale price, size chart, service form, related products; `Product`/`Offer`/`BreadcrumbList` JSON-LD — see [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.md) for the URL shape itself |
| `/cari` | `apps/storefront/src/profil/toko/pages/cari.astro` | Catalog search; `noindex, follow` |

## News (mirrors seputarborneo/beritasampit)

| Path | Source | Notes |
| --- | --- | --- |
| `/berita` | `apps/storefront/src/profil/berita/pages/berita/index.astro` | Headline + one section per top-level rubrik, video strip, mitra strip, sidebar |
| `/berita/{slug}` | `apps/storefront/src/profil/berita/pages/berita/[slug].astro` | Article detail; `NewsArticle`+`BreadcrumbList` JSON-LD |
| `/berita/feed.xml` | `apps/storefront/src/profil/berita/pages/berita/feed.xml.ts` | RSS 2.0, 20 latest, full `content:encoded` |
| `/rubrik/{slug}` | `apps/storefront/src/profil/berita/pages/rubrik/[slug]/index.astro` | A parent rubrik's archive includes every descendant rubrik's posts |
| `/rubrik/{slug}/halaman/{n}` | `apps/storefront/src/profil/berita/pages/rubrik/[slug]/halaman/[n].astro` | Pagination |
| `/rubrik/{slug}/feed.xml` | `apps/storefront/src/profil/berita/pages/rubrik/[slug]/feed.xml.ts` | Per-rubrik RSS |
| `/daerah/{slug}` | `apps/storefront/src/profil/berita/pages/daerah/[slug].astro` | Region archive — reached via an institution's `regionCode`; a post itself carries no region field |
| `/mitra/{slug}` | `apps/storefront/src/profil/berita/pages/mitra/[slug].astro` | Institution landing page |
| `/video` | `apps/storefront/src/profil/berita/pages/video/index.astro` | |
| `/video/{slug}` | `apps/storefront/src/profil/berita/pages/video/[slug].astro` | Posts carrying a renderable `videoNews` block; partitioned from `/berita/{slug}` so no post has two canonical URLs |
| `/tag/{slug}` | `apps/storefront/src/profil/berita/pages/tag/[slug].astro` | |
| `/penulis/{slug}` | `apps/storefront/src/profil/berita/pages/penulis/[slug].astro` | Byline-based author archive |
| `/arsip/{yyyy}/{mm}` | `apps/storefront/src/profil/berita/pages/arsip/[yyyy]/[mm].astro` | WIB calendar month |
| `/cari-berita` | `apps/storefront/src/profil/berita/pages/cari-berita.astro` | Client-side search over `/index/berita.json` |

## Commerce runtime (browser calls `apps/cms` directly; pages themselves are static)

| Path | Source | Notes |
| --- | --- | --- |
| `/keranjang` | `apps/storefront/src/profil/toko/pages/keranjang.astro` | Renders the `localStorage` cart, re-quotes live, voucher code, no-JS WhatsApp fallback |
| `/checkout` | `apps/storefront/src/profil/toko/pages/checkout.astro` | One page, five progressively-disclosed steps: contact → address → shipping → payment → review |
| `/pesanan` | `apps/storefront/src/profil/toko/pages/pesanan.astro` | Tracking by `?kode=`; **not** `/pesanan/[kode]` — a per-code path cannot be prerendered under `output: "static"`, and there is no server-side catch-all to redirect from one shape to the other; the phone comes from `sessionStorage` or a form, never the URL |
| `/wishlist` | `apps/storefront/src/profil/toko/pages/wishlist.astro` | `localStorage`-only |

All four: `noindex, follow`, `aria-live="polite"` on quote/status updates, keyboard-reachable, a `<noscript>` fallback plus a JS-ran-but-CMS-down WhatsApp fallback (`apps/storefront/src/lib/wa-fallback.ts`).

## Customer accounts (issue #88 S1, issue #90 S2, issue #93/#115 S3, of #32/#33)

| Path | Source | Notes |
| --- | --- | --- |
| `/masuk` | `apps/storefront/src/profil/toko/pages/masuk.astro` | E-mail OTP sign-in; issue #115 (contract #106 D5) adds a "Kirim kode lewat: E-mail \| WhatsApp" channel choice, rendered only when the public store settings' `whatsappOtpEnabled` is `true` at build time — WhatsApp asks for a phone (`type="tel"`) instead of an e-mail; `noindex, follow` |
| `/daftar` | `apps/storefront/src/profil/toko/pages/daftar.astro` | Name + phone + e-mail OTP registration; always e-mail-only (issue #115's own note explains this even when `/masuk`'s WhatsApp channel is on); `noindex, follow` |
| `/akun` | `apps/storefront/src/profil/toko/pages/akun/index.astro` | Signed-in dashboard shell (profile, "Ubah nama", the marketing-consent checkbox added by issue #115, "Keluar", navigation cards); `noindex, follow` |
| `/akun/alamat` | `apps/storefront/src/profil/toko/pages/akun/alamat.astro` | List/add/edit/delete/set-default addresses (max 10); the province/city/district selects reuse `apps/storefront/src/lib/wilayah-region-select.ts`, the SAME module `checkout.astro`'s own saved-address autofill uses; `noindex, follow` |
| `/akun/pesanan` | `apps/storefront/src/profil/toko/pages/akun/pesanan.astro` | Keyset-paginated order list ("Muat lebih banyak"); `noindex, follow` |
| `/akun/pesanan?kode=` | same file, `?kode=` present | One owned order's detail, reusing `/pesanan`'s own renderer (`apps/storefront/src/lib/pesanan-render.ts`) — NO phone prompt, the session already proves ownership |
| `/akun/ulasan` | `apps/storefront/src/profil/toko/pages/akun/ulasan.astro` | The account's own product reviews — rating as text + stars, Indonesian moderation status; `noindex, follow` |
| `/akun/afiliasi` | `apps/storefront/src/profil/toko/pages/akun/afiliasi.astro` | The affiliate program (issue #93, S3 of #32; the CMS/staff side is issue #92): closed explanation when `affiliateProgramEnabled` is `false` at build time, otherwise enrol/referral-link/stats/commissions; `noindex, follow` |
| `/akun/pesan` | `apps/storefront/src/profil/toko/pages/akun/pesan.astro` | The account's own message inbox with the store (issue #115, S3 of #33, contract #106 D8): keyset-paginated conversation list with an unread badge, a "Pesan baru" form, a thread view; `noindex, follow` (inherited from the `/akun` `Disallow` prefix — no `robots.txt` change needed) |
| `/akun/pesan?id=` | same file, `?id=` present | One owned conversation's thread — every message, a reply form while `status` is `"open"`, a closed-thread note otherwise |

`ROUTES.accountOrder(kode)` (`/akun/pesanan?kode=`) is a single order's own URL; `ROUTES.accountMessage(id)` (`/akun/pesan?id=`) is the same shape for a single conversation.

`?ref={code}` on ANY page (not just `/`) is a captured referral, not a distinct route — `apps/storefront/src/scripts/afiliasi-tangkap.ts`, mounted from `BaseLayout.astro` on every page, stores a valid code and strips ONLY that query parameter via `history.replaceState`; see [`docs/seo.md`](seo.md) for why the canonical link is unaffected by the capture.

`checkout.astro`/`checkout.ts` gained a "Pilih alamat tersimpan" `<select>`, hidden until a customer session is confirmed, that autofills the address step from `GET …/account/addresses`; the order-creation request carries the signed-in shopper's Bearer token when one exists (`apps/storefront/src/lib/toko-klien.ts`'s `createOrder` takes an OPTIONAL second `bearerToken` argument — existing anonymous callers are unaffected).

## Static

| Path | Source |
| --- | --- |
| `/kontak` | `apps/storefront/src/pages/kontak.astro` |
| `/halaman/{slug}` | `apps/storefront/src/pages/halaman/[slug].astro` — CMS pages rendered from Portable Text |
| `/404` | `apps/storefront/src/pages/404.astro` |

## Discovery, feeds, and generated assets

| Path | Source |
| --- | --- |
| `/robots.txt` | `apps/storefront/src/pages/robots.txt.ts` — `Disallow`s the active profile's list (`apps/storefront/src/config/profil.ts`'s `ROBOTS_DISALLOW`; for `toko`: `/keranjang`, `/checkout`, `/pesanan`, `/wishlist`, `/cari`, `/newsletter/confirm`, `/newsletter/unsubscribe`, `/masuk`, `/daftar`, `/akun`, `/api/`); names `Sitemap:` |
| `/sitemap-index.xml` | `apps/storefront/src/pages/sitemap-index.xml.ts` |
| `/sitemap-{n}.xml` | `apps/storefront/src/pages/sitemap-[n].xml.ts` — chunked at 5000 URLs/file (`apps/storefront/src/lib/sitemap.ts`'s `registerSitemapSource`) |
| `/feed.xml` | `apps/storefront/src/profil/toko/pages/feed.xml.ts` — products (`toko` group; the news feed is `/berita/feed.xml` above) |
| `/manifest.webmanifest` | `apps/storefront/src/pages/manifest.webmanifest.ts` |
| `/theme-tokens.css` | `apps/storefront/src/pages/theme-tokens.css.ts` — brand colors read from `apps/cms` at build time |
| `/product-labels.css` | `apps/storefront/src/profil/toko/pages/product-labels.css.ts` — one CSS class per distinct `labelColor` the catalog actually uses |
| `/csp.json` | `apps/storefront/src/pages/csp.json.ts` — the derived CSP artifact; see [`docs/arsitektur.md`](arsitektur.md) |
| `/index/produk.json`, `/index/berita.json` | Build-time search indexes for `/produk`/`/cari-berita`'s client-side filtering |
| `/index/pengalihan-legacy.json` | The legacy-redirect map, built from `awcms_seo_redirects` (below) |
| `/index/wilayah-provinsi.json`, `/index/wilayah-kabupaten-{provinceCode}.json`, `/index/wilayah-kecamatan-{cityCode}.json` | Address region data for checkout, baked at build time and scoped by `PUBLIC_WILAYAH_PROVINSI` (default every Kalimantan province) rather than the full ~90,000-village national dataset |

## Legacy redirects

`apps/storefront/server/penyaji.mjs`'s `legacyRedirectLocation()` looks up the incoming path (normalized: URI-decoded, query/fragment stripped, one trailing slash removed) against the map read once at server startup from `dist/client/index/pengalihan-legacy.json`. That file is built from `apps/cms`'s own `awcms_seo_redirects` rows (`origin: "legacy_blog"`) — only rows with `targetType: "relative_same_tenant"` are used (a `verified_external` row points off-site and is skipped); the CMS's own `target` column is not used verbatim — only its final path segment (the slug) is taken and rebuilt in this app's own vocabulary, since `target` carries the CMS's own `/blog/{tenantCode}/{slug}` shape. That rebuilt destination is `/berita/{slug}` for an ordinary post, but `/video/{slug}` when the slug belongs to a video post (`apps/storefront/src/profil/berita/pages/index/pengalihan-legacy.json.ts` calls `getVideo()` once, at build time, for exactly this set) — `apps/storefront/src/lib/berita.ts`'s `getPosts()` never publishes a video post at `/berita/{slug}` too, so a row that ignored this would redirect to a page this app never builds. Two rows that normalize to the same source path but disagree on destination fail the **build**, not a silent last-wins at request time.

Handled URL shapes: seputarborneo's `/news/{id}-{slug}.html` (and its pre-2.0 `/news/{id}_{Title_With_Underscores}.html` form) and beritasampit's `/{yyyy}/{mm}/{dd}/{slug}/` — both normalize correctly whether or not a trailing slash is present, at both build time (map key) and request time (lookup), including a real trailing-slash regression this build caught and fixed (`legacyRedirectLocation`'s own commit history, `apps/storefront/tests/berita-penyaji-legacy.test.ts`).

**Video posts use a synthetic, query-free key — `/video/{id}-{slug}.html` — not the real legacy URL.** seputarborneo's real video URL was `/video/?video={id}-{slug}.html`, with the whole identity in the query string, and `apps/cms` strips the query string from every redirect *source* at write time (`validateRedirectInput` → `normalizeRedirectPath` without `keepQuery`, `apps/cms/src/modules/seo-distribution/domain/redirect-rule.ts` / `redirect-path.ts`): posted as-is, all 35 video rows would be stored as the same bare `/video` — the import chunk fails on `DUPLICATE_IN_BATCH`, or one surviving row redirects the `/video` list page itself to a single post. So `tools/import-seputarborneo.ts` (issue #58) writes `/video/{id}-{slug}.html` as the source instead — a path that never existed publicly, chosen only because it survives the CMS unchanged and still carries the id. The real inbound URL is handled by the rule-based module below: `pengalihan-aturan.mjs`'s `rowIdIndexFor` indexes every row-map key matching `^/video/(\d+)[-_.]` by its numeric id, and `resolveVideoQuery` answers `/video/?video={id}-…`, `{id}_…` or a bare `{id}` from that index — by id only, exactly the way the legacy `video/index.php` read `(int) $_GET['video']`. `apps/storefront/src/lib/pengalihan-legacy.ts`'s `normalizeLegacyPath` still keeps a `/video/?video={id}-…` source's query intact if it ever sees one (a hand-authored fixture; a future CMS that keeps the query), and `rowIdIndexFor` indexes that shape too — but that branch is defensive, not the contract: the CMS itself can never hand the storefront that form.

### Rule-based redirects (issue #55 / A9) — the rest of seputarborneo's URLs, with no CMS row at all

The row-based map above only ever knows a URL an operator/import explicitly recorded — right for a single article, wasteful for a URL shape that is the same for hundreds of pages. `apps/storefront/server/pengalihan-aturan.mjs` is a second, PURE, table-driven module for exactly those shapes — seputarborneo's rubrik/daerah/mitra/video/static/search taxonomy, read off `include/nav_menu.php` (`seputarborneo_rubrik_resolve()`/`_kanonik()`), `.htaccess`, `rubriks/index.php`, `video/index.php`, `img/index.php`, and `data/index.php`. `legacyRedirectLocation()` calls it only on a MISS against the row-based map above, so an operator-authored row always wins when the two could disagree.

| Source shape | Destination | Notes |
| --- | --- | --- |
| `/rubrik/{slug}.html` | `/rubrik/{slug}` | Lower-cased, spaces/underscores/`%20` → `-`; `Olah Raga`/`OLAHRAGA` → `olahraga`; `VIDEO`/`video` → `/video` (its own list page, not a rubrik archive) |
| `/daerah/{kategori}.html`, `/DAERAH/{Kategori}.html` | `/daerah/{slug}` | The 14 daerah's own name, or an old city name (Sampit → `kotawaringin-timur`, and 9 more — see the module's own `DAERAH_ENTRIES` table), maps to its regency's slug |
| `/mitra-borneo/{slug}.html`, `/MITRA%20BORNEO/{Nama}.html`, `/Mitra-Borneo/{Nama}.html` | `/mitra/{slug}` | Any of the 24 Mitra Borneo channels, or a future one — an institution's slug passes through unchanged, so this rule needs no table update when a 25th is seeded |
| `/umum/{slug}.html`, `/UMUM/{Nama}.html` | `/rubrik/{slug}` | UMUM's children are ordinary rubriks here — `/rubrik/wisata.html` (the old topic) and `/umum/wisata.html` (the old UMUM child) both land on `/rubrik/wisata`, the one pair this app's own test suite proves is the ONLY collision across every name the module knows |
| `/rubriks/?news={A}&kt={B}&lanjut={n}` | The SAME as `/{A}/{B}.html` above, plus `/halaman/{n}` (n>1) when that destination is a `/rubrik/…` page | Not a shape of its own — it is `.htaccess`'s own two-segment (or, with `kt` absent, one-segment `/rubrik/{news}.html`) rewrite with its captures already split into query parameters, so it is resolved by the exact same rubrik/daerah/mitra/umum dispatch, never a second one. `daerah`/`mitra` destinations have no paginated route in this app, so `lanjut` is ignored for them |
| `/video/?video={id}-{slug}.html`, `/video/?video={id}_{slug}.html`, or the bare `/video/?video={id}` the old homepage hard-coded | `/video/{slug}` if a `/video/{id}-…` row exists (the exporter's query-free synthetic key, above), else `/video` | Never a guessed slug, and never the `/news/…` row map for the SAME id — `berita_vid`'s ids and `berita_red`'s (behind `/news/…`) are two independent id spaces (issue #58/B2), so a video redirect only ever looks up the row map's own `/video/{id}…` slice |
| `/tentang_kami.html`, `/pedoman_media_cyber.html`, `/disclimer.html` | `/halaman/redaksi`, `/halaman/pedoman-media-siber`, `/halaman/disclaimer` | The three static pages `data/index.php` served |
| `/pencarian/?cari_berita={q}` | `/cari-berita?q={q}` | **302**, not 301 — a search result is not a permanently-moved resource |
| `/img/?news={id}` | The row-based `/news/{id}…` target if known, else `/berita` | `img/index.php` itself already redirected this shape on the live site; the id may be followed by `-`, `_`, or `.` — the CMS legacy importer's documented template for this site is `/news/{legacyId}_{slug}.html` (underscore), not just the hyphen form |
| `/index.php`, `/?subscribed=1` | `/berita` | |

Every one of these is a 301 except the search rule (302, above); `createServer` reads the `{ location, status }` shape `ruleBasedRedirectLocation()` returns only for that one case, and a plain string (301) for every other rule — the same return shape `legacyRedirectLocation()` already had before this module existed, so `apps/storefront/tests/berita-penyaji-legacy.test.ts` needed no change. `apps/storefront/tests/pengalihan-aturan.test.ts` covers every row of the table above (encoded and decoded input, trailing slash or not) plus a loop-guard check: no rule's destination matches any rule's own source shape, so a request can never be redirected twice.

The `/news/…` and `/video/…` id lookups (the img and video rules) are served from an `id -> target` index built once per row-based map object and cached (a `WeakMap` keyed on that object), not rescanned per request — load-bearing once issue #58 (B2) imports seputarborneo's ~25k articles into that same map.

**Only on a build with a news surface (issue #137).** Every rule above sends a reader to a news route. `apps/storefront/server/penyaji.mjs` therefore passes `hasNewsSurface(clientDir)` — "does `dist/client/berita.html` exist?", read once at startup — as `legacyRedirectLocation`'s `rulesEnabled` flag, so a `landing` build (no `berita` group) applies none of them and a request like `/rubrik/politik.html` simply falls through to the adapter's own 404. The row-based map needs no such gate: without the `berita` group there is no `index/pengalihan-legacy.json` artifact, and `readLegacyRedirectMap` already yields `{}` for a missing file.

### Which mechanism is authoritative for category-level legacy URLs

`apps/cms` ships a pre-existing, committed asset for seputarborneo's rubrik/daerah/mitra listing URLs — `apps/cms/data/seputarborneo-legacy/rubrik-redirects.json` (68 entries, captured 2026-08-26) and the `bun run blog:legacy:rubrik-redirects` script that turns it into `POST /api/v1/seo/redirects/import` payloads (upstream `awcms` issue #711 / ADR-0113 in that repo). On **this** storefront it is not used, and the rule-based module above is authoritative for every category-level legacy URL: it needs no CMS row at all, it covers the whole shape family (every rubrik, all 14 daerah with their old city names, all 24 Mitra Borneo channels and any future one, UMUM's children, the paginated `/rubriks/?news=&kt=&lanjut=` form) rather than the 68 hand-typed link literals the asset happened to capture, and it targets this app's own routes. The asset's targets are upstream's vocabulary (`/kategori/daerah`, `/kategori/politik`, …) — on this storefront `/kategori/{slug}` is a **product** category page, so importing those rows would send a news reader to the shop — and its rows would carry `origin: "import"` (the script sets no `origin`, so the route's default applies), which `getLegacyRedirectRows()` ignores anyway. `blog:legacy:rubrik-redirects` is therefore not a step of this repository's runbook (`docs/deployment.md`, "Importing seputarborneo"); the asset itself is upstream subtree content and is left untouched.

## `/products` → `/` (301), unchanged from increment 1

The live site's old catalog URL, `/products` — with or without a query string — still redirects to `/` with a `301`, matched on path only (`isProductsRedirect`/`PRODUCTS_REDIRECT_LOCATION` in `apps/storefront/server/penyaji.mjs`). This is a separate, hardcoded rule, distinct from the generated legacy-redirect map above — see [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.md).

## A page shadowed by a same-named directory is rewritten to its `.html` (issue #75)

Under `build.format: "file"` a landing page that also has children is emitted as **both** a file and a directory — `dist/client/berita.html` beside `dist/client/berita/`, `video.html` beside `video/`, and `rubrik/{slug}.html` beside `rubrik/{slug}/` (the rubrik's `feed.xml` and `halaman/{n}.html`). `@astrojs/node`'s static handler tests for a directory *before* it asks `send` for a file: with `trailingSlash: "never"`, a directory-shaped request with no trailing slash is rewritten to `{path}/index.html` — a file this build never writes — so `send`'s `.html` fallback never runs, the adapter falls through to SSR, and `/berita`, `/video`, and every `/rubrik/{slug}` answered **404** on the served site while the build was green. `apps/storefront/server/penyaji.mjs` therefore walks `dist/client/` **once at startup** (`discoverShadowedHtmlPaths`, recursive — the rubrik shadow is one level down) to find every such path, and, as the *last* step before the adapter — after `/healthz`, the `/products` redirect, and both legacy-redirect layers above, all of which keep precedence — rewrites `req.url` for exactly those paths to `{path}.html` (`shadowedHtmlUrl`, query string kept). It is an internal rewrite, not a redirect: the reader's URL stays `/berita`, and the adapter's own `send` call still serves the file with its own traversal, conditional-GET, and content-type handling — nothing in `penyaji.mjs` reads or streams a page. The trailing-slash form (`/berita/`) is deliberately left to the adapter, which 301s it to `/berita` as before. Covered by `apps/storefront/tests/penyaji-bayangan-html.test.ts` (a synthetic `dist/` tree and the `createServer` hook) and `apps/storefront/tests/penyaji-bayangan-build-smoke.test.ts` (a real stub-backed build served by the real bundled `dist/server/penyaji.mjs`).

## Not built

A per-code order-tracking path (`/pesanan/{code}` — see "Commerce runtime" above for why `?kode=` is the real, static-compatible shape). `apps/storefront/tests/e2e/checkout.e2e.ts` (`bun run test:e2e` inside `apps/storefront`) exists and passes locally, and now runs as part of the `local-ci/e2e-*` legs (`tools/ci/runners/e2e.ts`, issue #183/#225) — see [`docs/pengujian.md`](pengujian.md).
