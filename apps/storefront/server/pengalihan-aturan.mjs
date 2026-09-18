/**
 * Rule-based legacy-URL redirects (issue #55 / A9) — seputarborneo's
 * rubrik/daerah/mitra/video/static/search URL shapes, resolved with no CMS
 * row at all.
 *
 * ## Why this exists beside `pengalihan-legacy.ts`'s row-based map
 *
 * `src/lib/pengalihan-legacy.ts` (issue #28) turns a `awcms_seo_redirects`
 * ROW into a redirect — one entry per URL an operator/import explicitly
 * recorded. That covers `/news/{id}-{slug}.html` and beritasampit's dated
 * shape, because a specific article has no rule a machine could derive: the
 * mapping from an old numeric id to a new slug is a FACT, stored once, not a
 * pattern.
 *
 * seputarborneo's other legacy shapes are the opposite: rubrik/daerah/mitra
 * archive URLs, the two static utility pages, and the search box all follow
 * a fixed, finite, DETERMINISTIC shape that `include/nav_menu.php`
 * (`seputarborneo_rubrik_resolve()`/`_kanonik()`) and `.htaccess` already
 * encode as a lookup table, not a database query — 14 daerah, 24 mitra
 * channels, a handful of rubrik topics, three static pages, one search box.
 * Requiring a CMS row per legacy URL for these would mean seeding hundreds
 * of rows for links that resolve identically forever; this module resolves
 * them with a plain, in-memory table instead, exactly the way
 * `seputarborneo_rubrik_resolve()` itself does.
 *
 * This file is PURE — no filesystem, no network, no import from `src/lib`
 * (which would drag that whole graph into the bundled server for no
 * reason). `server/penyaji.mjs`'s `legacyRedirectLocation()` calls
 * `ruleBasedRedirectLocation()` below ONLY on a miss against the row-based
 * map, so an operator-authored row always wins when the two disagree — the
 * same "a specific fact beats a derived guess" posture
 * `pengalihan-legacy.ts`'s own docblock argues for the CMS's `target`
 * column vs. this app's own URL vocabulary.
 *
 * ## Source material
 *
 * Every rule below is read off seputarborneo's own routing, not invented:
 * `.htaccess` (the `RewriteRule`s that turn a `.html` URL into a query
 * string), `include/nav_menu.php` (`seputarborneo_nav_primary()`,
 * `_nav_daerah()`, `_nav_mitra()`, `_nav_umum()`, `_rubrik_slug()`,
 * `_rubrik_resolve()`, `_rubrik_kanonik()`), `rubriks/index.php` (the
 * `?news=&kt=&lanjut=` pagination shape — the SAME `?news={A}&kt={B}` shape
 * `.htaccess` generates for a real two-segment `/{A}/{B}.html` request, so
 * `resolveRubriksQuery` below delegates to the exact same
 * `resolveTwoSegmentHtml` dispatch rather than re-deriving it), `video/
 * index.php` (the `?video={id}-{slug}.html`/`{id}_{slug}.html` shape, the
 * bare `?video={id}` shape the old homepage hard-coded, and its own 301 for
 * a stale slug), `img/index.php` (`?news={id}` → the canonical article, or
 * home), and `data/index.php` (the three static pages).
 *
 * ## Two DIFFERENT numeric id spaces — `berita_red` vs. `berita_vid`
 *
 * Issue #58 (B2, the seputarborneo importer) is explicit that `berita_red`
 * (regular articles, behind `/news/{id}-…`) and `berita_vid` (video posts,
 * behind `/video/?video={id}-…`) are TWO SEPARATE MariaDB tables with their
 * own, independently-assigned auto-increment ids — `id_ber` and `id_vid`.
 * The same numeric id can (and eventually will) name a completely different
 * post in each table. `findNewsRowTargetById`/`findVideoRowTargetById`
 * below therefore search two DISJOINT slices of the row-based map — a
 * `/news/{id}-…`-shaped source for the former, a `/video/{id}-…`-shaped
 * source for the latter — and the video rule (`resolveVideoQuery`) never
 * falls back to the news slice: doing so would silently redirect a reader to
 * an unrelated article that merely happens to share the same id.
 *
 * The video slice's key is a SYNTHETIC, query-free path
 * (`/video/{id}-{slug}.html`) that never existed as a public URL — the
 * exporter (`tools/import-seputarborneo.ts`, issue #58 review round 2)
 * writes it because the CMS strips the query string from every redirect
 * source at write time (`validateRedirectInput` → `normalizeRedirectPath`
 * without `keepQuery`), so the REAL `/video/?video={id}-{slug}.html` URL of
 * every video row would have been stored as one and the same bare `/video`.
 * The real inbound URL is still what a reader follows; it reaches this
 * module as a query-string request against `/video` and is answered by id
 * from that index, exactly the way `video/index.php` read only
 * `(int) $_GET['video']`.
 *
 * ## The target slugs
 *
 * Every daerah/mitra name below is slugified with `normalizeSlugSegment`,
 * which mirrors `src/lib/berita.ts`'s `slugifyName` byte-for-byte (NFKD,
 * strip combining marks, lower-case, collapse anything non-`[a-z0-9]` to a
 * single hyphen, trim). It is duplicated rather than imported for the same
 * reason the whole `src/lib` graph is kept out of this file: if that
 * algorithm ever changes, this module's own table-driven tests
 * (`tests/pengalihan-aturan.test.ts`) compare its output against the 14
 * daerah/24 mitra names directly, so a drift between the two shows up as a
 * failing test rather than a silently wrong redirect. The 24 institution
 * names and 14 daerah names are exactly issue #57 (B1)'s seed list, itself
 * copied verbatim from `include/nav_menu.php`'s `seputarborneo_nav_mitra()`/
 * `_nav_daerah()` — the destination slug is a plain kebab-case of the name,
 * the same shape `apps/storefront/tests/fixtures/awcms/blog-institutions.json`
 * already shows for an institution's CMS-issued slug.
 *
 * ## The `WISATA`/`Wisata` collision, and why it is not a bug here
 *
 * seputarborneo keeps `WISATA` (a rubrik topic with no category) and
 * `Wisata` (a member of `UMUM`, so really `Rubrik: UMUM, Kategori: Wisata`)
 * strictly apart — two different `(rubrik, kategori)` pairs that only look
 * alike as bare text. This app's rubrik tree has no such split (issue #57's
 * own scope note): `UMUM`'s children are ordinary rubriks here, so
 * `/rubrik/wisata.html` (old topic) and `/umum/wisata.html` (old UMUM
 * child) BOTH resolve to `/rubrik/wisata` below — not by a special case, but
 * because both paths normalize their category segment to the same slug and
 * both dispatch through `/rubrik/{slug}`. `tests/pengalihan-aturan.test.ts`
 * asserts this is the ONLY pair of source URLs that collapse to the same
 * destination across every rubrik/daerah/mitra/umum name this module knows.
 */

import { posix } from "node:path";

// ---------------------------------------------------------------------------
// Slugging — mirrors `src/lib/berita.ts`'s `slugifyName`; see the module
// docblock above for why this is a deliberate duplication, not an import.
// ---------------------------------------------------------------------------

/**
 * @param {string} raw
 * @returns {string}
 */
function decodeSegment(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    // An undecodable segment (a lone `%` from a URL nobody could have typed
    // deliberately) is left as-is — it will not match any alias below, and
    // falls through to the generic lower-case/hyphenate pass, same as any
    // other unrecognized value.
    return raw;
  }
}

/**
 * @param {string} raw A single path segment, still percent-encoded.
 * @returns {string}
 */
export function normalizeSlugSegment(raw) {
  return decodeSegment(raw)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Static route shapes this module targets — duplicated from
// `src/config/routes.ts`'s `ROUTES` for the same "no src/lib import in the
// bundled server" reason as `normalizeSlugSegment` above. Kept as named
// constants (never a literal string repeated at each call site) so a route
// rename is one edit here, matching that file's own stated intent.
// ---------------------------------------------------------------------------

const NEWS_FRONT_PAGE = "/berita";
const VIDEO_LIST_PAGE = "/video";
const NEWS_SEARCH_PAGE = "/cari-berita";

/** `ROUTES.page(slug)` for the three static pages `data/index.php` serves — matches `STATIC_PAGE_SLUGS.editorial`/`.mediaGuidelines`/`.disclaimer` in `src/config/routes.ts`. */
const STATIC_PAGE_REDIRECTS = new Map([
  ["/tentang_kami.html", "/halaman/redaksi"],
  ["/pedoman_media_cyber.html", "/halaman/pedoman-media-siber"],
  ["/disclimer.html", "/halaman/disclaimer"]
]);

// ---------------------------------------------------------------------------
// Rubrik topics — `seputarborneo_nav_primary()`, excluding `Beranda`/`Daerah`
// (not real rubrik pages). Every one of these already normalizes to its own
// canonical slug; the one alias this table exists for is `OLAHRAGA`'s
// display spelling `Olah Raga`.
//
// `VIDEO` is also in `seputarborneo_nav_primary()`, but is NOT a rubrik
// archive in this app — it is its own top-level list page (`/video`, no
// `/rubrik/video`). `canonicalRubrikSlug` normalizes `VIDEO`'s spelling like
// any other topic (there is none to correct), but
// `resolveTwoSegmentHtml`'s `rubrik` branch below special-cases the RESULT
// — `/rubrik/VIDEO.html`/`/rubrik/video.html` both redirect to `/video`,
// never to a `/rubrik/video` page this app does not have.
// ---------------------------------------------------------------------------

/** Normalized alias → canonical rubrik slug, for the one topic whose *display* spelling ("Olah Raga") differs from its slug ("olahraga"). Every other topic's normalized form already IS its canonical slug. */
const RUBRIK_SLUG_ALIASES = new Map([["olah-raga", "olahraga"]]);

/**
 * @param {string} normalized Already run through `normalizeSlugSegment`.
 * @returns {string}
 */
function canonicalRubrikSlug(normalized) {
  return RUBRIK_SLUG_ALIASES.get(normalized) ?? normalized;
}

// ---------------------------------------------------------------------------
// Daerah — `seputarborneo_nav_daerah()`'s 14 regencies/cities, each with the
// old city name (`kota`) a reader might still type or have bookmarked. The
// slug column is this app's `idn_admin_regions`-derived region slug (see the
// module docblock's "target slugs" section) — never re-derived at request
// time, because these 14 names are fixed and known, not a live lookup this
// pure module could perform anyway.
// ---------------------------------------------------------------------------

const DAERAH_ENTRIES = [
  { name: "Palangka Raya", slug: "palangka-raya", oldCity: null, extraAliases: ["palangkaraya"] },
  { name: "Kapuas", slug: "kapuas", oldCity: "Kuala Kapuas" },
  { name: "Pulang Pisau", slug: "pulang-pisau", oldCity: null },
  { name: "Katingan", slug: "katingan", oldCity: "Kasongan" },
  { name: "Kotawaringin Timur", slug: "kotawaringin-timur", oldCity: "Sampit" },
  { name: "Kotawaringin Barat", slug: "kotawaringin-barat", oldCity: "Pangkalan Bun" },
  { name: "Seruyan", slug: "seruyan", oldCity: "Kuala Pembuang" },
  { name: "Lamandau", slug: "lamandau", oldCity: "Nanga Bulik" },
  { name: "Sukamara", slug: "sukamara", oldCity: null },
  { name: "Gunung Mas", slug: "gunung-mas", oldCity: "Kuala Kurun" },
  { name: "Barito Selatan", slug: "barito-selatan", oldCity: "Buntok" },
  { name: "Barito Timur", slug: "barito-timur", oldCity: "Tamiang Layang" },
  { name: "Barito Utara", slug: "barito-utara", oldCity: "Muara Teweh" },
  { name: "Murung Raya", slug: "murung-raya", oldCity: "Puruk Cahu" }
];

/** Every recognized daerah name/old-city-name, normalized, exported so `tests/pengalihan-aturan.test.ts` can iterate the full table rather than re-typing it. */
export const DAERAH_NAMES = DAERAH_ENTRIES.map((entry) => entry.name);

const DAERAH_SLUG_BY_ALIAS = new Map(
  DAERAH_ENTRIES.flatMap((entry) => {
    const aliases = [entry.name, ...(entry.oldCity ? [entry.oldCity] : []), ...(entry.extraAliases ?? [])];
    return aliases.map((alias) => [normalizeSlugSegment(alias), entry.slug]);
  })
);

// ---------------------------------------------------------------------------
// Mitra Borneo — `seputarborneo_nav_mitra()`'s 24 channels, verbatim (also
// issue #57 (B1)'s institution seed list). No alias table: an institution's
// slug passes through the CMS unchanged (see `apps/storefront/README.md`'s
// news-surface deviation #5), so a plain kebab-case of the name IS the
// target slug — the same shape
// `apps/storefront/tests/fixtures/awcms/blog-institutions.json` already
// shows. Kept as a plain name list (not a name→slug map) because the
// transform needs no correction table the way daerah's old-city names do;
// `MITRA_BORNEO_NAMES` exists so `tests/pengalihan-aturan.test.ts` can
// assert all 24 without retyping them, and so a 25th institution added
// later needs no table update here at all — the redirect works for it the
// same way it does for these 24.
// ---------------------------------------------------------------------------

export const MITRA_BORNEO_NAMES = [
  "Pemprov Kalteng",
  "DPRD Kalteng",
  "Pemko Palangka Raya",
  "DPRD Palangka Raya",
  "Pemkab Kotawaringin Timur",
  "DPRD Kotawaringin Timur",
  "Pemkab Kapuas",
  "DPRD Kapuas",
  "Pemkab Pulang Pisau",
  "DPRD Pulang Pisau",
  "Pemkab Seruyan",
  "DPRD Seruyan",
  "Pemkab Gunung Mas",
  "DPRD Gunung Mas",
  "Pemkab Barito Timur",
  "DPRD Barito Timur",
  "Pemkab Murung Raya",
  "DPRD Murung Raya",
  "Pemkab Lamandau",
  "DPRD Lamandau",
  "Pemkab Katingan",
  "DPRD Katingan",
  "Pemkab Barito Utara",
  "DPRD Barito Utara"
];

// ---------------------------------------------------------------------------
// Umum — `seputarborneo_nav_umum()`'s 6 members. UMUM's children are
// ordinary rubriks here (issue #57's own scope note), so this bucket
// dispatches to `/rubrik/{slug}`, not a `/umum/{slug}` page this app does
// not have. See the module docblock's "WISATA/Wisata collision" section for
// why `Wisata` landing on the same `/rubrik/wisata` as the topic rubrik
// `WISATA` is intended, not a bug.
// ---------------------------------------------------------------------------

/** Exported for the same table-driven-test reason as `MITRA_BORNEO_NAMES` above — not consulted by the transform itself, which accepts any UMUM child generically. */
export const UMUM_NAMES = ["Wisata", "Budaya", "Provinsi", "Kuliner", "Travel", "Bisnis"];

// ---------------------------------------------------------------------------
// URL parsing — a small, self-contained decode/normalize pass, deliberately
// NOT shared with `server/penyaji.mjs`'s own `normalizedPath` (that function
// only ever sees a path, never the query string every rule below needs).
// ---------------------------------------------------------------------------

/**
 * @param {string} url `req.url` as received — path, optionally `?query`,
 * optionally `#fragment`.
 * @returns {{ path: string, query: URLSearchParams }}
 */
function parseLegacyUrl(url) {
  const withoutFragment = url.includes("#") ? url.slice(0, url.indexOf("#")) : url;
  const [rawPath, rawQuery = ""] = withoutFragment.split("?");

  let decodedPath = rawPath ?? "/";
  try {
    decodedPath = decodeURI(decodedPath);
  } catch {
    // Left undecoded — see `normalizedPath` in `server/penyaji.mjs` for the
    // same posture: a path that fails to decode matches no rule below,
    // which is the correct outcome for a URL nobody could have followed.
  }

  const normalized = posix.normalize(decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`);
  const path = normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;

  return { path, query: new URLSearchParams(rawQuery) };
}

/** `^/([^/]+)/([^/]+)\.html$` — the ONE structural shape every rubrik/daerah/mitra/umum `.html` source in this module shares (`.htaccess`'s own generic two-segment `RewriteRule`, and `rubrik/{slug}.html`'s own dedicated one, which is the SAME shape with `rubrik` as a literal first segment). @param {string} path @returns {{ first: string, second: string } | null} */
function twoSegmentHtmlMatch(path) {
  const match = /^\/([^/]+)\/([^/]+)\.html$/.exec(path);
  return match ? { first: match[1], second: match[2] } : null;
}

/** The last non-empty path segment of `path`, or `""` for a path with none. @param {string} path @returns {string} */
function lastPathSegment(path) {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

/** The `rowIdIndexFor` cache — see that function's own docblock. @type {WeakMap<Record<string, string>, { news: Map<string, string>, video: Map<string, string> }>} */
const ROW_ID_INDEX_CACHE = new WeakMap();

/**
 * `id -> target` indexes over a row-based map's `/news/{id}…` and
 * `/video/{id}…` (or, for a row that somehow kept it, `/video/?video={id}…`)
 * sources, built ONCE per distinct `rowMap` object and cached in this
 * `WeakMap` — never rescanned per request.
 *
 * `legacyRedirectLocation` loads `rowMap` once, at server startup
 * (`readLegacyRedirectMap`), and passes the SAME object to every request for
 * the process's whole lifetime (a new build means a new container, per that
 * function's own docblock) — so keying the cache on object identity is
 * exactly "once per loaded map", not once per request. After issue #58 (B2)
 * imports seputarborneo's ~25k `berita_red` rows, a plain per-request
 * `Object.keys(rowMap)` scan (this function's previous shape) would run
 * that full scan on every `/video/?video=…`, `/img/?news=…`, or
 * `/rubrik/…` request this module resolves; a `WeakMap` never leaks either,
 * since the entry disappears with the `rowMap` object itself once a new
 * build's map replaces it.
 *
 * @param {Record<string, string>} rowMap
 * @returns {{ news: Map<string, string>, video: Map<string, string> }}
 */
function rowIdIndexFor(rowMap) {
  const cached = ROW_ID_INDEX_CACHE.get(rowMap);
  if (cached) return cached;

  const news = new Map();
  const video = new Map();

  // The id is whatever `\d+` matches right after the fixed prefix, so a
  // lookup for id `"1"` can never accidentally match a stored `/news/15-…`
  // row — the digits belong to the id, not to a separator character this
  // regex could otherwise mistake for one (see issue #55 review, defect 2).
  for (const [sourcePath, target] of Object.entries(rowMap)) {
    const newsMatch = /^\/news\/(\d+)[-_.]/.exec(sourcePath);
    if (newsMatch && !news.has(newsMatch[1])) news.set(newsMatch[1], target);

    // `/video/{id}-{slug}.html` (also `{id}_…`, `{id}.html`) — the QUERY-FREE
    // synthetic key issue #58 (B2)'s exporter writes for every video post
    // (`videoRedirectSourcePath` in `tools/import-seputarborneo.ts`). It is
    // the real contract: the CMS strips the query string from every redirect
    // source at write time (`validateRedirectInput` → `normalizeRedirectPath`
    // without `keepQuery`), so a `/video/?video={id}-…` source can never be
    // STORED — every such row would collapse onto the bare key `/video`. The
    // second alternative below still accepts that form for a row that reached
    // this map some other way (a hand-authored fixture, a future CMS that
    // keeps the query), so the two shapes index identically by id. A
    // DIFFERENT id space from `/news/…` above — see the module docblock's
    // "Two DIFFERENT numeric id spaces" section for why these are never
    // merged into one index.
    const videoMatch =
      /^\/video\/(\d+)[-_.]/.exec(sourcePath) ?? /^\/video\/\?video=(\d+)[-_.]/.exec(sourcePath);
    if (videoMatch && !video.has(videoMatch[1])) video.set(videoMatch[1], target);
  }

  const index = { news, video };
  ROW_ID_INDEX_CACHE.set(rowMap, index);
  return index;
}

/**
 * The row-based map's destination for a `/news/{id}[-_.]…` source (any
 * slug), or `null` when no such row exists — used by the img rule, never by
 * `resolveVideoQuery` (see the module docblock's "Two DIFFERENT numeric id
 * spaces" section for why a video id must never be looked up here).
 *
 * @param {Record<string, string>} rowMap
 * @param {string} id A numeric id, as a string.
 * @returns {string | null}
 */
function findNewsRowTargetById(rowMap, id) {
  return rowIdIndexFor(rowMap).news.get(id) ?? null;
}

/**
 * The row-based map's destination for a `/video/{id}[-_.]…` source (the
 * exporter's synthetic key — any slug; a `/video/?video={id}[-_.]…` key is
 * indexed the same way, see `rowIdIndexFor`), or `null` when no such row
 * exists — the video-id-space counterpart of `findNewsRowTargetById` above.
 *
 * @param {Record<string, string>} rowMap
 * @param {string} id A numeric id, as a string.
 * @returns {string | null}
 */
function findVideoRowTargetById(rowMap, id) {
  return rowIdIndexFor(rowMap).video.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// The two-segment `.html` dispatch — rubrik/daerah/mitra-borneo/umum all
// share the SAME source shape (see `twoSegmentHtmlMatch` above); which
// bucket a request lands in is decided purely by the normalized FIRST
// segment, exactly the way `seputarborneo_rubrik_resolve()`'s two-segment
// branch dispatches on `$rubrik_slug` before ever looking at `$kategori`.
//
// Every first-segment comparison here is case-insensitive
// (`normalizeSlugSegment` lower-cases it) even though seputarborneo's own
// Apache-level `rubrik/` rewrite was case-SENSITIVE and a real
// `/RUBRIK/x.html` request would historically have missed it (falling
// through to the generic two-segment rewrite instead, then failing to
// resolve as any known parent). Being lenient here strictly WIDENS
// coverage — an old link nobody could really have followed successfully
// before still lands somewhere sensible now — and costs nothing, since no
// two buckets below share a first-segment alias.
// ---------------------------------------------------------------------------

/**
 * @param {string} first Raw (still percent-encoded) first segment.
 * @param {string} second Raw (still percent-encoded) second segment, before the trailing `.html`.
 * @returns {string | null}
 */
function resolveTwoSegmentHtml(first, second) {
  const firstSlug = normalizeSlugSegment(first);
  const secondSlug = normalizeSlugSegment(second);
  if (secondSlug === "") return null;

  if (firstSlug === "rubrik") {
    const canonical = canonicalRubrikSlug(secondSlug);
    // `VIDEO` is a top-level nav item in seputarborneo, not a rubrik archive
    // in this app — see the module's own comment above `RUBRIK_SLUG_ALIASES`
    // for why this is a post-canonicalization special case rather than an
    // alias-table entry (an alias corrects a SPELLING; this redirects to an
    // entirely different route shape).
    return canonical === "video" ? VIDEO_LIST_PAGE : `/rubrik/${canonical}`;
  }

  if (firstSlug === "daerah") {
    return `/daerah/${DAERAH_SLUG_BY_ALIAS.get(secondSlug) ?? secondSlug}`;
  }

  if (firstSlug === "mitra-borneo") {
    return `/mitra/${secondSlug}`;
  }

  if (firstSlug === "umum") {
    // UMUM's children are ordinary rubriks here — see the module docblock's
    // "WISATA/Wisata collision" section.
    return `/rubrik/${secondSlug}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Query-string rules — `/rubriks/?news=&kt=&lanjut=`, `/video/?video=`,
// `/img/?news=`, `/pencarian/?cari_berita=`, `/index.php`/`/?subscribed=1`.
// ---------------------------------------------------------------------------

/**
 * `rubriks/index.php?news=&kt=&lanjut=` is not a shape of its own — it is
 * EXACTLY `.htaccess`'s generic two-segment `RewriteRule`
 * (`^([^/]*)/([^/]*)\.html$ -> /rubriks/?news=$1&kt=$2`) with its two
 * captures already split into query parameters, and the one-segment rule
 * (`^rubrik/([^/]*)\.html$ -> /rubriks/?news=$1`) is the SAME shape with
 * `kt` simply absent and `rubrik` itself implied as the first segment. So
 * this function does not re-derive rubrik/daerah/mitra/umum dispatch a
 * second time — it reconstructs the ORIGINAL two-segment (or one-segment)
 * request and hands it to `resolveTwoSegmentHtml`, the single source of
 * truth for that dispatch (issue #55 review, defect 3): `kt` present means
 * `news` IS the first segment (`news=daerah&kt=Sampit` is
 * `/daerah/Sampit.html`); `kt` absent means `news` is the bare rubrik value
 * that `/rubrik/{news}.html` itself carries.
 *
 * Pagination (`&lanjut=<n>`, n>1) only ever lands on a real
 * `/rubrik/{slug}/halaman/{n}` page — `daerah`/`mitra`/`umum` (via
 * `resolveTwoSegmentHtml`) have no paginated route in this app at all, so a
 * `&lanjut=` on one of those is ignored and the bare (page-one) destination
 * is returned instead of a URL nothing would serve.
 *
 * @param {URLSearchParams} query
 * @returns {string | null}
 */
function resolveRubriksQuery(query) {
  const kt = query.get("kt");
  const news = query.get("news");

  const destination =
    kt && kt.trim() !== ""
      ? resolveTwoSegmentHtml(news ?? "", kt)
      : news && news.trim() !== ""
        ? resolveTwoSegmentHtml("rubrik", news)
        : null;

  // `resolveTwoSegmentHtml` already returns `null` for a segment that
  // normalizes to empty (issue #55 review, defect 4 — `?news=%21%21%21`
  // must not answer `Location: /rubrik/`), and for a first segment it does
  // not recognize; both cases fall straight through here with no redirect.
  if (!destination) return null;
  if (!destination.startsWith("/rubrik/")) return destination;

  const lanjut = Number(query.get("lanjut"));
  return Number.isInteger(lanjut) && lanjut > 1 ? `${destination}/halaman/${lanjut}` : destination;
}

/**
 * `video/index.php?video={id}-{slug}.html`, `{id}_{slug}.html` — the
 * hyphen/underscore both matter (that file's own comment: "Alamat lama
 * (garis bawah, tanpa slug, atau slug basi)" — an old underscore-separated
 * or stale-slug value) — or the bare `?video={id}` shape (no slug at all)
 * the old homepage's own grid hard-coded (issue #55 review, defect 1).
 *
 * Resolved to `/video/{slug}` ONLY when the id is one this app can already
 * recognize as a real video post — a row-based `/video/{id}-…` mapping (the
 * exporter's query-free synthetic key, see `rowIdIndexFor`) exists —
 * otherwise there is no known slug to redirect to, and `/video` (the list)
 * is the honest destination, never a guessed one.
 *
 * This NEVER consults the `/news/…` slice of the row-based map:
 * `berita_vid`'s ids (`id_vid`) are a completely different id space from
 * `berita_red`'s (`id_ber`) behind `/news/…` — see the module docblock's
 * "Two DIFFERENT numeric id spaces" section. Matching a video id against a
 * news row would redirect a reader to a numerically-coincidental, otherwise
 * unrelated article.
 *
 * @param {URLSearchParams} query
 * @param {Record<string, string>} rowMap
 * @returns {string | null}
 */
function resolveVideoQuery(query, rowMap) {
  const videoParam = query.get("video");
  if (!videoParam) return null;

  const trimmed = videoParam.trim();
  const id = /^\d+$/.exec(trimmed)?.[0] ?? /^(\d+)[-_].*\.html$/i.exec(trimmed)?.[1];
  if (!id) return null;

  const target = findVideoRowTargetById(rowMap, id);
  return target ? `/video/${lastPathSegment(target)}` : VIDEO_LIST_PAGE;
}

/**
 * `img/index.php?news={id}` — the second, now-deleted article renderer;
 * `img/index.php` itself has redirected to the canonical article (or home)
 * since seputarborneo's own migration. This app has no `/img/` page at all,
 * so a bare `/img` with no `news` parameter matches no rule here (falls
 * through to whatever the adapter does with an unknown path) — only the
 * `?news=` shape is a real inbound legacy link worth honoring.
 *
 * @param {URLSearchParams} query
 * @param {Record<string, string>} rowMap
 * @returns {string | null}
 */
function resolveImgQuery(query, rowMap) {
  const newsParam = query.get("news");
  if (newsParam === null) return null;

  const id = newsParam.trim();
  if (/^\d+$/.test(id)) {
    const target = findNewsRowTargetById(rowMap, id);
    if (target) return target;
  }

  return NEWS_FRONT_PAGE;
}

/**
 * `pencarian/index.php?cari_berita={q}` — the ONE non-301 rule in this
 * module: a search result is not a permanently-moved resource, so a search
 * engine that indexed the old search URL must not be told the new one is
 * its permanent replacement.
 *
 * @param {URLSearchParams} query
 * @returns {{ location: string, status: 302 } | null}
 */
function resolveSearchQuery(query) {
  const q = query.get("cari_berita");
  if (q === null) return null;

  const trimmed = q.trim();
  const location = trimmed ? `${NEWS_SEARCH_PAGE}?q=${encodeURIComponent(trimmed)}` : NEWS_SEARCH_PAGE;
  return { location, status: 302 };
}

// ---------------------------------------------------------------------------
// The public entry point.
// ---------------------------------------------------------------------------

/**
 * The rule-based destination for `url`, or `null` when no rule matches —
 * called by `server/penyaji.mjs`'s `legacyRedirectLocation()` ONLY after the
 * CMS-row map has already missed (see the module docblock for why rows
 * win).
 *
 * Returns a plain `string` for the common 301 case (matching
 * `legacyRedirectLocation`'s own existing return shape, so every caller —
 * including `apps/storefront/tests/berita-penyaji-legacy.test.ts`, which
 * this issue must not edit — keeps working unchanged), or
 * `{ location, status: 302 }` for the one rule that is not a permanent
 * redirect (`resolveSearchQuery` above).
 *
 * Loop guard: every destination this function can return is checked, in
 * `tests/pengalihan-aturan.test.ts`, to match NO source pattern any rule in
 * this module recognizes — a `/rubrik/{slug}` destination carries no
 * `.html` suffix, `/cari-berita` is a different path than `/pencarian`, and
 * so on, so a rule here can never fire a second time on its own output.
 *
 * @param {string} url `req.url` as received.
 * @param {Record<string, string>} [rowMap] The SAME row-based map
 * `legacyRedirectLocation` already consulted — only the video/img rules
 * read it (see `findNewsRowTargetById`/`findVideoRowTargetById` — two
 * DIFFERENT id-space lookups, never conflated; see the module docblock).
 * @returns {string | { location: string, status: 302 } | null}
 */
export function ruleBasedRedirectLocation(url, rowMap = {}) {
  const { path, query } = parseLegacyUrl(url);
  const lowerPath = path.toLowerCase();

  const staticPage = STATIC_PAGE_REDIRECTS.get(lowerPath);
  if (staticPage) return staticPage;

  if (lowerPath === "/index.php") return NEWS_FRONT_PAGE;
  if (path === "/" && query.get("subscribed") === "1") return NEWS_FRONT_PAGE;

  if (lowerPath === "/pencarian") return resolveSearchQuery(query);
  if (lowerPath === "/video") return resolveVideoQuery(query, rowMap);
  if (lowerPath === "/img") return resolveImgQuery(query, rowMap);
  if (lowerPath === "/rubriks") return resolveRubriksQuery(query);

  const twoSegment = twoSegmentHtmlMatch(path);
  if (twoSegment) return resolveTwoSegmentHtml(twoSegment.first, twoSegment.second);

  return null;
}
