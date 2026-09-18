# Changelog

Every entry below is folded from `.changesets/` by `bun run release`, which also tags the release. The version is `MAJOR.MINOR.PATCH`, tagged `vX.Y.Z`; the next version is the largest `bump` declared among the changesets a release folds (see [`.changesets/README.md`](.changesets/README.md)) — never a level chosen at release time from a list of file names.

## [0.4.0] — 2026-09-18

### Reconcile apps READMEs found broken by #43's review

Two defects in `apps/**` READMEs, both found while reviewing PR #43 and out
of scope for it since it only touches root-level docs.

- `apps/storefront/README.md`'s stub-workflow paragraph: PR #41 (issue #30)
  inserted the new state-machine clause mid-sentence, between "straight from
  the committed fixtures" and "under `apps/storefront/tests/fixtures/
  awcms/`", orphaning the second half as its own fragment line. Restored the
  original sentence and made the issue #30 addition its own well-formed
  sentence, keeping the file's hard-wrap style.
- `apps/cms/src/modules/commerce/README.id.md` had fallen behind Issue #29:
  the whole "Customers, orders and reviews" section was missing from the
  mirror, the admin-screens heading and body still described the
  pre-#29 eight-screen/32-permission state, and the frontmatter table
  (tables, permissions, API, events, dependencies, jobs) plus several
  prose paragraphs (the `manualRating`/`manualSoldCount` note, the voucher
  redemption paragraph, the `downloadLink` DTO note, and "Dengan sengaja
  tidak ada di sini") still described the pre-#29 shape — one of them
  (the `downloadLink` note) had drifted into stating the opposite of what
  the corrected English source now says. Translated the missing section
  and brought every drifted paragraph back in line with `README.md`,
  paragraph by paragraph. Verified the module has nineteen
  `awcms_commerce_*` tables and 39 permissions against `module.ts`, both of
  which now match `README.md`; no factual error was found in the English
  source itself.

### `audit:rilis` count bound raised from 10 to 20 waiting changesets

The gate's own docblock called 10 files a "starting assumption pending real
release history". There is history now: v0.3.0 folded ten changesets from
one increment, and increment 3 (epic #46) produces one changeset per atomic
PR — fourteen children plus follow-ups — before its own release, so the
bound of 10 turned `check` red on every PR in the second half of the
increment while asking the contributor for nothing. Twenty is the measured
size of one increment's release plus headroom; the 14-day age bound, which
is the one that actually catches an unwatched backlog, is unchanged.

- Only felt while developing: `bun run audit:rilis` no longer reddens a
  branch merely because an increment is more than half merged.

### Rule-based legacy redirects for seputarborneo's rubrik/daerah/mitra/video/static/search URLs

Issue #28's redirect map only ever knows a URL an operator/import explicitly
recorded as a `awcms_seo_redirects` row — right for a single article, but
seeding one row per rubrik/daerah/mitra/video/static/search URL would mean
hundreds of rows for a handful of fixed, deterministic shapes that
seputarborneo's own `include/nav_menu.php`
(`seputarborneo_rubrik_resolve()`/`_kanonik()`) already encodes as a lookup
table, not a database query.

`apps/storefront/server/pengalihan-aturan.mjs` is a new, pure, table-driven
module for exactly those shapes, wired into `legacyRedirectLocation()`
**after** the row-based map — an operator-authored row always wins on
overlap. It covers `/rubrik/{slug}.html` (including `VIDEO`/`video` → the
`/video` list, not a rubrik archive), `/daerah/{kategori}.html` (plus 14 old
city names), `/mitra-borneo/{slug}.html` (24 channels, matching issue #57's
own institution seed list), `/umum/{slug}.html` (UMUM's children are
ordinary rubriks here), `/rubriks/?news=&kt=&lanjut=` (the SAME dispatch as
`/{A}/{B}.html`, not a re-derived one), `/video/?video={id}-{slug}.html`/
`{id}_{slug}.html`/the bare `?video={id}` shape (resolved only against a
known `/video/?video={id}-…` row — a DIFFERENT id space from `/news/…`,
never a guessed slug), the three static pages, the search box (302, not
301 — a search result is not permanently moved), and
`/img/?news={id}`/`/index.php`/`/?subscribed=1`.

- `apps/storefront/server/penyaji.mjs`'s `legacyRedirectLocation()` now
  falls through to the new module on a row-map miss; its return shape grew
  to allow `{ location, status }` for the one 302 case, while every
  existing caller (including
  `apps/storefront/tests/berita-penyaji-legacy.test.ts`, unedited) keeps
  working against the plain-string 301 shape it already returned.
- `apps/storefront/tests/pengalihan-aturan.test.ts` covers every rule
  (encoded/decoded input, trailing slash or not), the documented
  `WISATA`/`Wisata` collision (both intentionally land on
  `/rubrik/wisata`), and a loop guard proving no rule's destination matches
  any rule's own source shape.
- `docs/routing.md`/`.id.md`'s "Legacy redirects" section documents the full
  table.

#### Post-review corrections (PR #61)

Six defects found reviewing the first version of this change, all fixed on
the same branch:

1. The video rule (`?video={id}-…`) was matching the id against `/news/…`
   rows — `berita_red` (`/news/…`) and `berita_vid` (`/video/?video=…`) are
   two INDEPENDENT MariaDB id spaces (issue #58/B2), so this could redirect
   a reader to a numerically-coincidental, unrelated article. It now looks
   up a `/video/?video={id}-…`/`{id}_…` row exclusively, and also resolves
   the bare `?video={id}` shape the old homepage hard-coded.
2. The `/news/{id}…` id lookup only matched a hyphen separator; issue #58's
   importer documents an underscore template
   (`/news/{legacyId}_{slug}.html`), so a real row could silently miss. Now
   matches `-`, `_`, or `.` (a bare id with no slug).
3. `/rubriks/?news={A}&kt={B}` is exactly `/{A}/{B}.html` per `.htaccess`
   — it now reuses the same rubrik/daerah/mitra/umum dispatch instead of
   always answering `/rubrik/…`, so e.g. `news=daerah&kt=Sampit` correctly
   lands on `/daerah/kotawaringin-timur`, not `/rubrik/kotawaringin-timur`.
4. A `/rubriks/?news=` value that normalizes to empty (e.g. `%21%21%21`)
   no longer produces `Location: /rubrik/`.
5. `/rubrik/VIDEO.html`/`/rubrik/video.html` now redirect to `/video` (its
   own list page) instead of a `/rubrik/video` page this app does not have.
6. The `/news/…`/`/video/?video=…` id lookups now read from an
   `id -> target` index built once per row-based map object and cached
   (`WeakMap`), instead of an `Object.keys` scan repeated on every request
   — load-bearing once issue #58 (B2) imports seputarborneo's ~25k rows.

#### One more correction: the row-based (issue #28) map itself

`apps/storefront/src/pages/index/pengalihan-legacy.json.ts`'s row-based map — the one
`pengalihan-aturan.mjs` only ever falls through to on a miss — had two
related bugs of its own, found while wiring the above:

- It rebuilt every `legacy_blog` row's destination as `/berita/{slug}`
  unconditionally, but `apps/storefront/src/lib/berita.ts`'s `getPosts()` never publishes a
  video post there (only `/video/{slug}`) — every imported video's redirect
  would land on a page this app never builds. `buildLegacyRedirectMap()`
  now takes an optional `videoSlugs` set (default empty — every existing
  call/test keeps its prior behavior) and the page supplies it from one
  `getVideo()` call at build time.
- `normalizeLegacyPath` stripped the query string unconditionally, which
  collapsed every `/video/?video={id}-…` row (issue #58/B2's own template
  for a video redirect) onto the identical bare `/video` key — losing the
  id the video fix above needs, and setting up a build-time throw the
  moment a second, differently-targeted video row existed. It now preserves
  the query for that one shape only.

### Seed seputarborneo reference taxonomy, institutions, sample posts, legal pages, ad placements, social links, and legacy redirects

`tools/seed-borneojek-mart.ts` previously seeded 3 store-flavoured blog terms, 3 posts, 2 legal pages, 0 institutions, 0 ad placements, and 0 redirects — against a real database every news page the storefront's `/berita`, `/rubrik/*`, `/daerah/*`, and `/mitra/*` routes render was empty. This gives every developer, reviewer, and CI job something real to look at instead of an empty news IA, modelled on seputarborneo's own reference structure (`include/nav_menu.php`, verified 2026-09-18) so it matches the shape `apps/storefront`'s news pages were actually built against.

- An 8-rubrik `category` taxonomy tree (politik/hukum/nasional/olahraga/wisata/daerah/mitra-borneo/umum) with umum's topical children — including a `wisata-travel` child, a deliberate slug choice recorded in `tools/seed-borneojek-mart.ts`'s own docblock: `awcms_blog_terms_slug_dedup` (`apps/cms/sql/035_awcms_blog_content_schema.sql`) is unique on `(tenant_id, taxonomy_type, slug)` with no `parent_id` component, so this one tree cannot hold seputarborneo's own two `wisata` slugs (a top-level rubrik and a UMUM child) the way its legacy two-column MySQL schema could.
- The 27-institution legislative/executive directory — seputarborneo's own 24-channel Mitra Borneo list plus a bare `Pemkab` for the 3 regencies that list leaves out (Kotawaringin Barat, Sukamara, Barito Selatan), added so all 14 Kalteng regencies/cities have at least one institution to carry their `regionCode` (region membership is institution-only) — each `regionCode` resolved by NAME against `GET /api/v1/idn-regions/regions` at seed time rather than a hard-coded Kepmendagri code.
- 44 sample news posts — at least two per rubrik (all 14, including umum's children) and at least one filed to every one of the 27 institutions through `institutionIds`, so every `/rubrik/*`, all 14 `/daerah/*`, and all 27 `/mitra/*` archives render with content rather than an empty state; generic, clearly-marked placeholders with no real people or events, three carrying a Portable Text `videoNews` node with a clearly-marked placeholder YouTube id.
- Three additional legal pages: `redaksi` (generic placeholders, deliberately not seputarborneo's own company/personnel data), `pedoman-media-siber` (Dewan Pers's public text, ported), and `disclaimer` (genericized to this tenant).
- Six social links and a WhatsApp number on the site profile.
- 5 sample `legacy_blog`-origin redirects exercising `docs/routing.md`'s row-based legacy-redirect path.
- Ad placements are attempted for real (upload-session → PUT → finalize) and gracefully skipped with one explanatory line — counting only the placements actually left unapplied — when, and only when, the create-session route answers its `502 PROVIDER_ERROR` "R2 not configured" refusal (verified against `apps/cms/src/pages/api/v1/media/news-images/upload-sessions/index.ts`); this repo's local/CI compose stack is exactly such a deployment, so no ad placement is actually created here today, and the moment R2 is configured this step creates all 12 unattended (`sidebar_middle` with the 300x600 creative, matching seputarborneo's half-page `kiri-tengah` slot). Every other media failure — a 400 mime/size refusal, a 403 on the presigned PUT, a 422 or transient 502 from finalize, a network error, a rejected placement POST — is reported per placement and fails the seed, so a real breakage can never hide behind the "no R2 here" message.
- `MACHINE_CREDENTIAL_PERMISSION_KEYS` (the read-only token `apps/storefront`'s build uses) gains the 8 `blog_content`/`seo_distribution`/`site_profile`/`idn_admin_regions` read keys the news surface actually calls — each copied verbatim from its route file's own `authorize` guard, never guessed. Because the machine-credential surface has no "widen scope" verb (only create and `{id}/revoke`), a tenant seeded before this scope grew would otherwise have kept its narrower credential forever and the 403 this issue closes would have stayed open everywhere except a fresh database: the seed now compares the live credential's `allowedPermissionKeys` with its own list and, on a mismatch, revokes and reissues, printing the new token once with an `ACTION REQUIRED` line — the old token fails on its next request, so `AWCMS_API_TOKEN` must be updated wherever the build reads it.
- `resolveKaltengRegions` lists Kalimantan Tengah's regencies/cities with ONE `GET /api/v1/idn-regions/regions?level=2&parentCode=…` request and matches the 14 names in memory, instead of the 14 identical requests it used to issue.
- Found and fixed, for every page/post this script has ever seeded (not narrowly this issue's own): `createBlogPage`/`createBlogPost` always write `status: 'draft'`, and nothing published either past it, so `kebijakan-privasi`/`tos` and BjekMart's own 3 posts were, and would have stayed, invisible to `apps/storefront`'s build. Found and fixed while verifying this issue's own rendering acceptance criteria against a real seeded local CMS.
- Every step is additive to the existing seed and follows the same idempotent `ensure*` posture already established — verified locally with two consecutive `bun run db:seed:cms` runs against a freshly reset/migrated database: the second run reports 0 created for everything this issue adds. `apps/storefront`'s build against this real seeded CMS now renders `/berita` (19 article pages), all 14 Kalteng `/daerah/*` (19 total with the neighbouring Lintas Kalimantan provinces), all 27 `/mitra/*`, `/rubrik/politik`, `/halaman/redaksi`, and 3 `/video/*` pages.

### Exporter from the seputarborneo MariaDB dump to `blog_content`'s legacy-import pipeline

`tools/import-seputarborneo.ts` (`bun run import:seputarborneo`) reads seputarborneo.com's legacy MariaDB archive and writes the input files `apps/cms`'s own operator pipeline for exactly this job expects — `bun run blog:legacy:import` (Issue #599/ADR-0114 in upstream awcms). It makes no network call itself; the actual import runs from inside `apps/cms`, against the same `borneojek-mart` tenant `tools/seed-borneojek-mart.ts` bootstraps.

The **why** is mostly about what an earlier design got wrong: a first pass of this tool called the public HTTP API directly, but no public route can backdate `published_at` for an already-past article or write `legacy_source_id` — `apps/cms`'s own `blog:legacy:import` does both, and was built (per its own docblock) using this exact archive as its reference case. Routing through it also means this exporter does not need its own HTML→Portable Text converter — a second one would diverge from the converter whose refusals the pipeline actually reports and acts on.

- A streaming MariaDB dump reader (`tools/lib/mysql-dump-reader.ts`, unchanged from this issue's first pass) that learns each table's column order from its own `CREATE TABLE` statement — verified necessary against the real dump, whose `berita_vid` schema differs from the reference repo's own migrated fixture.
- The exporter writes `posts.ndjson`/`videos.ndjson` (`legacy-import-record.ts`'s exact field shape), `redirects.json` (built directly from the raw legacy title, correct even for the ~171 rows a naive `{slug}`-templated redirect would get wrong), `term-map-hints.json` (this exporter's own taxonomy classification, as a work aid), and `site-profile.json`.
- One small, deliberate exception to "no HTTP client": `--assign-institutions`, a follow-up pass run after `blog:legacy:import --commit`. That pipeline calls `syncPostTermAssignments` but never `syncPostInstitutionAssignments` (verified directly), so a `DAERAH`/`MITRA BORNEO` article would otherwise import with no institution at all and never reach `/daerah/{slug}`/`/mitra/{slug}` — both this issue's own acceptance criterion.
- Verified end to end against the real 228 MB dump: 25,490 `berita_red` rows read, 25,489 exported, 0 unmapped taxonomy values, 35 `berita_vid` rows exported. The full `blog:legacy:import --commit` run against a live, seeded tenant is deliberately deferred to after issue #57 merges.
- `redirects.json` is shaped by how it is consumed, not by the legacy URLs alone (review round 2 of PR #67): every row carries `origin: "legacy_blog"`, because the storefront's `getLegacyRedirectRows()` serves only that origin and would have silently ignored an `import`-origin row; and a video post's source is a synthetic, query-free `/video/{id}-{slug}.html` rather than the real `/video/?video={id}-{slug}.html`, because the CMS strips a redirect source's query string at write time and every video row would otherwise have collapsed onto one bare `/video` — breaking the import chunk, or redirecting the `/video` list page itself. `apps/storefront/server/pengalihan-aturan.mjs` now indexes that key by id and still answers the real inbound `?video={id}` URL from it.
- `--push-redirects [--commit]` (`tools/lib/redirect-push.ts`): ~51,000 redirect entries against a route capped at 200 per all-or-nothing call is a ~256-call loop, which the first runbook left to `curl` by hand. The exporter now runs it — a whole-file dry run by default, then real chunks each under an `Idempotency-Key` derived from the chunk's content, so a crash mid-run is safe to rerun (committed chunks replay from the CMS's idempotency record). A file-wide duplicate check runs before any call, because the route only detects duplicates within one chunk.

### Storefront ad popup: a native `<dialog>` on creative click

Since issue #47 an ad slot on the news surface renders its creative as a
real `<img>` — 300×250, the slot's own size — inside an anchor straight to
the advertiser. seputarborneo (the site this news surface mirrors) does
something more useful with that click: `js/main.js`'s `initAdPopup()`
opens the creative at full size in a modal, with a clear disclosure and a
deliberate "open the ad" step, so a reader can look at an ad without being
sent off-site by a mis-tap on a small image. Issue #53 ports that
behaviour, dropping the jQuery and the hand-rolled modal the original
needed: the native `<dialog>` already gives focus trapping, `Escape`, an
inert page behind it, and the backdrop.

`apps/storefront/src/scripts/iklan-popup.ts` is mounted once from
`apps/storefront/src/layouts/BeritaLayout.astro` (an external module —
this app's `script-src 'self'` allows nothing inline) and listens for one
delegated click on `.ad-slot [data-iklan-popup]`, so every slot on every
news page — including the sidebar slots issue #49 adds in parallel — is
covered without any page knowing the module exists. The dialog is built on
the first click and reused. `IklanSlot.astro` marks a linked creative's
anchor with `data-iklan-popup`/`data-iklan-nama`/`data-iklan-label` and
nothing else changes there; an UNLINKED creative, which had no anchor to
decorate, now wraps its image in a real `<button type="button">` so the
"no destination" state is reachable by keyboard too.

- A reader who clicks an ad creative sees it at natural size (capped at
  90vw/90vh), the advertiser's name, the disclosure label, and a "Buka
  iklan" CTA to the real destination (`rel="sponsored noopener"`); a
  creative with no destination shows "Iklan ini belum memiliki tautan
  tujuan" and no CTA. ✕, backdrop, and `Escape` close it; focus returns to
  the creative; the page does not scroll underneath.
- No JavaScript, or no `<dialog>` support: the anchor navigates as before.
  A Ctrl/Cmd/Shift/Alt or middle click is left to the browser.
- The CTA never trusts the CMS's `linkUrl` into a new `href` unchecked —
  anything that is not an absolute `http(s)` URL is treated as no
  destination.
- Tests: a Playwright spec through the existing `bun run test:e2e` harness
  (`apps/storefront/tests/e2e/iklan-popup.e2e.ts`) plus DOM-free unit and
  wiring guards (`apps/storefront/tests/iklan-popup.test.ts`). The ad
  fixture gains one unlinked `article_bottom` creative so an article page
  carries both trigger shapes.
- Found, not fixed (outside this issue's files): the preview server
  answers `/berita` and `/video` with the 404 page — `build.format:
  "file"` emits `berita.html` beside the `berita/` directory, and
  `@astrojs/node`'s static handler rewrites a directory-shaped URL to
  `berita/index.html` before `send`'s `.html` fallback runs. Recorded in
  `apps/storefront/README.md`'s "Ad popup" section for follow-up.

### Storefront build no longer floods the CMS with 56 concurrent region requests

`apps/storefront`'s `/index/wilayah-kecamatan-{code}.json` route fetched the
districts of every regency under every configured province in one
`Promise.all` — 56 concurrent `GET /api/v1/idn-regions/regions?level=3` calls
with the default `PUBLIC_WILAYAH_PROVINSI`. `apps/cms` admits at most 40
`interactive` requests at once (8 running + a bounded queue of 32,
`apps/cms/src/lib/database/work-class.ts`) and rejects the rest with a 503, so a
build against a real, seeded CMS failed deterministically with 16
`database.pool.rejected` — while every stub-backed gate stayed green, because
the stub never refuses anything. Found while verifying issue #57 against the
local database (issue #71).

- Every region request in `apps/storefront/src/lib/awcms/wilayah-checkout.ts`
  now passes through one module-level, dependency-free concurrency limiter
  (`MAX_IN_FLIGHT_REGION_REQUESTS` = 6). The bound lives inside the one function
  every request goes through, not in the routes, so no present or future caller
  can fan out past it by forgetting a helper; the routes' `Promise.all` stays,
  fanning out promises rather than requests.
- Why 6: under the CMS's 8 *running* `interactive` slots, not merely under the
  40 it admits — the region walk never queues on an idle CMS and leaves room
  for the rest of the same `astro build` and the CMS's own admin users.
- Fewer, bigger calls were considered and rejected: the route filters
  `parentCode` as an exact match on the direct parent and documents `after`
  only as "the last code of the previous page", so a province-wide level-3
  walk would mean either walking the whole country or inventing cursor
  semantics the API does not promise.
- `apps/storefront/tests/wilayah-checkout.test.ts` asserts the ceiling over the
  real 56-regency fan-out with a mocked client; `apps/storefront/README.md`
  documents the ceiling and the CMS limit it stays under.

### Logo Instansi — an institution's emblem beside the article it filed

Issue #59 (C1), the last of its three steps. seputarborneo.com v2.3.0 lets
an editor attach a regency's emblem to an ARTICLE; here every such article
is already filed under that regency's institution, so the emblem hangs off
the institution instead — upstream awcms#806's `logo_media_id`/`logo_alt`,
carried in by the `apps/cms` subtree pull (step 2, PR #68), resolved
through issue #47's media client.

- `/berita/{slug}` renders the emblem as a float beside the opening
  paragraph, linked to that institution's own page, with no background or
  border (an emblem is nearly always a transparent PNG/SVG — upstream's
  2.3.2 release removed those decorations for the same reason).
- `/mitra/{slug}` shows the same emblem on the institution's landing page,
  which until now rendered only a name, a description and a post list.
- One upload serves every article of that institution and changing it
  updates them all — the property seputarborneo's own "satu logo dipakai
  berulang" rule was after, with one source of truth instead of a per-post
  picker that can disagree with the channel the article is filed under.
- An article with no institution, an institution with no emblem, or a
  stale media id renders nothing at all: no empty frame, no broken image.

Only felt while developing: `RawInstitution.logoMediaId`/`logoAlt` are
OPTIONAL, so a build pointed at an `apps/cms` older than the subtree pull
renders no emblem rather than crashing on a missing property; every
emblem in the list resolves in the same batched `resolveMedia` call the
post images already use.

### Storefront media client: article images, ad creatives, YouTube facade

`apps/storefront` could see that a post, a gallery item, or an ad
placement HAD a photo or a video, but had no way to turn that into a URL —
`apps/storefront/src/lib/awcms/media.ts` had no `media_library` read client
at all, so every image-bearing block degraded to a stated placeholder
(issue #28's own recorded deviation). A reader of the news surface saw
text, never a photo; a video post linked out to YouTube instead of playing
inline; an ad slot showed its name, never its creative.

`apps/storefront/src/lib/awcms/media.ts` batch-resolves a media object id
to its public reference via `GET /api/v1/media/objects` (chunked at 100 ids
per call, memoized per build) and reads the deployment's media origin via
`GET /api/v1/media/public-origin` for the CSP artifact — both newly
verified against `apps/cms`'s own route files rather than guessed from the
issue text. `apps/storefront/src/lib/berita.ts` collects every visible
post's `featuredMediaId` and every gallery item's `mediaObjectId` up front
and resolves them in one batched call; an id that does not resolve
(unverified, deleted, or never uploaded) is logged once and renders as no
image, never a broken `<img>`.

- A news card and an article's hero figure now render a real, sized `<img>`
  (no CLS) with a credit line when the CMS has verified the media's rights.
- A gallery image and an ad creative render as real `<img>`s.
- A `videoNews` block renders a click-to-load facade — a poster image from
  YouTube's own fixed CDN convention, swapped for a real
  `youtube-nocookie.com` `<iframe>` only after a genuine click
  (`apps/storefront/src/scripts/video-facade.ts`) — never a third-party
  frame/script before that.
- `apps/storefront/src/pages/csp.json.ts` widens `img-src` with the
  resolved media origin and, only when this build has a video post,
  `img-src`/`frame-src` with the two YouTube origins the facade needs.
- The storefront build credential's permission set
  (`tools/seed-borneojek-mart.ts`) gains `media_library.media.read`.

**Known cross-PR dependency:** `apps/storefront/server/penyaji.mjs`'s
`buildCsp` (a sibling issue this wave, not this change) does not yet read
the CSP artifact's new `frameSrc` field — until it does, a real deployment
still serves `frame-src 'none'` and the facade's `<iframe>` will not load,
even though every other piece (the resolved images, the artifact itself)
already works. The artifact change is additive and does not regress an
older reader.

### `apps/storefront`: news chrome — primary nav, Daerah panel, ticker, utility bar, footer directory, footer leaderboard slot, back-to-top

Every news-surface page (`/berita`, `/rubrik/*`, `/daerah/*`, `/mitra/*`,
`/video`, `/tag/*`, `/penulis/*`, `/arsip/*`, `/cari-berita`) rendered the
STORE's commerce header/footer — product nav, a cart badge, a wishlist link —
because `BeritaLayout.astro` only ever wrapped `BaseLayout.astro` and added a
stylesheet. A reader landing on a news article saw "Keranjang"/"Wishlist" in
the header and a commerce footer with no way back into the news section's own
taxonomy. This closes issue #48 (increment 3, epic #46), porting
seputarborneo.com v2.4.0's own header/nav/footer patterns — not its PHP —
onto this app's real, live CMS data.

- `BaseLayout.astro` gained two named slots (`header`/`footer`, defaulting to
  the store's `Header`/`Footer` — every non-news page's rendered HTML is
  unaffected) so `BeritaLayout.astro` can keep wrapping it and fill those
  slots with the news chrome instead, while `<head>` and `<main id="konten">`
  stay the ONE shared implementation every page gets — no duplicated
  `<head>`, so issue #54's OG/Twitter meta and issue #56's analytics beacon
  (both landing in `BaseLayout.astro`) reach news pages automatically.
- The utility bar (`BilahUtilitas.astro`): today's WIB date, the editorial
  e-mail, the Redaksi/Pedoman Media Siber/Disclaimer links (rendered only
  when actually published), and official-account social icons — Facebook, X,
  Instagram, TikTok, YouTube, Threads — detected by URL host
  (`apps/storefront/src/lib/ikon-sosial.ts`), with an independent `http(s)`-only guard even
  though the CMS already filters at the source.
- The primary nav (`NavBerita.astro`, data from `apps/storefront/src/lib/navigasi-berita.ts`):
  Beranda · Politik · Hukum · Nasional · Olah Raga · Wisata · Daerah · Video —
  a rubrik missing from this build's taxonomy is omitted, never a dead link.
  The Daerah panel (14 Kalteng regencies/cities with an institution) is
  always fully server-rendered, with no `hidden` attribute in the initial
  HTML — a `<script>` only ever ADDS `hidden` at runtime, and only when the
  reader is not already on a `/daerah/*` page; `Escape` closes it and returns
  focus to the toggle.
- The "Terkini" ticker (`Ticker.astro`): the 3 latest post titles, as a plain
  static list — no auto-scrolling marquee, so there is no motion for
  `prefers-reduced-motion` to need to disable in the first place.
- The footer (`FooterBerita.astro`): brand/contact, Rubrik, Umum, and Daerah
  columns, the full Mitra Borneo institution directory ordered
  Pemprov/DPRD Kalteng first then per regency, a `<slot name="buletin" />`
  for issue #50's newsletter form, the legal bar, and a leaderboard
  (`<IklanSlot placement="homepage_bottom">`, decision 4 of epic #46 — reuses
  the existing placement key rather than inventing one) rendered above the
  footer. Back-to-top is a real, always-present `<a href="#atas">` — CSS
  hides it until scrolled, but `:focus-visible` reveals it for keyboard users
  regardless of scroll position.
- The masthead logo stays a text wordmark this wave — this app has no
  media-object client yet (issue #47 adds one for article images only); a
  `TODO` in `NavBerita.astro` marks where a future issue resolves
  `identity.logoMediaId` to an `<img>`.
- Today's date in the utility bar is rendered CLIENT-SIDE (a `<script>` fills
  `#bilah-tanggal` on load), never at build time — `apps/storefront` is a
  static build, so a value read from `new Date()` in frontmatter would freeze
  at whatever moment `astro build` ran and mislabel every later day as
  "today" until the next deploy.
- `daerahOrderIndex` (`apps/storefront/src/lib/navigasi-berita.ts`) strips a
  leading "Kota "/"Kabupaten " before comparing a region's name against the
  canonical order — the live `idn_admin_regions` dataset's own `name` column
  carries that term ("KOTA PALANGKA RAYA"), which a bare match against
  `DAERAH_URUTAN`'s un-prefixed names would never match, sorting Palangka
  Raya (and its institutions) last instead of first.

No page outside `apps/storefront` changed except `BaseLayout.astro`'s
two-line slot addition above, and no `apps/cms` endpoint shape is new —
every field this issue reads was already verified against a route file by
earlier issues (`src/lib/awcms/{blog,wilayah,pages,profil}.ts`).

### Shared news sidebar, homepage ad slots in seputarborneo's order, a real "Terpopuler" (issue #49)

Until now only `/berita` had a sidebar — an inline `<aside>` from issue #28
with a "Terpopuler" that was really "latest", one of the CMS's three sidebar
ad slots, and a tag cloud — and every other news page (article, video,
rubrik, tag, author, archive, search) had no side column at all. The site
this platform replaces (seputarborneo.com) renders one shared sidebar on
every one of those pages, and its own `include/sidebar.php` exists precisely
because the copy-pasted per-page versions before it had drifted. Two of the
three sidebar ad positions the CMS already models (`sidebar_middle`,
`sidebar_bottom`) and two of the three homepage positions (`homepage_middle`,
and `homepage_bottom` in its in-page position) had no surface to render on,
and issue #50's newsletter form existed but was mounted nowhere a reader
would find it.

- `Sidebar.astro` — one component, rendered by `/berita`, `/berita/{slug}`,
  `/video`, `/video/{slug}`, `/rubrik/**`, `/tag/{slug}`, `/penulis/{slug}`,
  `/arsip/{yyyy}/{mm}` and `/cari-berita`, in seputarborneo's order: the
  tabbed **Terbaru / Mitra Borneo** list (the real WAI-ARIA tabs pattern,
  BOTH panels in the HTML, the first shown with no JavaScript), `sidebar_top`,
  **Terpopuler**, the 24-institution Mitra Borneo directory, `sidebar_middle`,
  the newsletter box (`FormBuletin variant="sidebar"`), `sidebar_bottom`, the
  tag cloud. Every slot renders nothing when nothing is booked.
- `/berita`'s homepage slots now follow seputarborneo `index.php`'s order:
  `below_headline` after the headline, `homepage_middle` after the first
  three rubrik sections, `homepage_bottom` after the rest and before the
  video strip. `homepage_bottom` is also the key the footer leaderboard
  (issue #48) reuses — so on `/berita` that creative renders twice, a
  deliberate consequence of the issue's mapping, recorded rather than hidden,
  because a dedicated footer key is an upstream `blog_content` change.
- A top-level rubrik's front-page section now includes posts filed under
  any of its DESCENDANT rubrik — the same walk `/rubrik/{slug}` has always
  done. Surfaced by this change: a post filed straight into a grandchild
  rubrik (Hukum > Pidana) used to reach the front page only through the old
  aside's "Terpopuler" cards, so replacing that aside would otherwise have
  dropped it from `/berita` entirely.
- **"Terpopuler" is ranked from real readership.** A new
  `apps/storefront/src/lib/awcms/analitik.ts` reads `GET /api/v1/analytics/pages?range=7d`
  (route, query, `visitor_analytics.dashboard.read` permission and
  `{ range, pages: [{ name, count }] }` envelope all verified against the
  route file, not the issue text), folds every query-string variant of one
  post's `path_sanitized` into one count — that column keeps every
  non-sensitive parameter, so `/berita/x` and `/berita/x?utm_source=…` are
  separate rows the naive reading would split a post's readership across —
  ranks every post by it, and tops up with the newest posts. A 403/404
  (module off — it is off by default — permission missing, older CMS) or an
  empty answer degrades silently to exactly the pre-#49 "latest" list; the
  fallback is stated in code, never as a caveat in the UI, because a caveat
  there describes the deployment's configuration, not the news. The route
  returns the tenant-wide top 50 paths with no limit parameter, so a post
  ranked 51st or lower overall is invisible to the ranking and loses to a
  zero-view top-up post — documented, not worked around. The permission is
  added by name to the seed's storefront token set — **which changes the
  credential's scope: the seed's scope-reconcile (issue #57) revokes and
  reissues the live storefront credential on its next run against an
  already-seeded tenant, and a build still holding the previous
  `AWCMS_API_TOKEN` gets `401` until it is given the newly printed one.**
- **The newsletter form is mounted in the footer of every news page AND in
  the sidebar's box** — two forms on most news pages, as seputarborneo has.
  That exposed a defect in issue #50's `apps/storefront/src/scripts/buletin.ts`:
  it wired the FIRST `[data-buletin-form]` only, so the footer form (second
  in DOM order) would have submitted nowhere — a bare `<form>` GETs the
  reader's e-mail into the page's own URL. `wireBuletinForms(root)` now
  wires every form with its own closure (no shared mutable state), takes
  its root as a parameter, and is covered by a two-forms-on-one-document
  unit test with a hand-rolled fake DOM (`apps/storefront/tests/buletin-forms.test.ts`).
  The footer's own form CSS (`berita-chrome.css`, written before the form
  existed) is stacked instead of a single flex row, so the consent sentence
  no longer sits beside the input.
- Stub + fixture for the analytics endpoint (with the real route's `range`
  validation in front of it); `ad-placements-active.json` now books every
  sidebar and homepage slot, and leaves `article_top`/`article_bottom` empty
  so the build proves "no empty box" too. `apps/storefront/tests/analitik-terpopuler.test.ts`
  covers the mapping, ranking, fallback and the fetch's degrade rules;
  `apps/storefront/tests/sidebar-build-smoke.test.ts` asserts on the built HTML that the
  sidebar is byte-identical across page families, both tab panels ship, all
  six slots render in order, Terpopuler is ranked by the fixture, and a
  sidebar page carries both newsletter forms with distinct ids. The
  now-unused `getTerpopuler()` in `apps/storefront/src/lib/berita.ts` is removed.

### Storefront newsletter subscribe form and double opt-in pages (issue #50)

`apps/cms`'s `newsletter` module — an `awcms` module, ADR-0103 in
`ahliweb/awcms`'s own decision log — has shipped anonymous double opt-in
endpoints (`/api/v1/newsletter/{subscribe,confirm,unsubscribe}`) since
increment 2, and the legacy seputarborneo site this platform replaces
had a live subscribe form and admin screen — but this storefront had zero
way for a reader to actually join a list. Migrating without this would be a
functional regression against the site being replaced, not just a missing
nice-to-have.

- `FormBuletin.astro` (`variant: "footer" | "sidebar"`) — an accessible
  subscribe form: labelled e-mail field, a sentence naming double opt-in
  explicitly (PRD §30 forbids a pre-ticked/implied consent), a client-side-
  only honeypot, and an `aria-live="polite"` status region. Not mounted
  anywhere yet — placing it in the site chrome is a separate, parallel
  change (issue #46's A3), so the two changes never touch the same shared
  file at once.
- `apps/storefront/src/scripts/buletin.ts` — the browser-side client, calling the CMS's
  anonymous `/api/v1/newsletter/*` directly (cross-origin, credential-free,
  `PUBLIC_AWCMS_ORIGIN`, the same pattern `toko-klien.ts` established for
  cart/checkout in issue #30) and translating every documented outcome into
  Indonesian copy — the CMS's own response text is English by design (a
  neutral body shared with `awcms-astro`'s deployments) and is never shown
  to a reader verbatim.
- Three pages: `/buletin` (a standalone page for links from an e-mail/social
  post), `/newsletter/confirm`, `/newsletter/unsubscribe` (read `?token=`,
  call confirm/unsubscribe, `noindex, follow`). The two token pages sit at a
  CMS-imposed path, not this app's own naming: `apps/cms/src/modules/
  newsletter/domain/newsletter-mail.ts` bakes every confirmation/unsubscribe
  e-mail from the fixed, non-configurable constants
  `NEWSLETTER_CONFIRM_PATH`/`NEWSLETTER_UNSUBSCRIBE_PATH`, and its own
  `subscribe.ts` docblock says the public site in front of the CMS (this
  storefront) is expected to serve exactly those paths — so this app honours
  that contract directly rather than adding a redirect layer in front of a
  storefront-chosen URL. `apps/storefront/tests/newsletter-path-contract.test.ts`
  guards the two path strings, by file existence and without importing anything from
  `apps/cms`, against a future upstream rename. `robots.txt` disallows the
  two token pages, matching `/pesanan`'s existing precedent for a URL that
  carries a one-time, reader-specific credential.
- No CSP change: the newsletter endpoints live on the same CMS origin
  cart/checkout already call, and `connect-src` is already keyed by that
  whole origin, not by path.
- Documented, not shipped here (an operator action, not code): the CMS only
  composes a confirmation/unsubscribe link pointing at THIS storefront's
  origin — and only grants the CORS access the subscribe form needs at all —
  once that origin is registered and verified in `awcms_tenant_domains`
  (`POST /api/v1/tenant/domains` + `POST .../{id}/verify`). See
  `apps/storefront/README.md`'s "Newsletter" section.

Four fixes from review, all in `apps/storefront/src/scripts/buletin.ts`:

- The subscribe form now runs `checkValidity()`/`reportValidity()` before
  ever calling `fetch()` (the same pattern `checkout.ts` already uses) — a
  malformed address used to reach the network and come back as a CORS-
  opaque failure the reader saw as "could not reach the server".
- `VALIDATION_ERROR`/`RATE_LIMITED` are real route behaviour but effectively
  unreachable from this app's actual, cross-origin deployment (the CMS
  answers both BEFORE classifying `Origin`, with no CORS grant on either —
  the browser's `fetch()` rejects before the body is ever read, landing in
  `NETWORK_ERROR` instead). `NETWORK_ERROR`'s copy no longer asserts a
  connectivity cause, is worded differently for the subscribe form (an
  e-mail address to check) vs. the two token pages (a link to check, no
  address field to point at), and the two now-corrected docblocks say
  plainly that a reader on this app's real deployment will see
  `NETWORK_ERROR`'s message for what is very often really a bad address, not
  a dropped connection.
- `/newsletter/confirm` and `/newsletter/unsubscribe` no longer fire their
  state-changing `POST` on page load. A mail gateway's inbound link-scanner
  routinely fetches and fully renders — executes JS on — every link in an
  incoming e-mail before the reader sees it; an eager POST let the SCANNER
  confirm the subscription or unsubscribe the reader, not a choice the
  reader made. Both pages now ship an inert, `hidden` button in their static
  HTML that `buletin.ts` unhides and wires to a `click` handler only once a
  well-formed token is confirmed present.
- `RATE_LIMITED`'s wait is now read from the response's `Retry-After`
  HEADER. The CMS's own `fail(429, ...)` call never populates
  `error.details` — the wait travels as a header — so the previous
  `details.retryAfter` read always evaluated to `null` in production.

### Storefront link previews: `og:image`, `article:*`, `video.other`, Twitter cards, `rel=prev/next`

A news article or video shared from `apps/storefront` previewed as a bare
title-and-description card on WhatsApp, Facebook, X and Telegram — no
picture, no date — because `BaseLayout.astro` rendered one fixed
six-tag Open Graph block for every page and had no way for a page to add
a `<meta>` of its own. Issue #28 recorded the gap twice (the article
docblock, `docs/seo.md`'s "Not built"); issue #47 then made the picture
AVAILABLE (`PostDetail.image`, `post.video`) without a tag to put it in.
For a news site, the share card IS the front page most readers see first,
so this is a reach problem, not a polish one.

`BaseLayout.astro` now takes two optional props — `ogType` (`website`
default, `article`, `video.other`) and `meta` (a typed list of
`property=`/`name=` + `content=` pairs, rendered one `<meta>` each after
the fixed block). Both default to "render exactly what rendered before",
so no store page's `<head>` changed — a build-smoke test holds
`/`, `/produk`, `/kategori/{slug}`, `/product/{slug}` and `/halaman/{slug}`
to a frozen snapshot of the pre-change block. `apps/storefront/src/lib/meta-sosial.ts`
builds the tags as plain data, one builder per `og:type`, so a page cannot
pair one type's `og:type` with another type's namespace (Open Graph
silently drops `article:*` under `video.other` — a mistake that would
never fail a build).

- `/berita/{slug}`: `og:type=article`, `og:image` + width/height/alt when
  the featured image resolved, `article:published_time`/`modified_time`
  (the same ISO timestamps the `NewsArticle` JSON-LD already carries),
  `article:section`, one `article:tag` per tag, and a Twitter card
  (`summary_large_image` with an image, `summary` without).
- `/video/{slug}`: `og:type=video.other`, `og:image` = the post's own
  featured image or else the same `hqdefault.jpg` YouTube poster the card
  and the facade already load (featured-first, like the card thumbnail;
  never `maxresdefault`, which YouTube 404s for SD-only uploads and would
  leave a `summary_large_image` card empty), `og:video:url` = the
  identical `youtube-nocookie.com/embed/{id}` the click-to-load facade
  loads, `video:release_date`/`video:tag`.
- News listing pages (`/berita`, rubrik/daerah/mitra/tag/penulis/arsip,
  `/video`): the site logo as `og:image` when `identity.logoMediaId`
  resolves through the issue-#47 media client — applied once in
  `BeritaLayout.astro`, deliberately not in `BaseLayout.astro`, which is
  what keeps the store pages provably unchanged. An unresolved logo emits
  nothing.
- `/rubrik/{slug}` and `/rubrik/{slug}/halaman/{n}`: `<link rel="prev">`/
  `<link rel="next">` through the layout's `head` slot; page 2's `prev` is
  the bare rubrik URL, never `/halaman/1`.
- Every `content` value reaches the page only through Astro's attribute
  escaping at the one render boundary — `jsonForScript()` stays reserved
  for the JSON-LD script block, where its JSON escapes are the right ones.
- `docs/seo.md` (and its mirror) gains an "Open Graph and Twitter Card by
  page type" section and a truthful "Not built"; the article page's
  docblock no longer claims either gap.

### "Dengarkan berita ini" — the article read-aloud player

Issue #52. Every article page (never a video post — there is nothing to
read aloud beside a video the reader is already watching) now offers a
player that reads the headline and the body with the READER'S OWN device
voice: `window.speechSynthesis`, `lang = "id-ID"`. No API key, no audio
file built or stored, no request leaving the page — the article text never
travels anywhere except into the browser's own speech engine. Ported from
seputarborneo.com v2.4.0's own player and the contract its `AGENTS.md`
records.

- A reader can play/pause, skip to the previous or next section, stop,
  choose a speaking rate (0.75×–1.5×) and, on a device with more than one
  Indonesian voice, pick the voice. Rate and voice are remembered for the
  next visit.
- The section being read is outlined in the article as it is spoken. The
  highlight is an `outline`/`box-shadow`, never a background or border, so
  the article does not shift under the reader mid-sentence.
- The card is ALWAYS rendered with `hidden`; the script reveals it only
  when the browser really has `speechSynthesis` AND the device has a voice.
  A browser without the API, or a reader with JavaScript off, sees nothing
  at all rather than a dead control.
- Photo captions, credits, embeds and ad slots inside the article body are
  skipped — an advertiser's name read out mid-sentence is worse than
  silence.

Only felt while developing: speech is split per sentence (Chrome cuts an
utterance off after ~15 seconds) while the highlight stays per block; the
`data-dengar-*` attribute names are a three-sided contract between
`apps/storefront/src/components/berita/PemutarDengar.astro`, `apps/storefront/src/styles/dengar.css` and `apps/storefront/src/scripts/dengar.ts`,
listed in the component's own docblock.

### `/berita`, `/video` and every `/rubrik/{slug}` answered 404 on the served site

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

### Storefront article share row — FB/X/WhatsApp/Threads, Instagram via Web Share, TikTok/YouTube follow (issue #51)

Every article and video page (`/berita/{slug}`, `/video/{slug}`) used to end
with two text links — "Bagikan ke WhatsApp" and "Bagikan ke Facebook". The
legacy seputarborneo site this news surface replaces ships a seven-control
row (its `sb_bagikan()`, issues #61/#67 there), and its own working
contract insists the row is THREE kinds of control that must not be
conflated: platforms with a real web share URL, one platform (Instagram)
with none at all that is still a share action, and two (TikTok, YouTube)
with none that are FOLLOW links to the site's own accounts. Inventing a
share URL for the last three — the obvious shortcut — is exactly what that
contract forbids, because there is no such URL to invent. This change ports
the row with that distinction intact.

- `apps/storefront/src/components/berita/BarisBagikan.astro` replaces the
  old block in `ArtikelView.astro` (the only edit to that file — an import,
  the component, and the now-dead `encodedTitle` constant removed).
  Facebook, X, WhatsApp and Threads are plain `<a rel="noopener nofollow">`
  intent links that need no JavaScript; TikTok/YouTube are
  `<a rel="noopener me">` follow links rendered only when
  `identity.socialLinks` actually carries one; Instagram is a real
  `<button>`. Every control has a full accessible name that names the verb
  ("Bagikan ke Facebook" vs "Ikuti kami di TikTok") and a 44×44 target.
- `apps/storefront/src/lib/bagikan.ts` (build-time, pure) — the four URL
  builders (title and URL each `encodeURIComponent`-ed; Facebook's sharer
  takes only `u=` and reads the title from the page's own OG tags) and the
  follow-link resolver, which goes through issue #48's
  `apps/storefront/src/lib/ikon-sosial.ts` rather than a second filter: the same
  `http(s)`-only scheme check that closes the stored-XSS hole an
  admin-typed `javascript:` URL would open, and the same hostname-based
  platform detection, so an editor's "TikTok" label on a non-TikTok URL is
  not believed. WhatsApp's SVG path is the one glyph this row adds; every
  other icon is `ikon-sosial.ts`'s.
- `apps/storefront/src/scripts/bagikan.ts` (browser, an external module —
  the CSP's `script-src 'self'` has no `'unsafe-inline'`) — the Instagram
  flow: `navigator.share({ title, url })` first, a dismissed share sheet
  stays silent, any other failure or no Web Share API falls through to
  `navigator.clipboard.writeText(url)` with a visible "Tautan disalin…"
  status in a `role="status"`/`aria-live="polite"` region. That region
  ships EMPTY in the static HTML rather than being created on first click
  as upstream does — a live region that is created and filled in the same
  tick is announced by some screen readers and skipped by others. A denied
  or unavailable clipboard ends in a visible failure message; upstream's
  `execCommand("copy")`/`window.prompt()` last resorts were deliberately
  not ported (deprecated, and a blocking prompt is the interruption an
  `aria-live` status exists to avoid).
- The Instagram button ships `hidden` and the script reveals it once its
  handler is attached: it has nothing to do without JavaScript (no share
  URL exists to fall back to), and a control that does nothing must not be
  offered. It never reads `identity.socialLinks` — the reader shares to
  THEIR Instagram; that needs no account of ours.
- No third-party script (no Facebook SDK, no Twitter widgets, no embed.js)
  — `apps/storefront/tests/bagikan.test.ts` greps every file under `src/` for their hosts,
  and `apps/storefront/tests/bagikan-build-smoke.test.ts` builds against the stub and
  asserts the rendered row (and the follow links' correct ABSENCE, given
  the fixture profile has no TikTok/YouTube) on a real article page and the
  video page.
- `apps/storefront/src/styles/bagikan.css` is a new, component-imported
  stylesheet; `apps/storefront/src/styles/berita.css` is untouched (its `.article-share`
  rules are now unused — a follow-up cleanup once this wave's concurrent
  edits to the article templates have landed).

### Storefront visitor beacon + optional GA4 (issue #56, A10)

`apps/storefront` sent no telemetry of any kind — the seputarborneo
reference this epic re-platforms from loads GA4 on every page and runs its
own per-IP-per-day counter; this repository's `apps/cms` already carries a
privacy-first, off-by-default `visitor_analytics` module with a public
ingest endpoint (`POST /api/v1/analytics/collect`) that nothing called it.
Without this change, A3's "Terpopuler" section (the module's rollups) would
have nothing real to read once it lands, and there was no way to add GA4
for an operator who wants it alongside.

- `apps/storefront/src/scripts/analitik.ts` — a first-party, privacy-
  respecting page-view beacon mounted on every page. It sends exactly
  `{ tenantCode, path, referrer? }`, verified against the route and its
  module's README rather than guessed, and honours Do Not Track/Global
  Privacy Control by not sending at all.
- **Scope correction, recorded rather than silently followed:** the issue's
  own Scope bullet named `navigator.sendBeacon` (fallback `fetch keepalive`).
  That is backwards for this specific endpoint — `sendBeacon`'s payload
  cannot carry the `content-type: application/json` header the endpoint
  requires cross-origin, a fact `apps/cms`'s own
  `visitor-analytics/domain/beacon-cors.ts` docblock already tested and
  documents. `fetch` with an explicit JSON content-type, `credentials:
  "include"`, and `keepalive: true` is what is actually sent; `sendBeacon`
  is never called. There is also no "viewport class" field in the route's
  validated schema, so none is invented.
- GA4 (`PUBLIC_GA_ID`, optional, off by default) — `BaseLayout.astro` loads
  `gtag.js` only when a real GA4 Measurement ID is configured, and
  `csp.json.ts`/`apps/storefront/server/penyaji.mjs` widen the served CSP's `script-src`/
  `connect-src` for GA's own fixed origins only then. The `dataLayer`/`gtag`
  bootstrap Google's own snippet normally inlines is instead
  `apps/storefront/src/scripts/ga-init.ts`, an ordinary same-origin bundled module — an
  inline `<script>` body is blocked by this app's strict CSP regardless of
  what `script-src` allows, and this static site has no per-request value to
  mint a CSP nonce from.
- Documented: `apps/storefront/.env.example`, `apps/storefront/README.md`,
  and `docs/deployment.md` (+ `.id.md`) gain "the two switches" a deployer
  needs — `apps/cms`'s own `VISITOR_ANALYTICS_ENABLED` (whether anything is
  actually recorded) and `apps/storefront`'s `PUBLIC_GA_ID` (whether GA4 is
  additionally on) — independent of each other, both off by default.

### Sync `apps/cms` from upstream `ahliweb/awcms` — institution logo, SVG safety scan

`git subtree pull --prefix=apps/cms awcms main`, merged with a merge commit
(the one rule AGENTS.md protects every future sync with), bringing
`apps/cms` from the v10.3.0 embed point (`749404d4`) to upstream `main`
`4e049743` — awcms PR #807, opened for awcms-one issue #59 (C1, "Logo
Instansi").

- `awcms_blog_institutions` gains `logo_media_id`/`logo_alt` (`sql/153`),
  exposed as `logoMediaId`/`logoAlt` on `/api/v1/blog/institutions`; the
  storefront renders it in issue #59's step 3.
- `media_library` now recognises SVG uploads at all (its sniffer never
  matched SVG's shape before) and scans them with a denylist — script
  elements, event handlers, `javascript:`/`data:` URIs after
  character-reference decoding, any `<!ENTITY` declaration.
- Upstream's `js-yaml`/`smol-toml`/`svgo` override bumps ride along.

Only felt while developing:

- The seven generated-document conflicts (`repo-inventory.md`,
  `PROJECT_STATE.*`, `ARCHITECTURE.*`, `.claude/skills/README.*`) were
  resolved by keeping this repo's copy and re-running upstream's generators,
  exactly as AGENTS.md's divergence rule prescribes; `prettier --write` on
  the regenerated tables and on `commerce/README.id.md` was needed for
  `bun run lint`.
- `sql/153_awcms_blog_institution_logo.sql` (upstream) now sits beside this
  repo's `sql/153_awcms_commerce_schema.sql`. The migration runner keys by
  full filename and applies both in lexical order, so nothing breaks — but
  every upstream migration from here on will share a number with a commerce
  one until the commerce migrations move out of upstream's range, which is
  tracked as a follow-up issue.

## [0.3.0] — 2026-09-17

### `bun run check:cms` is green again inside the subtree embed

`apps/cms/tests/version-check.test.ts` asserted that more than 20 git tags were examined — true in a clone of `ahliweb/awcms`, false by construction here, where `git tag` answers with this repo's own `v0.x` line and upstream's tags are deliberately never fetched. The whole CMS gate chain was red on a clean `main` because of it (issue #22).

- The non-vacuity floor is skipped only when `apps/cms` is embedded inside a larger repository; the namespace-conformance and version-not-behind assertions still run.
- `AGENTS.md` now carries a "known local divergences" list under the subtree section, so the next `git subtree pull` conflict on this file is expected rather than a surprise.

### Commerce transactional surface: customers, addresses, orders, payment confirmations, reviews

The transactional half of mart.borneojek.com — customers, addresses, cart quoting, orders and their lifecycle, payment confirmations, reviews (issue #29, epic #21) — plus the **anonymous, cross-origin storefront API** a statically built site calls from the browser with no bearer token, the same pattern already hardened for newsletter/site-search/comments.

- Eight new tables `awcms_commerce_{customers,customer_addresses,orders,order_items,order_events,payment_confirmations,reviews,wishlists}` (`sql/165`–`167`), 7 new permissions (`orders`/`customers`: `read`/`update` only — no admin route creates or hard-deletes either; `reviews`: `read`/`update`/`delete`), 7 new domain events (`order.{created,paid,status_changed,cancelled,expired}`, `voucher.redeemed`, `review.published`), one new scheduled job (`commerce:orders:expire`), 3 new admin screens.
- `domain/cart-quote.ts` composes #23's price calculation and #26's voucher arithmetic in the exact order the storefront contract specifies: subtotal → voucher discount → shipping (zeroed by voucher or store threshold) → insurance (`max(minFee, subtotal × ratePercent)`) → tax (percent of subtotal − discount) → total — every figure a `numeric(14,2)` string, integer-cent arithmetic throughout.
- Anonymous routes under `/api/v1/commerce/storefront/*`: cart quote, order creation (idempotent by a client-supplied key, re-quoting the cart inside the write transaction), order tracking (`orderCode` + phone as the credential, checked inside the query — an unknown code, a wrong phone, and another tenant's order all answer the same neutral 404), payment confirmations, cancel, reviews. Tenant is resolved from the request Origin/Host through `awcms_tenant_domains`, never a caller-supplied header.
- Idempotency reuses the shared `awcms_idempotency_keys` store (it needs only a tenant id, not a principal) rather than a bespoke column. Payment-proof upload answers `503 MEDIA_UNAVAILABLE` in this increment — the existing upload-session flow requires an authenticated principal a guest checkout does not have, and building a second, unreviewed anonymous auth seam for it was judged out of scope; a payment confirmation without a proof image is still fully accepted, and the public store-settings read model now says `payment.proofUpload: false` so the storefront hides the control.
- Customers are guest-checkout rows identified by phone (E.164, kept in the clear — it is also the tracking credential) — real personal data, but not addressable by this codebase's own ADR-0094 subject vocabulary (`tenant_user`/`identity`/`profile`), since there is no account behind a phone number yet (accounts are issue #32). All eight new tables are therefore `unreachableBySubject: true`, the same shape `commerce.testimonials` already uses for free-text personal data with no subject-id column — a genuine erasure/export request is handled as an ordinary admin lookup, outside the automated engine's scope by construction.
- `tools/seed-borneojek-mart.ts` registers the tenant's storefront origins in `awcms_tenant_domains` (manually attested `active`, the one place this script reaches Postgres directly instead of through HTTP — a fresh domain otherwise starts `pending_verification` and this script has no real DNS record to prove) and seeds one customer with two orders in different states (`pending_payment`, `paid`) through the anonymous order-creation path itself.

### Commerce marketing surface: flash sales, vouchers, sliders, testimonials, promo popup, store settings

Everything mart.borneojek.com's home page and promotions run on, as tenant-scoped tables in the one `commerce` module (issue #26, epic #21) — with a public read model per family that `apps/storefront` bakes the home page from, and six admin screens.

Why one module rather than three (the decision is recorded by issue #31, https://github.com/ahliweb/awcms-one/issues/31): every admission touches the same shared registries, and an order references products, flash-sale prices and vouchers as one aggregate.

- New tables `awcms_commerce_{flash_sales,flash_sale_products,vouchers,sliders,testimonials,popups,store_settings}` (`sql/161`–`164`), 22 new permissions, two flash-sale events fired by the `commerce:flash-sales:tick` job, 20 new OpenAPI operations.
- Voucher arithmetic is exact (integer cents, `maxDiscount` cap); `POST …/vouchers/validate` is a read — redemption belongs to the order (#29). Flash-sale status is derived from the window and persisted by the tick, never trusted from the column. At most one active popup per tenant, enforced by a partial unique index.
- Store settings are one versioned `jsonb` document per tenant; the public read model never carries a bank account number, holder, or QRIS reference. `DELETE` resets to defaults by stamping `deleted_at`, which is also what lets the singleton answer the retention question with a column rather than an exemption.
- Two #23 follow-ups: `downloadLink` (a digital product's paid asset) leaves the public product DTO for the admin record; `sizeChartImageUrl` joins it.
- Two latent defects found while proving the seed end to end: batch reads of images/variants bound a JS array straight into `= ANY(…)` (fails on two or more ids — now `tx.array(…)::uuid[]`, with a regression test); and `Bun.SQL` decodes a stored `0.00` as `"0"` through a parameterised query — every money field now passes through `normalizeMoney` so the wire shape is always two decimals.
- `tools/seed-borneojek-mart.ts` applies the #23 product fields and variants, seeds one flash sale, two vouchers, three testimonials, one popup and the live store-settings block (bank account a placeholder), and issues the storefront build credential with every marketing `read`. Product images and sliders stay recorded under `future`: both need a media object, and media objects need the R2-backed upload session.

### `commerce` reaches full BjekMart product-model parity

Issue #23 (part of epic #21) brings `apps/cms`'s `commerce` module from Issue #4's
13-column catalog core to the full legacy `commerce_bj_mart.products` shape, and
gives it the two related tables a real product page cannot render without.

- `awcms_commerce_products` gains every column Issue #4 deliberately deferred:
  tiered pricing (`price_level_2/3/4`), admin-only `cost_price`, weight,
  minimum purchase, manual rating/sold-count, insurance, promo banners, a size
  chart (image or table), a service intake form, subscription period, a
  digital download link, deposit/free-shipping flags, variant attributes, and
  explicit `is_featured`/`is_recommended` merchandising flags.
- Two new tables, `awcms_commerce_product_images` and
  `awcms_commerce_product_variants`, with their own CRUD routes under
  `/api/v1/commerce/products/{id}/{images,variants}`. `commerce` now depends
  on `media_library` so a product image's public URL resolves through
  `MediaLibraryPort`, the same capability `blog_content` already consumes.
- `GET /api/v1/commerce/products` gains `?categoryId=&status=&q=&sort=&
  featured=&recommended=` filters; every product response carries a
  server-computed `finalPrice` (exact integer-cents arithmetic, never a
  float) plus resolved `images[]`/`variants[]`. A new
  `GET .../products/by-slug/{slug}` route serves the storefront's detail
  fetch. `GET /api/v1/commerce/categories` gains `?parentId=` and a computed
  `productCount` per row.
- Restore endpoints for both categories and products
  (`POST .../{id}/restore`), the shape `office-directory.ts` already
  established, with a new `restore` permission on both activity codes.
- `/admin/commerce` is now a full product CRUD screen (filters, create/edit,
  an images picker sourced from the media registry, a variants editor,
  status transition, soft delete, restore); `/admin/commerce-categories` is
  a new category CRUD screen. Both are off `NOT_YET_SCREENED`.
- `packages/kontrak` re-exports the four new unions (`SizeChartType`,
  `SubscriptionPeriod`, `ServiceFormFieldType`, `ProductSort`) from
  `apps/cms`'s `domain/*.ts`, type-only, per ADR-0004.

Deliberate scope decisions, recorded here for #31 to fold into the schema/API
docs:

- `awcms_commerce_categories` also gained a `restored_at` column (the issue's
  own column table only listed it for products) — both restore endpoints need
  the same "when" fact, and this module's README already treats
  `awcms_offices`' restore shape as the precedent for both tables alike.
- Keyset pagination (`cursor`/`nextCursor`) stays scoped to the default
  `sort=newest`; `price_asc`/`price_desc`/`name` return a single bounded page
  (`PRODUCT_LIST_LIMIT` = 100, `nextCursor: null`) rather than a keyset walk
  ordered by a second column.
- `sizeChartMediaId`/a variant's `imageMediaObjectId` are validated as
  UUID-shaped only, not checked for live/verified existence — unlike a
  product IMAGE row's `mediaObjectId`, which is the one write path this issue
  checks against `MediaLibraryPort.isMediaReferenceSafe` before insert. A
  stale/foreign id in either scalar field simply resolves to no public URL at
  render time; RLS still keeps it from crossing a tenant boundary.
- `apps/cms/scripts/client-asset-budget.ts`'s `APP_BUDGET_BYTES` raised
  218,000 -> 219,000 B for the two admin screens' client script (4,974 B,
  measured on a clean build) — no new CSS, both screens reuse the existing
  admin design-system classes.

### Local PostgreSQL via docker compose, seed the BjekMart tenant, CI job for check:cms

Increment 2 needed a real PostgreSQL somewhere before `apps/cms` could migrate, run, or be seeded at all — issue #1's epic explicitly deferred it past increment 1's no-database foundation. This closes that gap for local development and CI, without touching production provisioning (still not done — see `docs/deployment.md`).

- `compose.yaml` + `docker/postgres-init/` — a disposable `postgres:18.4`, project `awcms-one`, host port 5433. Creates ONLY the `LOGIN` half of the three roles `apps/cms`'s own migrations (`sql/019`, `sql/022`) already create `NOLOGIN` and passwordless on purpose; every `GRANT` stays the migrations' job.
- `bun run db:up` / `db:down` / `db:reset` — new root scripts.
- `tools/seed-borneojek-mart.ts` (`bun run db:seed:cms`) — an idempotent HTTP client of `apps/cms`'s own `/api/v1/*` surface (never a direct import of its internals, since that module is mid-flight on another branch). Bootstraps the `borneojek-mart` tenant + owner, the 8-category catalog, one representative product per commerce `type`, a handful of blog terms/pages/posts, the site profile, and a read-only machine credential scoped to `commerce.products.read`/`commerce.categories.read` — the same shape `apps/storefront`'s build token needs. `tools/seed-data/*.json` separates each resource's `current` (what the API accepts today) from `future` (images, variants, `service_form`, `subscription_period`, tiers — issue #23's fields), so landing those is a data change, not a script restructure. `tools/seed-assets/` carries small, self-generated SVG placeholders for the extension point — no downloads from the live site.
- `.github/workflows/ci.yml` — new `check-cms` job (`needs: check`, `timeout-minutes: 20`): `apps/cms`'s own full `bun run check` against `DATABASE_URL=""`, then migrate + `bun test tests/integration/` against a real `postgres:18.4` service, with a job-summary line recording the DB-gated skip count before and after. Not yet a required status on `main` — `docs/alur-kerja-pengembangan.md` records the exact `gh api` command and the "green twice in a row" condition for a maintainer to run it.
- `docs/deployment.md` — the full local sequence, in order, with real values; what the seed script deliberately does not seed (legacy shipping/payment/customer-level settings with no API surface today) and why.
- `docs/alur-kerja-pengembangan.md` — the CI section now describes both jobs.
- Root `.env.example` — every new variable (`POSTGRES_*`, `AWCMS_*_PASSWORD`, `AWCMS_BASE_URL`, `SEED_*`), each with the consequence of leaving it unset.

### Storefront catalog parity: home, listing, category, flash sale, product detail

The public storefront now matches mart.borneojek.com's catalog surface end
to end, still static (ADR-0002): a real home page (slider, popular
categories, a flash-sale strip with a live countdown, featured/recommended
products, a promo section, a public-voucher strip, testimonials, recent
news, a promo popup), `/produk` (grid + sidebar, client-side search/filter/
sort/paginate over a build-time JSON index), `/kategori/[slug]`,
`/flash-sale`, and a full `/product/[slug]` (image gallery, tiered pricing,
variant picker, service-form fields, "Tambah ke keranjang", share buttons,
related products, structured data).

Why this shape rather than a thinner slice: increment 1 (issue #5) proved
the stack with a bare catalog grid and a minimal detail page — this closes
the gap to what a shopper on the live site actually sees, using the full
product/category model issue #23 landed and the marketing read models issue
#26 is landing in parallel (every marketing fetch is isolated to
`apps/storefront/src/lib/awcms/pemasaran.ts` and tolerates a 404 until then).

- The `localStorage` cart contract issue #30 builds on:
  `apps/storefront/src/lib/keranjang-kontrak.ts` — key `awcms-one:keranjang:v1`, shape
  `{id, lines, updatedAt}`, event `keranjang:berubah` dispatched on every
  write. Replaces increment-1's placeholder `"cart"` array key.
- Price display moved to `apps/storefront/src/lib/harga.ts`, the only place a price string
  is ever converted to a number — grep-guarded by a unit test over `src/`
  (ADR-0003).
- **The CSP now carries one exemption, derived rather than configured.**
  Product photos live on the CMS's public media origin, which a bare
  `img-src 'self'` blocks silently — correct HTML, green build, broken
  page. `apps/storefront/src/pages/csp.json.ts` writes the origins this build actually
  references to `dist/client/csp.json`; `apps/storefront/server/penyaji.mjs` reads it once
  at startup, re-validates every origin, and widens `img-src` by exactly
  those. A missing or malformed artifact degrades to the baseline policy
  (images stop rendering) rather than to a wider one.
- `BaseLayout.astro` gained a single `head` slot, last in `<head>`, for the
  per-page tags the layout does not model; `/cari` uses it for
  `noindex, follow` alongside the existing `Disallow: /cari` (the two do
  different jobs — one stops the fetch, the other stops the indexing).

### Storefront cart, checkout, order tracking, and wishlist

The storefront can now place a real order while staying 100% static
(ADR-0002 intact): no `prerender = false`, no runtime credential. This is
the architecture revision tracked at
https://github.com/ahliweb/awcms-one/issues/31 (to be recorded there as an
ADR — draft text is in this change's own pull request description): the
browser calls the CMS's anonymous, cross-origin storefront commerce
endpoints directly (`/api/v1/commerce/storefront/*`, issue #29's own
contract — awcms ADR-0103/0107/0118's established pattern, the same one the
newsletter form, site search, and comments already use), the CMS resolves
the tenant from the request `Origin`, and answers with CORS — never a
cookie, never a bearer token.

- **`PUBLIC_AWCMS_ORIGIN`** — the one new build-time variable, deliberately
  `PUBLIC_`-prefixed (an origin is not a secret) unlike `AWCMS_API_TOKEN`.
  `apps/storefront/src/lib/awcms/toko-origin.ts` validates it and is called
  from `apps/storefront/src/pages/csp.json.ts` — a page every build
  unconditionally prerenders — so an unset or malformed value **fails the
  build**, naming the variable, rather than shipping a checkout page that
  silently posts nowhere. The CSP's `connect-src` gains exactly this one
  origin, via the SAME artifact mechanism issue #27 built for `img-src`
  (`csp-asal-media.ts`'s `connectSrc` field, unused until now) — no second
  mechanism.
- **`apps/storefront/src/lib/toko-klien.ts`** — one function per endpoint
  (quote, create order, track, confirm payment, upload-session/finalize,
  cancel, review), every request `mode: "cors"` / `credentials: "omit"` /
  only a `Content-Type` header, envelope unwrapped into a typed
  `TokoApiError` carrying `code`/`details` (field errors, a fresh quote on
  `CART_CHANGED`, `Retry-After` on `RATE_LIMITED`).
- **`/keranjang`** — renders the `localStorage` cart (issue #27's contract),
  re-quotes it live, flags stale price/stock/min-purchase inline (never
  silently corrects), voucher code, quantity/remove, "Lanjut ke checkout".
- **`/checkout`** — one page, five progressively-disclosed steps (contact →
  address → shipping → payment → review); address regions come from
  `apps/storefront/src/lib/awcms/wilayah-checkout.ts`, baked at BUILD time
  into `/index/wilayah-{provinsi,kabupaten-*,kecamatan-*}.json`
  (`PUBLIC_WILAYAH_PROVINSI`, default every Kalimantan province) rather than
  the national ~90,000-village dataset; `VALIDATION_ERROR.details[].field`
  maps to an inline error next to the field it names.
- **`/pesanan`** — order tracking by `?kode=`; the phone comes from
  `sessionStorage` or a form, **never the URL**; status timeline, payment
  instructions while `pending_payment`, a countdown to `expiresAt`, a
  payment-confirmation form, cancel while cancellable.
- **`/wishlist`** — `localStorage`-only; `ProductCard.astro` gains an
  additive `[data-wishlist]` heart button, wired site-wide by
  `apps/storefront/src/scripts/wishlist-tombol.ts` (imported once from
  `Header.astro`, the same way the cart-count script already is).
- Every script above is an external module; every page has a `<noscript>`
  fallback offering a WhatsApp order link
  (`apps/storefront/src/lib/wa-fallback.ts`), is keyboard-reachable, uses
  `aria-live="polite"` for quote/status updates, and carries
  `noindex, follow` via the `head` slot issue #27 added.
- `apps/storefront/scripts/stub-awcms.mjs` (local/CI verification only,
  never shipped) gains a small in-memory state machine for the same
  storefront endpoints, built against the identical #29⇄#30 contract
  document the CMS agent implements in parallel — plus proper
  `level`/`parentCode` filtering for `/api/v1/idn-regions/regions`, which
  the fixture's second province/district rows now need.
- Browser-level Playwright coverage (`apps/storefront/tests/e2e/`, run by
  its own `bun run test:e2e` inside `apps/storefront` — never the root
  `bun test`) exercises add-to-cart → quote → checkout → tracking, and the
  neutral not-found state for a wrong phone.

Deviation from the issue's literal file naming: the cart page's script is
`apps/storefront/src/scripts/keranjang.ts` (matching every other page-level
script's location), not the src/lib-rooted path one line of the issue body
named for it — every interactive script in this app already lives under
`apps/storefront/src/scripts/`, and the issue's own "every script is an
external module" sentence agrees with that location, not the one-off
mention.

### Storefront site chrome + foundation

`apps/storefront` gains the shared shell every future page needs before it
can be a page: header/nav/search/footer, site identity and brand colors
read from `apps/cms` at build time, static/contact pages, and the
sitemap/robots/feed/manifest surface a public site needs (issue #24).

- Header/footer/mobile-nav, a `<main id="konten">` landmark, and a skip
  link, all built from a new route-constants module — so #27/#28/#30 only
  add pages, never touch the chrome again.
- Site identity (`GET /api/v1/site-profile/composed`) and brand colors
  (`GET /theming/{tenantCode}/tokens.css` — corrected from the issue's
  originally named `GET /api/v1/theming`, which cannot answer this question;
  see `apps/storefront/README.md`) replace the old hardcoded `SITE_NAME`/
  footer, degrading to BjekMart's own public defaults when the CMS has
  nothing rather than failing the build.
- New pages: `/kontak`, `/halaman/[slug]` (CMS pages rendered from Portable
  Text), `/cari`, `/404`.
- New build-time surfaces: `robots.txt`, `sitemap-index.xml`/
  `sitemap-[n].xml` (a registry, so later issues register their own URLs
  without touching this issue's files again), `feed.xml`,
  `manifest.webmanifest`, `theme-tokens.css`.
- `apps/storefront/server/penyaji.mjs` gains `GET /healthz` (reports the
  build id written by a new build step) and a `Link: rel=preload` header
  for the build's CSS — still no `AWCMS_*` read at runtime.
- Two deliberate scope trims, recorded in `apps/storefront/README.md`: no
  CMS-uploaded logo/favicon image is resolved (this app has no
  media-object client, and product/media imagery stays out of scope for
  this re-platform slice), and `/kontak` has no maps iframe or FAQ
  accordion — neither field exists on the real `site_profile` schema.

### Storefront news surface (article/rubrik/daerah/mitra/video/tag/search)

`apps/storefront` gains the seputarborneo/beritasampit-parity news surface
over `apps/cms`'s `blog_content` module: `/berita` (front page + article
detail + RSS), a hierarchical `/rubrik/{slug}` archive (with pagination and
its own feed), `/daerah/{slug}` (region archive, reached via an
institution's region), `/mitra/{slug}` (institution landing), `/video`
(posts carrying a `videoNews` block), `/tag/{slug}`/`/penulis/{slug}`/
`/arsip/{yyyy}/{mm}`, and `/cari-berita` (client-side search over a
build-time index) — issue #28.

- `apps/storefront/src/lib/berita.ts` is the new domain layer (mirrors
  `apps/storefront/src/lib/catalog.ts`'s shape: one memoized,
  once-per-build index); `apps/storefront/src/lib/awcms/{blog,wilayah,
  lembaga,iklan}.ts` are the raw, field-verified fetchers, every shape
  checked against the actual route/application code rather than the issue
  text or the OpenAPI doc alone.
- `apps/storefront/src/lib/portable-text.ts` (issue #24) is EXTENDED, not
  replaced: a well-formed `videoNews` block now renders a real, semantic
  outbound link (never an `<iframe>` — this app's CSP has no exemption for
  one, and widening it is outside this issue's scope) and a captioned
  `gallery` item renders a real `<figure>`/`<figcaption>` (never an
  `<img>` — still no media-object client). Every one of issue #24's own
  existing assertions in `apps/storefront/tests/portable-text.test.ts`
  still passes unmodified.
- A static legacy-URL redirect map (seputarborneo's `/news/{id}-{slug}.html`,
  beritasampit's `/{yyyy}/{mm}/{dd}/{slug}/`) is baked at build time
  (`apps/storefront/src/lib/pengalihan-legacy.ts`,
  `apps/storefront/src/pages/index/pengalihan-legacy.json.ts`) from
  `apps/cms`'s own `awcms_seo_redirects` (`origin: "legacy_blog"`) and
  applied by a new, additive hook in `apps/storefront/server/penyaji.mjs`
  — read once at server startup, never at request time.
- A guard test (`apps/storefront/tests/berita-guard-no-news-route.test.ts`)
  asserts no `/news/**` route family is ever introduced — that vocabulary
  is reserved by awcms ADR-0071 for `ahliweb/awcms-astro`, not this
  storefront.
- Six deliberate scope trims, recorded in `apps/storefront/README.md`'s new
  "News surface" section: no hero/gallery/ad-creative `<img>` and no
  YouTube `<iframe>` embed (no media-object client, and CSP widening is
  outside this issue's file ownership); no `article:published_time`/
  `rel=prev/next`/`noindex` (`BaseLayout.astro` has no head-extension
  mechanism); "Terpopuler" is always "latest" (no `visitor_analytics`
  endpoint in this issue's verified scope); no footer ad slot (none exists
  server-side); a region's slug is derived from its name (no CMS-issued
  one); "internal tag links" needed no renderer change (awcms's own
  auto-linking is a CMS-side render-time transform, not an authored node).

### Increment-2 documentation refresh: ADR-0007..0010, mirrors, root skills, knowledge graph

Every root `docs/**` document, `README.md`/`AGENTS.md`/`SECURITY.md`, and `knowledge/curated/monorepo-map.md` described the repository as it stood after increment 1 (issue #1's slice: catalog listing + product detail, no live database). Nine implementation PRs (#34–#42, epic #21) since landed the full BjekMart/news-portal parity increment — a provisioned PostgreSQL, the complete `commerce` module (catalog depth, marketing, orders), and the complete public storefront (catalog, news, cart, checkout, order tracking, wishlist) — without a single governance document catching up. A reader following this repository's own documentation would have been told cart, checkout, and orders "do not exist yet" on a `main` where they had shipped weeks earlier.

- Rewrote every root `docs/**` document against the merged tree, verified file-by-file against the code rather than the original issue text (`arsitektur.md`, `api.md`, `cms.md`, `routing.md`, `pengujian.md`, `skema-basis-data.md`, `kamus-data.md`, `aksesibilitas.md`, `responsif.md`, `ui-ux.md`, `seo.md`); reconciled `deployment.md` and `alur-kerja-pengembangan.md` with the ops/marketing/orders PRs that postdated them.
- Added four ADRs: ADR-0007 (cart/checkout/order-tracking stay static; the browser calls `apps/cms`'s anonymous commerce endpoints directly — the revised decision from the epic's amendment), ADR-0008 (one `commerce` module, not three), ADR-0009 (guest checkout by order code + phone), ADR-0010 (manual payment and alternative courier first, gateways via outbox) — each with its Indonesian mirror, and `docs/adr/README.md`'s index updated both ways.
- Rewrote `README.md`/`AGENTS.md`'s "what is here today, and what is not" sections and gates tables for the current tree (the `check-cms` CI job, both `Check` and `check-cms` as required status checks, the local subtree divergence list); rewrote `SECURITY.md`'s attack-surface section to cover the storefront's anonymous commerce endpoints, the derived CSP, and rate limits.
- Added `.claude/skills/awcms-one-storefront` and `.claude/skills/awcms-one-commerce` (+ Indonesian mirrors, + a root skills index) — practical how-tos for adding a storefront page and a commerce table/endpoint, mirroring `apps/cms/.claude/skills/awcms-new-endpoint`'s format.
- Updated `knowledge/curated/monorepo-map.md`'s structural map for the current workspace layout.

Nothing here changes runtime behaviour; every change is documentation.

## [0.2.0] — 2026-09-15

### Architecture and reference documentation, describing the merged tree as it actually is

Adds `docs/` (issue #7): architecture, six ADRs, the database schema, a data dictionary mapping every `awcms_commerce_*` column to its legacy `commerce_bj_mart` source column, the commerce API, the CMS authoring workflow, storefront routing, SEO, accessibility, responsive design, UI/UX, testing, deployment, and the development workflow — plus `docs/README.md` as the index. Every document is mirrored to Indonesian (`docs:i18n:stamp`) and lands with `AGENTS.md`/`README.md` updated to describe the tree as it now is: every child issue of #1 (#2, #4, #5, #6, #11) has landed, so the "not here yet" framing both documents carried is retired.

- `bun run audit:dokumen`'s ADR-index and `ADR-NNNN`-citation checks run for real for the first time in this repository, now that `docs/adr/` exists — both green against the six ADRs landed here.
- Where the tree disagreed with the original issue text, the documents follow the tree: the URL shape (`/product/{slug}`, per the live-site evidence on issue #5), the real API envelope (`{ items, nextCursor }`, not the originally assumed shape), and the real, verified branch-protection settings (a required `Check` status check; no merge-strategy restriction) are what is documented, not what was planned.
- A pre-existing, unrelated defect surfaced by activating the ADR-citation check for the first time — a generated Obsidian note under `knowledge/generated/graphify/` extracts `packages/gerbang/audit-dokumen.mjs`'s own illustrative example (`` `ADR-0042` ``) as a false citation — is filed as [issue #15](https://github.com/ahliweb/awcms-one/issues/15) rather than patched here, since fixing it needs a change to `packages/gerbang/` or a knowledge-graph regeneration, both outside this change's own scope.

### audit:dokumen no longer reads knowledge/generated/

`bun run audit:dokumen` now skips `knowledge/generated/` the way it already skips `apps/cms/` (issue #15). Graphify's Obsidian export extracts notes from source code; it does not author them. The first false positive was concrete: the moment `docs/adr/` existed, the ADR-citation check fired on three generated notes quoting the gate's own illustrative example citation (a placeholder ADR number in a comment in `packages/gerbang/audit-dokumen.mjs`). Every other check in the gate would misfire on generated notes the same way — their links are wikilinks the gate does not parse, and a stale path in one is graph staleness, which `bun run audit:graf` deliberately leaves alone. `knowledge/curated/` and `knowledge/README.md` are authored and stay in scope; two fixture tests pin both sides of that line.

### apps/cms: the `commerce` module — catalog domain, persistence, migrations, API

Adds the `commerce` module to the embedded CMS (issue #4): categories (hierarchical) and products, the catalog core of the legacy `commerce_bj_mart` schema, as `awcms_commerce_categories` and `awcms_commerce_products` under PostgreSQL row-level security, with `GET`/`POST` list-and-create and `GET`/`PATCH`/`DELETE` by id at `/api/v1/commerce/{products,categories}`, an OpenAPI fragment, three domain events, and a read-only `/admin/commerce` screen.

- Every table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY` with a `tenant_id = current_setting('app.current_tenant_id')` policy. Proven, not declared: as the unprivileged `awcms_app` role, a query with no tenant context fails closed and an insert whose `tenant_id` differs from the session tenant is refused by the policy.
- `price` is `numeric(14,2)` and stays a **string** through the directory, the DTO, and the API — never a JS `number`. `discount_percent` and `stock` are `integer` with `CHECK` bounds.
- `status` (`draft`→`active`→`inactive`→`archived`, with legal transitions in the domain layer) and `deleted_at` are independent axes: unavailable-for-sale and deleted-by-the-merchant are different states.
- Migrations `sql/153`–`sql/155`. The full chain `001`→`155` was applied from an **empty** database, which is what a real deployment does. `sql/155` grants the lifecycle worker the rights the generic purge engine needs; `cursorColumn: "deleted_at"` means that engine is mathematically unable to purge a live row.
- Twenty-nine upstream files in `apps/cms/` are modified — the module registry, the event-type registry, the AsyncAPI and OpenAPI catalogues, the sidebar registry, the admin-screen coverage ledger, and the generated inventories and module-count lines that awcms's own `check` chain regenerates or enforces when a module is admitted. Each one is a future `git subtree pull` conflict point; the resolution is to re-run the generators after a sync, not to hand-merge generated output.
- The list endpoints return the awcms house envelope `{items, nextCursor}`; the storefront's local assumption of `{products}` / `{categories}` is reconciled in issue #6.

### Federated knowledge-graph workflow: root Graphify graph, `audit:graf`, safe Obsidian export

Adds a monorepo-level Graphify + Obsidian workflow (issue #11) without duplicating or corrupting the Graphify state already embedded inside `apps/cms` via the `ahliweb/awcms` subtree. Two graphs, federated on demand rather than one graph built twice — the same discipline the rest of this repo already applies to `apps/cms`'s own tree.

- Root `.graphifyignore` + a real, committed root graph (`graphify-out/graph.json`, 396 nodes) built `--code-only` — structural AST extraction, no LLM, no API key, no network, ever, by default. Excludes `apps/cms/**`, which already owns its own graph and its own gate.
- `bun run audit:graf` (alias `knowledge:check`) — the fourth `audit:*` gate, modelled on `apps/cms/scripts/graph-artifacts-check.ts`: tracked-artefact hygiene, report/graph agreement, chosen community names, `.graphifyignore` still excluding `apps/cms`, no duplicate-extracted node, the federated graph never tracked, and `apps/cms/graphify-out/` untouched by this repo's own tooling. Runs in CI (`.github/workflows/ci.yml`) — it reads only committed artefacts, no `graphify` installation needed.
- `bun run knowledge:graph:combine` — merges the root graph with `apps/cms/graphify-out/graph.json` into a gitignored, on-demand `graphify-out/combined/graph.json`, failing closed on a missing, malformed, empty, or `directed`-mismatched component graph (checks `graphify merge-graphs` itself does not make).
- `bun run knowledge:obsidian:export` — stages the root graph's Obsidian export, validates every file (rejecting a symlink, an unexpected extension, path traversal, or a curated-filename collision), and syncs only the allowlisted result to `knowledge/generated/graphify/`. `knowledge/curated/` is read only for collision-checking, never written.
- `packages/gerbang/lib/subtree-guard.mjs` guards every write both new tools perform; `tests/knowledge-no-subtree-write.test.mjs` runs both tools for real against a fixture tree and proves `apps/cms/` comes out byte-for-byte unchanged.
- `knowledge/README.md` + five thin `knowledge/curated/*.md` files record what code alone cannot state: ownership boundaries, cross-repo source-of-truth rules, the tracked/untracked table, and a nine-item threat model — no ISO/IEC certification claimed.
- `README.md`/`AGENTS.md` (and their Indonesian mirrors) revisit the earlier, now-outdated statement that `audit:graf` was not ported — it is, and both documents say why and what changed.

### packages/kontrak: the type-only DTO contract, and the storefront reconciled to the real envelope

Adds the fifth workspace member, `@awcms-one/kontrak` (issue #6): `ProductType`/`ProductStatus` re-exported, `export type` only, from `apps/cms`'s commerce domain layer (`apps/cms/src/modules/commerce/domain/{product-type,product-status}.ts`) — never hand-copied again. `tests/kontrak-arah-impor.test.mjs` guards the one-way import direction (`storefront -> kontrak -> cms`) that keeps `apps/cms`'s `git subtree pull` safe: a dependency pointing back at this repo's own code would turn every future sync into a merge conflict against code upstream never wrote.

Reconciles `apps/storefront/src/lib/catalog.ts` against the real commerce API that landed with issue #4, closing four mismatches a side-by-side review of the two merged PRs surfaced:

- Both list responses are read as `{ items, nextCursor }` — the awcms house keyset-page shape — not the invented `{ products }` / `{ categories }` this app shipped with, which would have crashed the build on `undefined`.
- Categories are now keyset-paginated with the same cursor walk products already use, not fetched as a single unpaginated page.
- `status` and `limit` are no longer sent as query parameters — the CMS route accepts only `cursor` and fixes the page size server-side; sending parameters it silently ignores was a lie in the request log.
- `getProducts()` now filters with an exhaustive `switch` (`isPubliclyVisible`) instead of a bare `status === "active"` comparison, so a `ProductStatus` `apps/cms` adds later cannot silently fall through — verified by hand: widening the union in a worktree turned `bun run check` red at that exact line (the captured error is in this change's pull request description).

`CommerceProduct`/`CommerceCategory` — the row DTO shapes — stay declared locally in `catalog.ts` rather than moving into `@awcms-one/kontrak`: they live in `apps/cms/src/modules/commerce/application/{product,category}-directory.ts`, not `domain/`, so they are out of that package's scope by its own rule (`application/` may carry I/O-bearing imports on other lines of the same file).

Fixtures (`apps/storefront/tests/fixtures/awcms/*.json`) and `apps/storefront/scripts/stub-awcms.mjs` now emit the real envelope too, so the offline build proof against the stub is honest rather than agreeing with the bug it used to ship with.

### Monorepo foundation: audit gates, release tooling, governance docs, and CI

Stands up the machinery `apps/storefront` (issue #5) and `packages/kontrak` (issue #6) will land into, modelled on `ahliweb/media-lenterakalteng`: `packages/gerbang`'s three audit gates (`audit:dokumen`, `audit:rilis`, `audit:translation`), `tools/rilis.mjs` + `cek-lockfile.mjs` + `docs-i18n-stamp.mjs`, the `.changesets/` convention itself, every governance document with its Indonesian mirror, and a CI workflow that runs the check job unconditionally.

- `bun install` resolves the workspace; `bun test` from the root is green and does not execute anything under `apps/cms/` (already excluded via `bunfig.toml`, proven here rather than merely trusted).
- Content, asset, and crawl gates (`audit:konten`, `audit:aset`, `audit:graf`, `audit:serapan`) are deliberately **not** ported: this repository has no built content, asset, or crawl surface yet for them to guard. Porting them now would ship gates that always pass trivially, which is worse than not having them — a green gate that checks nothing reads exactly like one that checked something and found it clean.
- `AGENTS.md` records the `git subtree` sync discipline for `apps/cms`: a subtree-sync PR must be merged with a merge commit, never squashed or rebased, or the next `git subtree pull` loses the merge base it needs.

### apps/storefront: the public catalog and product-detail storefront

Adds the fourth workspace member, `apps/storefront` (issue #5): an Astro app with `output: "static"` that fetches the catalog from `apps/cms` at **build** time and bakes it — the running container holds no API token and never reaches the database. Catalog at `/`, product pages at `/product/{slug}` with no trailing slash, matching the live `mart.borneojek.com` URL shape so indexed URLs, bookmarks, and shared links survive the cutover unchanged; `/products` (with or without a query string) 301s to `/`.

- `price` is carried as the `numeric(14,2)` **string** PostgreSQL emits and formatted only for display with `Intl.NumberFormat`; nothing in the app parses it into money arithmetic.
- The build fails loudly on a non-2xx, a `{success:false}` envelope, a catalog where no product is `active`, or a cursor that never terminates — a storefront that silently publishes an empty catalog is worse than a red build.
- CSP-strict by construction: `inlineStylesheets: "never"` and `assetsInlineLimit: 0`, so no inline `<style>`, `<script>`, or `data:` URI is ever emitted. CMS-supplied `labelColor` badges are compiled into a generated external stylesheet (`product-labels.css`) rather than inline styles, with a WCAG-contrast-chosen foreground.
- JSON-LD is written through an escaper that turns `<`, `>`, `&` into `\uXXXX` after `JSON.stringify` — the HTML parser closes a `<script>` at the first `</script>` regardless of `type`, so a product name containing one would otherwise break out of the data block. A committed fixture (`XSS-REGRESI-01`) guards it.
- The build is reproducible offline against `apps/storefront/scripts/stub-awcms.mjs` + `apps/storefront/tests/fixtures/awcms/`.
- The DTO unions are declared locally for now; issue #6 replaces them with a re-export from `@awcms-one/kontrak`.

## [0.1.0] — 2026-09-15

Initial workspace scaffolding, landed before the `.changesets/` convention itself existed — recorded here by hand rather than folded from a changeset entry.

- Bun workspace root (`workspaces: ["apps/*", "packages/*"]`), pinned toolchain (`bun@1.4.0`), and the dotfiles that govern it (`.gitignore`, `.editorconfig`, `.dockerignore`).
- `packages/config` — the shared `tsconfig.base.json` preset.
- `apps/cms` — `ahliweb/awcms` v10.3.0, embedded whole via `git subtree` with full history (closes #2).
