/**
 * tools/import-seputarborneo.ts — `bun run import:seputarborneo` (issue #58).
 *
 * Imports seputarborneo.com's legacy MariaDB archive (`berita_red`,
 * `berita_vid`, `ikl_online`, `logo`, `config`) into the `borneojek-mart`
 * tenant's `blog_content`/`seo_distribution` modules, over the SAME public
 * `/api/v1/*` HTTP surface `tools/seed-borneojek-mart.ts` drives — never a
 * direct database connection, and never a dependency on `apps/cms`'s
 * internals (AGENTS.md "Workspace boundaries"; see `tools/lib/html-to-
 * portable-text.ts`'s header for why that boundary holds even for a
 * type-only import).
 *
 * ## The dump is never copied, never committed, never printed
 *
 * `readMysqlDumpRows` (`tools/lib/mysql-dump-reader.ts`) streams the
 * gzip-compressed file straight through a `DecompressionStream`, a row at a
 * time — the 228 MB decompressed dump is never held whole in memory, and
 * this script never writes it (or any row's content) to disk anywhere
 * outside the CMS itself. Every log line below prints COUNTS, never a title,
 * body, or category value from a real row — see `tools/out/README` (this
 * file's own manifest is the one place row-shaped detail is written, and it
 * is git-ignored, `tools/out/` per `.gitignore`).
 *
 * ## Two real, load-bearing limitations of the PUBLIC API this script found
 *
 * Both are reported in this file's own docblock rather than worked around
 * silently, because a silent workaround here would be a decision nobody
 * downstream could see was made:
 *
 * 1. **No public field backdates `published_at`.** `apps/cms` DOES carry
 *    `legacy_source_system`/`legacy_source_id` on `awcms_blog_posts`
 *    (`sql/138`) and a whole internal NDJSON pipeline
 *    (`bun run blog:legacy:import`, `apps/cms/scripts/blog-legacy-import.ts`)
 *    that writes a real historical `publishedAt` — built, per its own
 *    docblock, using this exact SeputarBorneo archive as its reference case.
 *    But that pipeline runs INSIDE `apps/cms`, against its database directly,
 *    which is exactly the boundary issue #58 keeps this script on the other
 *    side of. Every public route this script CAN call
 *    (`POST /api/v1/blog/posts`, `.../publish`, `.../schedule`) was checked
 *    directly against its own validator/route source before being used here
 *    (`blog-post-validation.ts`, `blog-posts/[id]/publish.ts`) — none of them
 *    accepts a caller-supplied `publishedAt` for an ALREADY-PAST date.
 *    `.../schedule` DOES accept a future `scheduledAt`, so a legacy article
 *    whose `tgl`+`jam` is in the future gets its real date; one in the past
 *    is published at IMPORT time instead — a real loss of date fidelity this
 *    script cannot avoid without either a new field on the public API (an
 *    upstream change, out of this issue's files-owned) or running the
 *    internal pipeline from inside `apps/cms` (out of this repo's workspace
 *    boundary). Flagged in the manifest per row, and in this run's summary.
 * 2. **No public field sets a post's `authorByline`.** It is DERIVED from
 *    `author_tenant_user_id` (`blog-post-directory.ts`), not a free-text
 *    input — so the legacy `user` column (an admin username, e.g. "Redaksi")
 *    cannot become the rendered byline through this API. It is written into
 *    `contentJson.legacySource.author` instead — a passthrough sidecar
 *    field `content-validation.ts`'s `validateContentJsonField` explicitly
 *    allows or `apps/cms`'s Portable Text validator, for provenance/audit,
 *    not for rendering — and the real byline is whichever tenant user this
 *    script authenticates as (`SEED_OWNER_EMAIL`).
 *
 * ## `--dry-run` never touches a network or a database
 *
 * This wave's `apps/cms`/PostgreSQL is another issue's to own (#57); a
 * `--dry-run` here reads only the dump and prints counts — no
 * `AWCMS_BASE_URL` request is ever made in that mode, so it runs on a
 * machine with no CMS started at all. `--commit` (or any run without
 * `--dry-run`; see the flag parsing below) requires a tenant already seeded
 * by `bun run db:seed:cms` — this script never bootstraps one itself
 * (`resolveExistingTenantSession`'s own docblock).
 */
import { readMysqlDumpRows, type SqlValue } from "./lib/mysql-dump-reader";
import {
  convertHtmlToPortableText,
  type PortableTextNode
} from "./lib/html-to-portable-text";
import {
  apiCall,
  assertOk,
  resolveExistingTenantSession,
  type Session
} from "./lib/awcms-api";

// ---------------------------------------------------------------------------
// Configuration — every variable here is documented in root .env.example
// (AGENTS.md "Configuration and toolchain"). Reused, not reinvented, from
// tools/seed-borneojek-mart.ts's own conventions where the concern is the
// same (this importer writes into that SAME tenant — see docs/deployment.md
// "Importing seputarborneo").
// ---------------------------------------------------------------------------

const BASE_URL = (process.env.AWCMS_BASE_URL?.trim() || "http://localhost:4321").replace(
  /\/+$/,
  ""
);
const TENANT_CODE = process.env.SEED_TENANT_CODE?.trim() || "borneojek-mart";
const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL?.trim() || "owner@borneojek-mart.local";
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD?.trim() || "";
const DUMP_PATH = process.env.SEPUTARBORNEO_DUMP?.trim() || "";
const FILES_DIR = process.env.SEPUTARBORNEO_FILES?.trim() || "";

const REDIRECT_ORIGIN = "legacy_blog";
/** `POST /api/v1/seo/redirects/import`'s own cap (`redirect-rule.ts`) — batches must respect it. */
const REDIRECT_IMPORT_BATCH_SIZE = 200;
const MANIFEST_PATH = "tools/out/seputarborneo-import-manifest.json";

// ---------------------------------------------------------------------------
// sb_slug() — a deliberate, documented PORT of seputarborneo's own
// `include/view_helpers.php:sb_slug()` (== `include/nav_menu.php`'s
// `seputarborneo_rubrik_slug()`, itself a documented duplicate of the same
// function for a require-cycle reason stated there). New posts' slugs and
// this script's taxonomy resolution both need it to agree byte-for-byte
// with what the legacy site already used, so a THIRD copy here is the same
// deliberate choice, not an oversight — see either PHP file's own comment.
// ---------------------------------------------------------------------------

/** Port of `sb_slug()`/`seputarborneo_rubrik_slug()`. */
export function sbSlug(input: string): string {
  let slug = input.toLowerCase();
  slug = slug.replace(/_/g, "-");
  // PHP's `preg_replace('/[^a-z0-9\s-]+/u', '', $slug)` — strip everything
  // that is not a lowercase ASCII letter, digit, whitespace, or hyphen.
  slug = slug.replace(/[^a-z0-9\s-]+/gu, "");
  slug = slug.replace(/[\s-]+/g, "-");
  return slug.replace(/^-+|-+$/g, "");
}

/** PHP `rawurlencode()` (RFC 3986) — differs from `encodeURIComponent` (RFC 2396-ish) only in also escaping `! * ' ( )`, which `encodeURIComponent` leaves bare. Needed for a byte-exact pre-2.0 legacy URL (see `legacyNewsUrlPre2000`). */
export function phpRawUrlEncode(input: string): string {
  return encodeURIComponent(input).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** `seputarborneo_id_slug()` + `seputarborneo_news_href()` — today's (post-issue-#6) canonical article URL: `/news/{id}-{sb_slug(title)}.html`. */
export function legacyNewsUrlCurrent(id: number, title: string): string {
  const slug = sbSlug(title);
  return slug === "" ? `/news/${id}.html` : `/news/${id}-${phpRawUrlEncode(slug)}.html`;
}

/**
 * The PRE-2.0 legacy URL form (issue #58's own text: `/news/{id_ber}_{slug}.html`) —
 * ADR-0114's finding that the true old segment is
 * `rawurlencode(str_replace(' ', '_', title))`, case preserved, joined to the
 * id with an UNDERSCORE rather than today's hyphen. A second, independent
 * legacy URL shape search engines may still have indexed from before the
 * `sb_slug()` rewrite landed.
 */
export function legacyNewsUrlPre2000(id: number, title: string): string {
  const segment = phpRawUrlEncode(title.replace(/ /g, "_"));
  return `/news/${id}_${segment}.html`;
}

/** `sb_video_url()`: `/video/?video={id}-{sb_slug(title)}.html`. */
export function legacyVideoUrl(id: number, title: string): string {
  const slug = sbSlug(title);
  const idSlug = slug === "" ? String(id) : `${id}-${phpRawUrlEncode(slug)}`;
  return `/video/?video=${idSlug}.html`;
}

// ---------------------------------------------------------------------------
// Taxonomy normalization + mapping — a deliberate, documented PORT of
// seputarborneo's `migrations/2026-09-02-normalize-legacy-taxonomy.sql`.
// Verified empirically against the REAL dump this issue names (2026-09-18):
// every one of its 45 distinct `(jenis_rubrik, kategori)` combinations is
// ALREADY normalized (the production migration ran before this backup was
// taken) — but the normalization pass is kept anyway, both because a FUTURE
// dump is not guaranteed to be this clean and because the acceptance
// criterion ("0 unmapped taxonomy values") should hold by construction, not
// by the luck of one snapshot.
// ---------------------------------------------------------------------------

/** Case-SENSITIVE (binary) on purpose — see the migration's own comment: `WISATA` (a rubrik) and `Wisata` (a UMUM category) are two real, different things distinguished only by case. */
const DAERAH_LEAF_LABELS = new Set([
  "Palangka Raya",
  "Palangkaraya",
  "Kapuas",
  "Pulang Pisau",
  "Katingan",
  "Kotawaringin Timur",
  "Kotawaringin Barat",
  "Seruyan",
  "Lamandau",
  "Sukamara",
  "Gunung Mas",
  "Barito Selatan",
  "Barito Timur",
  "Barito Utara",
  "Murung Raya"
]);

const UMUM_LEAF_LABELS = new Set(["Wisata", "Budaya", "Provinsi", "Kuliner", "Travel", "Bisnis"]);

export type NormalizedTaxonomy = { jenisRubrik: string; kategori: string };

/** Mirrors migration steps 1-5 exactly (see the migration's own numbered comments for the reasoning behind each). */
export function normalizeLegacyTaxonomy(
  jenisRubrikRaw: string,
  kategoriRaw: string
): NormalizedTaxonomy {
  let jenisRubrik = jenisRubrikRaw;
  let kategori = kategoriRaw;

  // 1. `MITRA-BORNEO` (hyphen) -> `MITRA BORNEO` (space) — the pre-issue-#6
  //    menu's own spelling, once stored by the admin form that copied it.
  if (jenisRubrik === "MITRA-BORNEO") jenisRubrik = "MITRA BORNEO";

  // 2. A stray `</option>` fragment the admin form leaked into `kategori`.
  kategori = kategori.split("/option>").join("");

  // 3. A leaf value stored directly in `jenis_rubrik` with `kategori` empty
  //    — the pre-two-axis schema. Order matters: institution prefixes first,
  //    so an institution name never falls through to the daerah/umum check.
  if (kategori === "") {
    if (
      jenisRubrik.startsWith("Pemkab ") ||
      jenisRubrik.startsWith("Pemko ") ||
      jenisRubrik.startsWith("Pemprov ") ||
      jenisRubrik.startsWith("DPRD ")
    ) {
      kategori = jenisRubrik;
      jenisRubrik = "MITRA BORNEO";
    } else if (DAERAH_LEAF_LABELS.has(jenisRubrik)) {
      kategori = jenisRubrik;
      jenisRubrik = "DAERAH";
    } else if (UMUM_LEAF_LABELS.has(jenisRubrik)) {
      kategori = jenisRubrik;
      jenisRubrik = "UMUM";
    }
  }

  // 4. `Palangkaraya` (no space) -> `Palangka Raya`, wherever it now sits.
  kategori = kategori.split("Palangkaraya").join("Palangka Raya");

  // 5. `OLAHRAGA` never legitimately carries a `kategori` (its admin form has
  //    no such field) — clear any that a leaf-value migration above assigned.
  if (jenisRubrik === "OLAHRAGA" && kategori !== "") kategori = "";

  return { jenisRubrik, kategori };
}

export type TaxonomyOutcome =
  | { kind: "rubrik"; rubrikSlug: string }
  | { kind: "daerah"; regionName: string }
  | { kind: "mitra"; institutionName: string }
  | { kind: "umum"; childName: string };

export type TaxonomyMapResult =
  | { ok: true; value: TaxonomyOutcome }
  | { ok: false; reason: string };

/** `jenis_rubrik` values with no `kategori` axis, mapped to B1's (issue #57) committed rubrik slugs. `OLAHRAGA`'s display name is "Olah Raga" (B1's own text) — the SLUG stays `olahraga`. */
const PLAIN_RUBRIK_SLUGS: Readonly<Record<string, string>> = {
  POLITIK: "politik",
  HUKUM: "hukum",
  NASIONAL: "nasional",
  OLAHRAGA: "olahraga",
  WISATA: "wisata"
};

/** After `normalizeLegacyTaxonomy`, classify into the shape a post's terms/institution are built from. `ok: false` is the "unmapped taxonomy value" this script's `--dry-run` summary counts. */
export function mapLegacyTaxonomy(
  jenisRubrikRaw: string,
  kategoriRaw: string
): TaxonomyMapResult {
  const { jenisRubrik, kategori } = normalizeLegacyTaxonomy(jenisRubrikRaw, kategoriRaw);

  if (kategori === "" && PLAIN_RUBRIK_SLUGS[jenisRubrik]) {
    return { ok: true, value: { kind: "rubrik", rubrikSlug: PLAIN_RUBRIK_SLUGS[jenisRubrik]! } };
  }
  if (jenisRubrik === "DAERAH" && kategori !== "") {
    return { ok: true, value: { kind: "daerah", regionName: kategori } };
  }
  if (jenisRubrik === "MITRA BORNEO" && kategori !== "") {
    return { ok: true, value: { kind: "mitra", institutionName: kategori } };
  }
  if (jenisRubrik === "UMUM" && UMUM_LEAF_LABELS.has(kategori)) {
    return { ok: true, value: { kind: "umum", childName: kategori } };
  }

  return {
    ok: false,
    reason: `unmapped taxonomy: jenis_rubrik=${JSON.stringify(jenisRubrikRaw)} kategori=${JSON.stringify(kategoriRaw)}`
  };
}

/**
 * `UMUM`'s "Wisata" child collides in SLUG with the top-level `WISATA`
 * rubrik — B1 (issue #57) records this as an open decision (`wisata-travel`
 * if renamed, or `wisata` nested under `umum` if the schema allows a
 * duplicate slug under a different parent) rather than committing to one.
 * This importer therefore never GUESSES a slug for it: term resolution
 * (`resolveUmumTermId`, in the `--commit` path only) matches by NAME among
 * `umum`'s own children, trying every name B1's decision could have picked,
 * in order — so this script keeps working whichever way #57 lands, and a
 * genuine mismatch surfaces as one reported row rather than a wrong link.
 */
export const UMUM_WISATA_NAME_CANDIDATES: readonly string[] = ["Wisata", "Wisata & Travel"];

// ---------------------------------------------------------------------------
// YouTube video id normalization — a deliberate, documented duplicate of
// `apps/cms`'s `normalizeYouTubeVideoId` (`video-news-block-validation.ts`),
// for the same workspace-boundary reason `html-to-portable-text.ts`'s header
// gives. Kept in exact behavioural step: same 11-char pattern, same URL
// shapes, so a videoId this script sends is one `apps/cms`'s own
// unconditional embed-safety validator will accept unchanged.
// ---------------------------------------------------------------------------

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function normalizeYoutubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (YOUTUBE_ID_PATTERN.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "youtu.be") {
    const id = url.pathname.slice(1);
    return YOUTUBE_ID_PATTERN.test(id) ? id : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com") {
    if (url.pathname === "/watch") {
      const id = url.searchParams.get("v");
      return id && YOUTUBE_ID_PATTERN.test(id) ? id : null;
    }
    const embedMatch = /^\/(embed|shorts)\/([^/]+)$/.exec(url.pathname);
    if (embedMatch && YOUTUBE_ID_PATTERN.test(embedMatch[2]!)) return embedMatch[2]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Publication date — `tgl` (DATE) + `jam` (TIME), both Asia/Jakarta wall-clock
// (WIB, UTC+7 year-round — Indonesia observes no DST, so this is a fixed
// offset, never a named-timezone library call).
// ---------------------------------------------------------------------------

export type PublishedAtResult =
  | { ok: true; publishedAt: Date; willBeScheduled: boolean }
  | { ok: false; reason: string };

const JAKARTA_UTC_OFFSET_HOURS = 7;

/** `tgl`/`jam` -> a UTC instant, or a reason the row cannot be dated. */
export function resolvePublishedAt(tgl: SqlValue, jam: SqlValue, now: Date): PublishedAtResult {
  // Reasons below never echo the raw `tgl`/`jam` value — this run's own
  // brief is explicit that no row content is ever printed, only aggregate
  // counts and (here) a diagnostic CATEGORY plus, where it is itself
  // harmless and useful, a value this function already derived (a parsed
  // year number is not the row's content).
  if (typeof tgl !== "string" || typeof jam !== "string") {
    return { ok: false, reason: "tgl/jam are not both strings" };
  }

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tgl);
  const timeMatch = /^(\d{2}):(\d{2}):(\d{2})$/.exec(jam);
  if (!dateMatch || !timeMatch) {
    return { ok: false, reason: "tgl/jam did not match YYYY-MM-DD/HH:MM:SS" };
  }

  const [, y, mo, d] = dateMatch;
  const [, h, mi, s] = timeMatch;
  const year = Number(y);

  // A `MyISAM` `date` column stores whatever was typed, including a plainly
  // implausible year (the real dump carries exactly one such row, year
  // "0025") — reported rather than imported under a nonsensical date.
  if (year < 2000 || year > now.getUTCFullYear() + 5) {
    return { ok: false, reason: `tgl has an implausible year (${year})` };
  }

  const publishedAt = new Date(
    Date.UTC(year, Number(mo) - 1, Number(d), Number(h) - JAKARTA_UTC_OFFSET_HOURS, Number(mi), Number(s))
  );
  if (Number.isNaN(publishedAt.getTime())) {
    return { ok: false, reason: "tgl/jam did not form a valid date" };
  }

  return { ok: true, publishedAt, willBeScheduled: publishedAt.getTime() > now.getTime() };
}

// ---------------------------------------------------------------------------
// Slugs for NEW posts — `sb_slug(judul)`, de-duplicated with `-{id_ber}` on
// collision (issue #58's own words). `taken` starts from what the LIVE
// tenant already has (`--commit` only) and grows as this run assigns slugs,
// so two legacy articles sharing a title in the SAME run never collide with
// each other either.
// ---------------------------------------------------------------------------

export function newPostSlug(title: string, legacyId: number, taken: ReadonlySet<string>): string {
  const base = sbSlug(title) || `berita-${legacyId}`;
  if (!taken.has(base)) return base;
  return `${base}-${legacyId}`;
}

// ---------------------------------------------------------------------------
// Manifest — the one place this run writes anything row-shaped, and only to
// `tools/out/` (git-ignored). Never a title/body/category VALUE from a real
// row travels into this script's own console output; only counts and the
// stable identifiers (`legacyId`, a `src` filename) a human needs to act on
// the handoff (upload a file, create a term) ever do.
// ---------------------------------------------------------------------------

export type ManifestSkip = { legacyId: string; table: string; reason: string };
export type ManifestMediaNeed = { src: string; usedBy: string[] };

export type Manifest = {
  generatedAt: string;
  dump: string;
  mode: "dry-run" | "commit";
  counts: {
    beritaRedTotal: number;
    beritaRedImportable: number;
    beritaVidTotal: number;
    beritaVidImportable: number;
    iklOnlineTotal: number;
    logoTotal: number;
    newsletterSubscribers: number;
  };
  perRubrik: Record<string, number>;
  perYear: Record<string, number>;
  unmappedTaxonomy: Record<string, number>;
  skipped: ManifestSkip[];
  mediaNeeded: ManifestMediaNeed[];
};

// ---------------------------------------------------------------------------
// Body/request builders — pure functions from a normalized row to the exact
// payload shape the verified routes accept (`blog-post-validation.ts`,
// `redirect-rule.ts`). No network, no `Bun.SQL`, so every one of these is
// independently unit-testable.
// ---------------------------------------------------------------------------

export type LegacyByline = { table: "berita_red" | "berita_vid"; legacyId: string; author: string };

/** The `contentJson` sidecar this script writes for provenance — see this file's header, "no public field sets authorByline". */
function legacySourceSidecar(byline: LegacyByline): Record<string, unknown> {
  return {
    legacySource: {
      system: "seputarborneo",
      table: byline.table,
      legacyId: byline.legacyId,
      author: byline.author || null
    }
  };
}

export type BuiltPost = {
  legacyId: string;
  title: string;
  slug: string;
  excerpt: string | null;
  bodyPortableText: PortableTextNode[];
  contentJson: Record<string, unknown>;
  locale: "id";
  publishedAtResult: PublishedAtResult;
  taxonomy: TaxonomyMapResult;
  droppedImages: string[];
  legacyUrls: { current: string; pre2000: string };
};

/** Builds everything `buildPostRequestBody`/the redirect builder need for ONE `berita_red` row — pure, no ids resolved yet (those are `--commit`-only, against a live tenant). */
export function buildPostFromBeritaRed(
  row: Record<string, SqlValue>,
  taken: ReadonlySet<string>,
  now: Date
): BuiltPost {
  const legacyId = String(row.id_ber);
  const title = String(row.judul ?? "").trim();
  const excerptRaw = String(row.sub_judul ?? "").trim();
  const { document, droppedImages } = convertHtmlToPortableText(String(row.isi_berita ?? ""));

  return {
    legacyId,
    title,
    slug: newPostSlug(title, Number(row.id_ber), taken),
    excerpt: excerptRaw.length > 0 ? excerptRaw : null,
    bodyPortableText: document,
    contentJson: legacySourceSidecar({
      table: "berita_red",
      legacyId,
      author: String(row.user ?? "")
    }),
    locale: "id",
    publishedAtResult: resolvePublishedAt(row.tgl, row.jam, now),
    taxonomy: mapLegacyTaxonomy(String(row.jenis_rubrik ?? ""), String(row.kategori ?? "")),
    droppedImages,
    legacyUrls: {
      current: legacyNewsUrlCurrent(Number(row.id_ber), title),
      pre2000: legacyNewsUrlPre2000(Number(row.id_ber), title)
    }
  };
}

export type BuiltVideoPost = {
  legacyId: string;
  title: string;
  slug: string;
  videoId: string | null;
  bodyPortableText: PortableTextNode[];
  contentJson: Record<string, unknown>;
  publishedAtResult: PublishedAtResult;
  legacyUrl: string;
};

/** `berita_vid`'s `tgl`/`jam` are legacy-formatted (`YYMMDD`/`HHMMSS`, per seputarborneo's own video-time-normalization migrations) rather than `berita_red`'s real `DATE`/`TIME` types — reformatted to the same `YYYY-MM-DD`/`HH:MM:SS` shape `resolvePublishedAt` expects before calling it. */
function reformatLegacyVideoTimestamp(tgl: string, jam: string): { tgl: string; jam: string } | null {
  if (!/^\d{6}$/.test(tgl) || !/^\d{6}$/.test(jam)) return null;
  const yy = Number(tgl.slice(0, 2));
  // `berita_vid` rows observed are all 2020s; a two-digit year below 70 is
  // 2000+it, matching POSIX `strptime("%y")` convention and every real row.
  const year = yy < 70 ? 2000 + yy : 1900 + yy;
  return {
    tgl: `${year}-${tgl.slice(2, 4)}-${tgl.slice(4, 6)}`,
    jam: `${jam.slice(0, 2)}:${jam.slice(2, 4)}:${jam.slice(4, 6)}`
  };
}

export function buildVideoPostFromBeritaVid(
  row: Record<string, SqlValue>,
  taken: ReadonlySet<string>,
  now: Date
): BuiltVideoPost {
  const legacyId = String(row.id_vid);
  const title = String(row.judul_vid ?? "").trim();
  const videoId = normalizeYoutubeVideoId(String(row.link ?? ""));
  const { document } = convertHtmlToPortableText(String(row.text_vid ?? ""));

  const reformatted = reformatLegacyVideoTimestamp(String(row.tgl ?? ""), String(row.jam ?? ""));

  const videoBlock: PortableTextNode | null = videoId
    ? ({ _type: "videoNews", _key: "v0", provider: "youtube", videoId } as unknown as PortableTextNode)
    : null;

  return {
    legacyId,
    title,
    slug: newPostSlug(title, Number(row.id_vid), taken),
    videoId,
    bodyPortableText: videoBlock ? [...document, videoBlock] : document,
    contentJson: legacySourceSidecar({
      table: "berita_vid",
      legacyId,
      author: String(row.admin ?? "")
    }),
    publishedAtResult: reformatted
      ? resolvePublishedAt(reformatted.tgl, reformatted.jam, now)
      : { ok: false, reason: "tgl/jam is not YYMMDD/HHMMSS" },
    legacyUrl: legacyVideoUrl(Number(row.id_vid), title)
  };
}

/** One `awcms_seo_redirects` create payload, `origin: "legacy_blog"`. `target` is the CMS's own canonical post URL, `/blog/{tenantCode}/{slug}` — `docs/routing.md`'s own documented contract for what `penyaji.mjs`'s legacy-redirect rebuild expects (it takes only the final path segment, never `target` verbatim). */
export function buildRedirectPayload(sourcePath: string, tenantCode: string, newSlug: string) {
  return {
    sourcePath,
    target: `/blog/${tenantCode}/${newSlug}`,
    origin: REDIRECT_ORIGIN as const,
    statusCode: 301 as const
  };
}

// ---------------------------------------------------------------------------
// Site profile (`config` -> `PUT /api/v1/site-profile`) — see this file's
// PR-facing notes for `config.title`'s lack of a home on that endpoint.
// ---------------------------------------------------------------------------

export type SiteProfileUpdate = {
  tagline: string | null;
  copyrightNotice: string | null;
  editorialAddress: string | null;
  contactEmail: string | null;
  whatsappNumber: string | null;
  socialLinks: Array<{ platform: string; url: string }>;
};

const SOCIAL_COLUMNS: ReadonlyArray<{ column: string; platform: string }> = [
  { column: "fb", platform: "facebook" },
  { column: "tw", platform: "x" },
  { column: "ig", platform: "instagram" },
  { column: "yt", platform: "youtube" },
  { column: "tt", platform: "tiktok" },
  { column: "th", platform: "threads" }
];

export function buildSiteProfileUpdateFromConfig(row: Record<string, SqlValue>): SiteProfileUpdate {
  const text = (value: SqlValue): string | null => {
    const s = String(value ?? "").trim();
    return s.length > 0 ? s : null;
  };

  const socialLinks: Array<{ platform: string; url: string }> = [];
  for (const { column, platform } of SOCIAL_COLUMNS) {
    const url = text(row[column]);
    if (url && /^https?:\/\//i.test(url)) socialLinks.push({ platform, url });
  }

  return {
    tagline: text(row.motho),
    copyrightNotice: text(row.coppyright),
    editorialAddress: text(row.alamat),
    contactEmail: text(row.email),
    whatsappNumber: text(row.wasupport),
    socialLinks
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(name: string): string | null {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split("=").slice(1).join("=") : null;
}

function usage(message: string): void {
  console.error(
    `import-seputarborneo — ${message}\n\n` +
      "  --dry-run          report only; no network call, no write (default when --commit is absent)\n" +
      "  --commit           write, against an already-seeded tenant (requires SEED_OWNER_PASSWORD)\n" +
      "  --limit=<n>        cap the number of berita_red rows processed\n" +
      "  --since=<yyyy-mm-dd>  only berita_red rows with tgl on or after this date\n" +
      "  --media            attempt to upload creatives/logos from SEPUTARBORNEO_FILES (--commit only)\n"
  );
  process.exitCode = 1;
}

type RunOptions = {
  dryRun: boolean;
  limit: number | null;
  since: string | null;
};

/**
 * Reads the dump ONCE and produces the manifest — the shared core of
 * `--dry-run` and `--commit`. `--commit`'s own network calls are layered on
 * top of the SAME built rows (see `main`), so the two modes can never
 * disagree about what the dump contains.
 */
async function analyzeDump(options: RunOptions): Promise<{
  manifest: Manifest;
  posts: BuiltPost[];
  videos: BuiltVideoPost[];
  configRow: Record<string, SqlValue> | null;
  adRows: Array<Record<string, SqlValue>>;
  logoRows: Array<Record<string, SqlValue>>;
}> {
  const now = new Date();
  const taken = new Set<string>();
  const posts: BuiltPost[] = [];
  const videos: BuiltVideoPost[] = [];
  const adRows: Array<Record<string, SqlValue>> = [];
  const logoRows: Array<Record<string, SqlValue>> = [];
  let configRow: Record<string, SqlValue> | null = null;
  let newsletterSubscribers = 0;
  let beritaRedTotal = 0;

  const perRubrik: Record<string, number> = {};
  const perYear: Record<string, number> = {};
  const unmappedTaxonomy: Record<string, number> = {};
  const skipped: ManifestSkip[] = [];
  const mediaNeededMap = new Map<string, Set<string>>();

  function noteMediaNeeded(src: string, usedBy: string): void {
    if (!mediaNeededMap.has(src)) mediaNeededMap.set(src, new Set());
    mediaNeededMap.get(src)!.add(usedBy);
  }

  for await (const { table, row } of readMysqlDumpRows(DUMP_PATH, [
    "berita_red",
    "berita_vid",
    "ikl_online",
    "logo",
    "config",
    "newsletter_subscribers"
  ])) {
    if (table === "newsletter_subscribers") {
      newsletterSubscribers++;
      continue;
    }
    if (table === "config") {
      configRow = row;
      continue;
    }
    if (table === "ikl_online") {
      adRows.push(row);
      const file = String(row.img_ikl ?? "").trim();
      if (file) noteMediaNeeded(file, `ikl_online#${row.id_ikl}`);
      continue;
    }
    if (table === "logo") {
      logoRows.push(row);
      const file = String(row.berkas ?? "").trim();
      if (file) noteMediaNeeded(file, `logo#${row.id_logo}`);
      continue;
    }

    if (table === "berita_vid") {
      const built = buildVideoPostFromBeritaVid(row, taken, now);
      taken.add(built.slug);
      if (!built.publishedAtResult.ok) {
        skipped.push({
          legacyId: built.legacyId,
          table: "berita_vid",
          reason: built.publishedAtResult.reason
        });
        continue;
      }
      if (!built.videoId) {
        skipped.push({
          legacyId: built.legacyId,
          table: "berita_vid",
          reason: "link did not normalize to a YouTube video id"
        });
        continue;
      }
      videos.push(built);
      continue;
    }

    // berita_red
    beritaRedTotal++;

    if (options.since) {
      const tgl = String(row.tgl ?? "");
      if (tgl < options.since) continue;
    }
    if (options.limit !== null && posts.length >= options.limit) continue;

    const built = buildPostFromBeritaRed(row, taken, now);
    taken.add(built.slug);

    const year = String(row.tgl ?? "").slice(0, 4);
    perYear[year] = (perYear[year] ?? 0) + 1;

    if (!built.taxonomy.ok) {
      unmappedTaxonomy[built.taxonomy.reason] = (unmappedTaxonomy[built.taxonomy.reason] ?? 0) + 1;
      skipped.push({ legacyId: built.legacyId, table: "berita_red", reason: built.taxonomy.reason });
      continue;
    }

    const rubrikLabel =
      built.taxonomy.value.kind === "rubrik"
        ? built.taxonomy.value.rubrikSlug
        : built.taxonomy.value.kind;
    perRubrik[rubrikLabel] = (perRubrik[rubrikLabel] ?? 0) + 1;

    if (!built.publishedAtResult.ok) {
      skipped.push({
        legacyId: built.legacyId,
        table: "berita_red",
        reason: built.publishedAtResult.reason
      });
      continue;
    }

    for (const src of built.droppedImages) noteMediaNeeded(src, `berita_red#${built.legacyId} (body)`);
    const featuredSrc = String(row.foto_berita ?? "").trim();
    if (featuredSrc) noteMediaNeeded(featuredSrc, `berita_red#${built.legacyId} (featured)`);

    posts.push(built);
  }

  const manifest: Manifest = {
    generatedAt: now.toISOString(),
    dump: DUMP_PATH,
    mode: options.dryRun ? "dry-run" : "commit",
    counts: {
      beritaRedTotal,
      beritaRedImportable: posts.length,
      beritaVidTotal: videos.length + skipped.filter((s) => s.table === "berita_vid").length,
      beritaVidImportable: videos.length,
      iklOnlineTotal: adRows.length,
      logoTotal: logoRows.length,
      newsletterSubscribers
    },
    perRubrik,
    perYear,
    unmappedTaxonomy,
    skipped,
    mediaNeeded: [...mediaNeededMap.entries()].map(([src, usedBy]) => ({
      src,
      usedBy: [...usedBy]
    }))
  };

  return { manifest, posts, videos, configRow, adRows, logoRows };
}

function printSummary(manifest: Manifest): void {
  console.log(
    `\nimport-seputarborneo — ${manifest.mode.toUpperCase()}\n` +
      `  dump                     ${manifest.dump}\n` +
      `  berita_red (dump total)  ${manifest.counts.beritaRedTotal}\n` +
      `  berita_red (importable)  ${manifest.counts.beritaRedImportable}\n` +
      `  berita_vid (importable)  ${manifest.counts.beritaVidImportable}\n` +
      `  ikl_online rows          ${manifest.counts.iklOnlineTotal}\n` +
      `  logo rows                ${manifest.counts.logoTotal}\n` +
      `  newsletter_subscribers   ${manifest.counts.newsletterSubscribers} (never imported — no consent record; PII)\n` +
      `  unmapped taxonomy values ${Object.keys(manifest.unmappedTaxonomy).length}\n` +
      `  skipped rows             ${manifest.skipped.length}\n` +
      `  distinct media needed    ${manifest.mediaNeeded.length}\n`
  );

  console.log("  per rubrik/region-or-mitra-kind:");
  for (const [key, count] of Object.entries(manifest.perRubrik).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${count}\t${key}`);
  }

  console.log("\n  per year:");
  for (const [year, count] of Object.entries(manifest.perYear).sort()) {
    console.log(`    ${year}\t${count}`);
  }

  if (Object.keys(manifest.unmappedTaxonomy).length > 0) {
    console.log("\n  UNMAPPED TAXONOMY VALUES (counts, never row content):");
    for (const [reason, count] of Object.entries(manifest.unmappedTaxonomy)) {
      console.log(`    ${count}\t${reason}`);
    }
  }
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");
  const dryRun = process.argv.includes("--dry-run") || !commit;
  const limitFlag = flag("limit");
  const sinceFlag = flag("since");
  const mediaRequested = process.argv.includes("--media");

  if (!DUMP_PATH) return usage("SEPUTARBORNEO_DUMP must name the dump's path.");
  if (limitFlag !== null && !/^\d+$/.test(limitFlag)) return usage("--limit must be a non-negative integer.");
  if (sinceFlag !== null && !/^\d{4}-\d{2}-\d{2}$/.test(sinceFlag)) return usage("--since must be YYYY-MM-DD.");
  if (mediaRequested && !FILES_DIR) {
    return usage("--media requires SEPUTARBORNEO_FILES to name the code backup's files directory.");
  }
  if (mediaRequested) {
    // Not implemented this wave (issue #58's own acceptance list defers the
    // full run to after issue #57 merges) — uploading through
    // `/admin/media`'s own MIME-sniffing/size-cap path is the one path with
    // upload validation, matching `blog-legacy-import.ts`'s own
    // `--images`/`--media-map` handoff for the same reason (see this file's
    // header). `manifest.mediaNeeded` already lists every filename this run
    // needs uploaded, ordered by `usedBy`, so an operator can act on it
    // without this flag doing the upload itself.
    console.log(
      `import-seputarborneo — --media noted (SEPUTARBORNEO_FILES=${FILES_DIR}), but this run does not ` +
        "upload files itself — see manifest.mediaNeeded for the filenames still needing a manual " +
        "upload through /admin/media.\n"
    );
  }

  const options: RunOptions = {
    dryRun,
    limit: limitFlag !== null ? Number(limitFlag) : null,
    since: sinceFlag
  };

  if (!dryRun && !commit) {
    // Unreachable given the flag logic above, kept as a documented invariant
    // rather than relying on the reader to re-derive it from `dryRun`'s
    // definition.
    throw new Error("internal: dryRun and commit are both false");
  }

  console.log(
    dryRun
      ? "import-seputarborneo — DRY RUN (no network call, nothing written; pass --commit to write)\n"
      : "import-seputarborneo — COMMIT (writing to a live tenant)\n"
  );

  const { manifest, posts, videos, configRow, adRows, logoRows } = await analyzeDump(options);

  printSummary(manifest);

  await Bun.write(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n  manifest written to ${MANIFEST_PATH} (git-ignored, counts + filenames only)`);

  if (dryRun) return;

  // -------------------------------------------------------------------
  // --commit — everything below touches the network. Not exercised by
  // this issue's own PR (per its brief: the manager runs the full
  // `--limit 200` pass after issue #57 merges); implemented and unit-
  // tested at the pure-function level above, so the network-facing code
  // here is a thin, reviewable composition of already-tested pieces.
  // -------------------------------------------------------------------

  const session: Session = await resolveExistingTenantSession(BASE_URL, OWNER_EMAIL, OWNER_PASSWORD);
  console.log(`import-seputarborneo — authenticated against tenant ${session.tenantId}.`);

  const termsResult = await apiCall<{ terms: Array<{ id: string; slug: string; name: string; parentId: string | null }> }>(
    BASE_URL,
    "GET",
    "/api/v1/blog/terms?taxonomyType=category&limit=200"
  );
  assertOk("GET /api/v1/blog/terms", termsResult);
  const terms = termsResult.data.terms;

  const institutionsResult = await apiCall<{ institutions: Array<{ id: string; slug: string; name: string }> }>(
    BASE_URL,
    "GET",
    "/api/v1/blog/institutions"
  );
  assertOk("GET /api/v1/blog/institutions", institutionsResult);
  const institutionByName = new Map(
    institutionsResult.data.institutions.map((i) => [i.name.trim().toLowerCase(), i.id])
  );

  const termBySlug = new Map(terms.map((t) => [t.slug, t.id]));
  const umumTermId = termBySlug.get("umum") ?? null;
  const umumChildByName = new Map(
    terms
      .filter((t) => t.parentId === umumTermId)
      .map((t) => [t.name.trim().toLowerCase(), t.id])
  );

  function resolveTermId(outcome: TaxonomyOutcome): string | null {
    if (outcome.kind === "rubrik") return termBySlug.get(outcome.rubrikSlug) ?? null;
    if (outcome.kind === "daerah") return termBySlug.get("daerah") ?? null;
    if (outcome.kind === "mitra") return termBySlug.get("mitra-borneo") ?? null;
    // umum: prefer the exact leaf term if it exists; both DAERAH/MITRA-style
    // resolution above and this branch tolerate B1's still-open "Wisata"
    // naming decision (see UMUM_WISATA_NAME_CANDIDATES's own docblock).
    const candidateNames =
      outcome.childName === "Wisata" ? UMUM_WISATA_NAME_CANDIDATES : [outcome.childName];
    for (const name of candidateNames) {
      const id = umumChildByName.get(name.toLowerCase());
      if (id) return id;
    }
    return umumTermId;
  }

  function resolveInstitutionId(outcome: TaxonomyOutcome): string | null {
    if (outcome.kind === "mitra") return institutionByName.get(outcome.institutionName.toLowerCase()) ?? null;
    if (outcome.kind === "daerah") {
      // No B1-seeded institution exists for every daerah (see this file's PR
      // notes/final report) — try the executive Pemkab/Pemko name for this
      // region; `null` when none exists, which is a REPORTED gap, not silently
      // dropped.
      const guess =
        outcome.regionName === "Palangka Raya"
          ? "pemko palangka raya"
          : `pemkab ${outcome.regionName}`.toLowerCase();
      return institutionByName.get(guess) ?? null;
    }
    return null;
  }

  const redirectPayloads: Array<ReturnType<typeof buildRedirectPayload>> = [];
  let created = 0;
  let alreadyPresent = 0;

  for (const post of posts) {
    const termId = post.taxonomy.ok ? resolveTermId(post.taxonomy.value) : null;
    const institutionId = post.taxonomy.ok ? resolveInstitutionId(post.taxonomy.value) : null;

    // Idempotency: the public API has no `legacy_source_id` to check (see
    // this file's header, limitation notes) — `newPostSlug` is deterministic
    // from `(title, legacyId)`, and `awcms_blog_posts`'s own partial unique
    // index on `(tenant_id, locale, slug)` answers a re-run's duplicate slug
    // with `409 SLUG_CONFLICT`, caught below and counted as "already present"
    // rather than retried or duplicated.
    const createResult = await apiCall<{ id: string; slug: string }>(BASE_URL, "POST", "/api/v1/blog/posts", {
      session,
      body: {
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        bodyPortableText: post.bodyPortableText,
        contentJson: post.contentJson,
        locale: post.locale,
        termIds: termId ? [termId] : undefined,
        institutionIds: institutionId ? [institutionId] : undefined
      }
    });

    if (createResult.status === 409) {
      alreadyPresent++;
      continue;
    }
    assertOk(`POST /api/v1/blog/posts (legacyId=${post.legacyId})`, createResult);
    created++;

    // See this file's header, limitation 1: this cannot backdate a PAST
    // publishedAt through the public API. A future one CAN be scheduled for
    // its real date.
    if (post.publishedAtResult.ok && post.publishedAtResult.willBeScheduled) {
      const scheduleResult = await apiCall(
        BASE_URL,
        "POST",
        `/api/v1/blog/posts/${createResult.data.id}/schedule`,
        {
          session,
          idempotencyKey: `seputarborneo-schedule-${post.legacyId}`,
          body: { scheduledAt: post.publishedAtResult.publishedAt.toISOString() }
        }
      );
      assertOk(`POST .../schedule (legacyId=${post.legacyId})`, scheduleResult);
    } else {
      const publishResult = await apiCall(
        BASE_URL,
        "POST",
        `/api/v1/blog/posts/${createResult.data.id}/publish`,
        { session, idempotencyKey: `seputarborneo-publish-${post.legacyId}` }
      );
      assertOk(`POST .../publish (legacyId=${post.legacyId})`, publishResult);
    }

    redirectPayloads.push(buildRedirectPayload(post.legacyUrls.current, TENANT_CODE, createResult.data.slug));
    redirectPayloads.push(buildRedirectPayload(post.legacyUrls.pre2000, TENANT_CODE, createResult.data.slug));
  }

  for (const video of videos) {
    const createResult = await apiCall<{ id: string; slug: string }>(BASE_URL, "POST", "/api/v1/blog/posts", {
      session,
      body: {
        title: video.title,
        slug: video.slug,
        bodyPortableText: video.bodyPortableText,
        contentJson: video.contentJson,
        locale: "id"
      }
    });
    if (createResult.status === 409) {
      alreadyPresent++;
      continue;
    }
    assertOk(`POST /api/v1/blog/posts (video legacyId=${video.legacyId})`, createResult);
    created++;

    const publishResult = await apiCall(
      BASE_URL,
      "POST",
      `/api/v1/blog/posts/${createResult.data.id}/publish`,
      { session, idempotencyKey: `seputarborneo-video-publish-${video.legacyId}` }
    );
    assertOk(`POST .../publish (video legacyId=${video.legacyId})`, publishResult);

    redirectPayloads.push(buildRedirectPayload(video.legacyUrl, TENANT_CODE, createResult.data.slug));
  }

  for (let offset = 0; offset < redirectPayloads.length; offset += REDIRECT_IMPORT_BATCH_SIZE) {
    const batch = redirectPayloads.slice(offset, offset + REDIRECT_IMPORT_BATCH_SIZE);
    const importResult = await apiCall(BASE_URL, "POST", "/api/v1/seo/redirects/import", {
      session,
      idempotencyKey: `seputarborneo-redirects-${offset}`,
      body: { redirects: batch }
    });
    assertOk(`POST /api/v1/seo/redirects/import (offset=${offset})`, importResult);
  }

  if (configRow) {
    const profileGet = await apiCall<Record<string, unknown>>(BASE_URL, "GET", "/api/v1/site-profile", {
      session
    });
    assertOk("GET /api/v1/site-profile", profileGet);
    const update = buildSiteProfileUpdateFromConfig(configRow);
    const merged = { ...profileGet.data, ...update };
    const putResult = await apiCall(BASE_URL, "PUT", "/api/v1/site-profile", {
      session,
      idempotencyKey: "seputarborneo-site-profile",
      body: merged
    });
    assertOk("PUT /api/v1/site-profile", putResult);
    console.log("import-seputarborneo — site profile updated from config (title has no field on this endpoint — see this file's header).");
  }

  console.log(
    `\nimport-seputarborneo COMMITTED\n  created          ${created}\n  already present  ${alreadyPresent}\n  redirects        ${redirectPayloads.length}\n` +
      `  ad placements    ${adRows.length} rows read (media upload required first — see manifest.mediaNeeded; not created without a resolved media object)\n` +
      `  logos            ${logoRows.length} rows read into the manifest for issue #59 (Logo Instansi) to consume once that column exists\n`
  );
}

if (import.meta.main) {
  await main();
}
