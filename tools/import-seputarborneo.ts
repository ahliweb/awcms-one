/**
 * tools/import-seputarborneo.ts — `bun run import:seputarborneo` (issue #58).
 *
 * An EXPORTER. Reads seputarborneo.com's legacy MariaDB archive and writes
 * the input files `apps/cms`'s own operator pipeline for exactly this job
 * expects: `bun run blog:legacy:import` (`apps/cms/scripts/blog-legacy-
 * import.ts`, Issue #599/ADR-0114). See `docs/deployment.md`'s "Importing
 * seputarborneo" section for the full runbook — export here, then a sequence
 * of `apps/cms` commands, then a small follow-up pass this file ALSO runs
 * (`--assign-institutions`, see below).
 *
 * ## Why this is an exporter and not an HTTP client of `POST /api/v1/blog/posts`
 *
 * An earlier version of this file called the public API directly. Two things
 * that pipeline gets right which a public-API client cannot:
 *
 *  - **A real historical `published_at`.** No public route accepts a
 *    caller-supplied `publishedAt` for an already-past date (checked directly
 *    against `blog-post-validation.ts` and every `blog/posts/[id]/*.ts`
 *    route); `blog:legacy:import` writes it straight into the row it inserts.
 *  - **`legacy_source_id`/`legacy_source_system`** (`sql/138`), so a re-run
 *    is idempotent by provenance, not by guessing from a slug, and
 *    `bun run blog:legacy:redirects:import` can derive the 301 map from it
 *    afterwards.
 *
 * It also converts `bodyHtml` to Portable Text itself
 * (`convertLegacyHtmlToPortableText`) — this file does NOT duplicate that
 * converter (an earlier version did; a second converter would diverge from
 * the one whose REFUSALS the pipeline actually reports and acts on). Every
 * `bodyHtml` value this exporter writes is the legacy `isi_berita`/`text_vid`
 * HTML verbatim, untouched, so what the pipeline converts is exactly what the
 * archive contained.
 *
 * ## What the pipeline still cannot do (verified, not assumed) — kept as ONE
 * small follow-up pass in this same file
 *
 * `blog:legacy:import` writes `termIds` (via `--term-map`, calling
 * `syncPostTermAssignments`) but never `institutionIds` — checked directly
 * against `apps/cms/scripts/blog-legacy-import.ts` and
 * `legacy-import-directory.ts`'s `importLegacyBlogPost`: neither calls
 * `syncPostInstitutionAssignments`, and the NDJSON record
 * (`legacy-import-record.ts`) has no field for one. A `DAERAH`/`MITRA
 * BORNEO` article therefore imports with no institution at all — and a post
 * only reaches `/daerah/{slug}` or `/mitra/{slug}` through an institution's
 * `regionCode`/identity (`apps/storefront/src/pages/daerah/[slug].astro`'s
 * own header). Since both routes are issue #58's own acceptance criterion,
 * `--assign-institutions` (this file, run AFTER `blog:legacy:import
 * --commit`) closes that one gap over the public API — the ONLY write this
 * file still performs itself, and the reason `tools/lib/awcms-api.ts`
 * survives this rework (see its own header).
 *
 * The pipeline also has no field for a legacy byline (`user`/`admin`) at
 * all — `--author=<uuid>` is one value for the whole run, and
 * `legacy-import-record.ts` carries no sidecar/metadata field a per-row value
 * could go into. This is a real, unavoidable gap of using the operator
 * pipeline as intended; documented here and in `docs/deployment.md` rather
 * than invented a field on a file this issue does not own.
 *
 * Video posts (`berita_vid`) have no home for an embedded `videoNews` block
 * either — `legacy-import-record.ts` carries only `bodyHtml`, no content-block
 * field. This exporter appends a plain link to the video inside `bodyHtml`
 * instead of an embedded player — a real, documented degradation (see
 * `buildVideoRecord`'s own comment), not an embed.
 *
 * ## The dump is never copied, committed, or printed
 *
 * `tools/lib/mysql-dump-reader.ts` streams it a row at a time; this file's
 * own console output prints only counts. The exported NDJSON/JSON files
 * under `tools/out/` (git-ignored) DO carry row content — titles, bodies,
 * excerpts — because that is their entire purpose (they are
 * `blog:legacy:import`'s own input format), but they never leave this
 * machine through this script.
 */
import { readMysqlDumpRows, type SqlValue } from "./lib/mysql-dump-reader";
import {
  apiCall,
  assertOk,
  resolveExistingTenantSession,
  type Session
} from "./lib/awcms-api";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = (process.env.AWCMS_BASE_URL?.trim() || "http://localhost:4321").replace(
  /\/+$/,
  ""
);
const TENANT_CODE = process.env.SEED_TENANT_CODE?.trim() || "borneojek-mart";
const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL?.trim() || "owner@borneojek-mart.local";
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD?.trim() || "";
const DUMP_PATH = process.env.SEPUTARBORNEO_DUMP?.trim() || "";

const OUT_DIR = "tools/out/seputarborneo";
const LEGACY_SYSTEM = "seputarborneo";

// ---------------------------------------------------------------------------
// sb_slug() / rawurlencode() — see this repo's own PR history (issue #58) for
// why these are a deliberate, documented port rather than an import: the
// legacy PHP source (`include/view_helpers.php`, `include/nav_menu.php`)
// duplicates the same function for the same reason (a require-cycle), and a
// third copy here is that same choice, not an oversight.
// ---------------------------------------------------------------------------

export function sbSlug(input: string): string {
  let slug = input.toLowerCase();
  slug = slug.replace(/_/g, "-");
  slug = slug.replace(/[^a-z0-9\s-]+/gu, "");
  slug = slug.replace(/[\s-]+/g, "-");
  return slug.replace(/^-+|-+$/g, "");
}

/** PHP `rawurlencode()` (RFC 3986) — differs from `encodeURIComponent` only in also escaping `! * ' ( )`. */
export function phpRawUrlEncode(input: string): string {
  return encodeURIComponent(input).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Today's (post-issue-#6) canonical article URL: `/news/{id}-{sb_slug(title)}.html`. */
export function legacyNewsUrlCurrent(id: number, title: string): string {
  const slug = sbSlug(title);
  return slug === "" ? `/news/${id}.html` : `/news/${id}-${phpRawUrlEncode(slug)}.html`;
}

/**
 * The PRE-2.0 legacy URL form. Deliberately built from the RAW title, never
 * from the stored post `slug` — see `buildPostRecord`'s own comment for why a
 * de-duplicated stored slug (`-{legacyId}` suffix) would make a naive
 * `{slug}`-templated redirect (as `blog:legacy:redirects:import` builds one)
 * WRONG for a colliding title, and why this exporter's own `redirects.json`
 * is built from this function directly instead.
 */
export function legacyNewsUrlPre2000(id: number, title: string): string {
  const segment = phpRawUrlEncode(title.replace(/ /g, "_"));
  return `/news/${id}_${segment}.html`;
}

export function legacyVideoUrl(id: number, title: string): string {
  const slug = sbSlug(title);
  const idSlug = slug === "" ? String(id) : `${id}-${phpRawUrlEncode(slug)}`;
  return `/video/?video=${idSlug}.html`;
}

// ---------------------------------------------------------------------------
// Taxonomy normalization + classification — a documented port of
// `migrations/2026-09-02-normalize-legacy-taxonomy.sql`. Verified empirically
// against the real dump (2026-09-18): all 45 distinct `(jenis_rubrik,
// kategori)` combinations already normalize cleanly — kept anyway so a
// future, messier dump still hits "0 unmapped taxonomy values" by
// construction.
// ---------------------------------------------------------------------------

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

export function normalizeLegacyTaxonomy(
  jenisRubrikRaw: string,
  kategoriRaw: string
): NormalizedTaxonomy {
  let jenisRubrik = jenisRubrikRaw;
  let kategori = kategoriRaw;

  if (jenisRubrik === "MITRA-BORNEO") jenisRubrik = "MITRA BORNEO";
  kategori = kategori.split("/option>").join("");

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

  kategori = kategori.split("Palangkaraya").join("Palangka Raya");
  if (jenisRubrik === "OLAHRAGA" && kategori !== "") kategori = "";

  return { jenisRubrik, kategori };
}

export type TaxonomyOutcome =
  | { kind: "rubrik"; rubrikSlug: string; legacyName: string }
  | { kind: "daerah"; regionName: string; legacyName: string }
  | { kind: "mitra"; institutionName: string; legacyName: string }
  | { kind: "umum"; childName: string; legacyName: string };

export type TaxonomyMapResult =
  | { ok: true; value: TaxonomyOutcome }
  | { ok: false; reason: string };

const PLAIN_RUBRIK_SLUGS: Readonly<Record<string, string>> = {
  POLITIK: "politik",
  HUKUM: "hukum",
  NASIONAL: "nasional",
  OLAHRAGA: "olahraga",
  WISATA: "wisata"
};

/**
 * Classifies a normalized `(jenis_rubrik, kategori)` pair. `legacyName` on
 * every branch is the SINGLE string this exporter puts in a record's
 * `categories: string[]` — `legacy-term-map.ts`'s own vocabulary is a flat
 * category NAME, not a `(jenis_rubrik, kategori)` pair, and `kategori` alone
 * already disambiguates every non-plain-rubrik case (a bare "Kapuas" can only
 * ever be a `DAERAH` leaf, a bare "Pemkab Kapuas" only ever a `MITRA BORNEO`
 * one), so nothing is lost keeping it that simple.
 */
export function mapLegacyTaxonomy(
  jenisRubrikRaw: string,
  kategoriRaw: string
): TaxonomyMapResult {
  const { jenisRubrik, kategori } = normalizeLegacyTaxonomy(jenisRubrikRaw, kategoriRaw);

  if (kategori === "" && PLAIN_RUBRIK_SLUGS[jenisRubrik]) {
    return {
      ok: true,
      value: { kind: "rubrik", rubrikSlug: PLAIN_RUBRIK_SLUGS[jenisRubrik]!, legacyName: jenisRubrik }
    };
  }
  if (jenisRubrik === "DAERAH" && kategori !== "") {
    return { ok: true, value: { kind: "daerah", regionName: kategori, legacyName: kategori } };
  }
  if (jenisRubrik === "MITRA BORNEO" && kategori !== "") {
    return { ok: true, value: { kind: "mitra", institutionName: kategori, legacyName: kategori } };
  }
  if (jenisRubrik === "UMUM" && UMUM_LEAF_LABELS.has(kategori)) {
    return { ok: true, value: { kind: "umum", childName: kategori, legacyName: kategori } };
  }

  return {
    ok: false,
    reason: `unmapped taxonomy: jenis_rubrik=${JSON.stringify(jenisRubrikRaw)} kategori=${JSON.stringify(kategoriRaw)}`
  };
}

/**
 * `UMUM`'s "Wisata" child collides in SLUG with the top-level `WISATA`
 * rubrik — issue #57 records this as an open decision (`wisata-travel` if
 * renamed, or `wisata` nested under `umum` otherwise). This exporter never
 * guesses which: `termMapHintFor` lists both candidates, in order, for
 * whoever builds the real `--term-map` to try against the live tenant.
 */
export const UMUM_WISATA_SLUG_CANDIDATES: readonly string[] = ["wisata-travel", "wisata"];

export type TermMapHint = {
  kind: TaxonomyOutcome["kind"];
  /** Candidate term slugs, in priority order — the first that exists in the live tenant's taxonomy is the right one. */
  suggestedTermSlugCandidates: string[];
  /** `daerah`/`mitra` rows only — the institution `--assign-institutions` should ALSO attach (see this file's header: `blog:legacy:import` cannot). */
  suggestedInstitutionName?: string;
};

export function termMapHintFor(outcome: TaxonomyOutcome): TermMapHint {
  if (outcome.kind === "rubrik") {
    return { kind: "rubrik", suggestedTermSlugCandidates: [outcome.rubrikSlug] };
  }
  if (outcome.kind === "daerah") {
    const institution =
      outcome.regionName === "Palangka Raya" ? "Pemko Palangka Raya" : `Pemkab ${outcome.regionName}`;
    return {
      kind: "daerah",
      suggestedTermSlugCandidates: ["daerah"],
      suggestedInstitutionName: institution
    };
  }
  if (outcome.kind === "mitra") {
    return {
      kind: "mitra",
      suggestedTermSlugCandidates: ["mitra-borneo"],
      suggestedInstitutionName: outcome.institutionName
    };
  }
  // umum
  const candidates =
    outcome.childName === "Wisata" ? UMUM_WISATA_SLUG_CANDIDATES : [outcome.childName.toLowerCase()];
  return { kind: "umum", suggestedTermSlugCandidates: [...candidates] };
}

// ---------------------------------------------------------------------------
// YouTube video id normalization — a documented duplicate of `apps/cms`'s
// `normalizeYouTubeVideoId` (`video-news-block-validation.ts`), kept in exact
// behavioural step, for the same workspace-boundary reason as the taxonomy
// port above.
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
// Publication date — Asia/Jakarta (WIB, UTC+7, no DST) wall-clock -> UTC.
// ---------------------------------------------------------------------------

export type PublishedAtResult = { ok: true; publishedAt: Date } | { ok: false; reason: string };

const JAKARTA_UTC_OFFSET_HOURS = 7;

export function resolvePublishedAt(tgl: SqlValue, jam: SqlValue, now: Date): PublishedAtResult {
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

  return { ok: true, publishedAt };
}

// ---------------------------------------------------------------------------
// Slugs for NEW posts — `sb_slug(judul)`, de-duplicated with `-{id_ber}` on
// collision (issue #58's own words). This is the value written into
// `blog:legacy:import`'s NDJSON `slug` field verbatim (`importLegacyBlogPost`
// inserts `input.slug` directly — checked directly, not assumed) — never
// regenerated by the pipeline, which is why `legacyNewsUrlPre2000`'s target
// and this exporter's own `redirects.json` both use it as the SOURCE OF
// TRUTH for the new URL.
// ---------------------------------------------------------------------------

export function newPostSlug(title: string, legacyId: number, taken: ReadonlySet<string>): string {
  const base = sbSlug(title) || `berita-${legacyId}`;
  if (!taken.has(base)) return base;
  return `${base}-${legacyId}`;
}

// ---------------------------------------------------------------------------
// The NDJSON record — field-for-field the shape
// `apps/cms/src/modules/blog-content/domain/legacy-import-record.ts` parses.
// Read directly off that file, not guessed: `legacyId`, `title`, `slug`,
// `excerpt`, `bodyHtml`, `locale`, `status`, `publishedAt`, `categories`,
// `featuredImageSrc`. `seoTitle`/`metaDescription`/`visibility` are left out
// entirely rather than sent as `null`/defaults — the parser already defaults
// them, and issue #58's own Scope maps no legacy column to any of the three.
// ---------------------------------------------------------------------------

export type LegacyImportRecordJson = {
  legacyId: string;
  title: string;
  slug: string;
  excerpt: string | null;
  bodyHtml: string;
  locale: "id";
  status: "draft" | "published";
  publishedAt?: string;
  categories: string[];
  featuredImageSrc: string | null;
};

export type BuildResult<T> =
  | { ok: true; record: T; taxonomy: TaxonomyMapResult; legacyUrls: { current: string; pre2000?: string } }
  | { ok: false; legacyId: string; table: string; reason: string };

/** Builds one `berita_red` row into `blog:legacy:import`'s NDJSON shape — pure, no I/O. */
export function buildPostRecord(
  row: Record<string, SqlValue>,
  taken: ReadonlySet<string>,
  now: Date
): BuildResult<LegacyImportRecordJson> {
  const legacyId = String(row.id_ber);
  const title = String(row.judul ?? "").trim();
  const slug = newPostSlug(title, Number(row.id_ber), taken);
  const excerptRaw = String(row.sub_judul ?? "").trim();
  const taxonomy = mapLegacyTaxonomy(String(row.jenis_rubrik ?? ""), String(row.kategori ?? ""));

  if (!taxonomy.ok) {
    return { ok: false, legacyId, table: "berita_red", reason: taxonomy.reason };
  }

  const publishedAtResult = resolvePublishedAt(row.tgl, row.jam, now);
  if (!publishedAtResult.ok) {
    return { ok: false, legacyId, table: "berita_red", reason: publishedAtResult.reason };
  }

  const featuredImageSrc = String(row.foto_berita ?? "").trim();
  const isPast = publishedAtResult.publishedAt.getTime() <= now.getTime();

  const record: LegacyImportRecordJson = {
    legacyId,
    title,
    slug,
    excerpt: excerptRaw.length > 0 ? excerptRaw : null,
    bodyHtml: String(row.isi_berita ?? ""),
    locale: "id",
    status: isPast ? "published" : "draft",
    publishedAt: publishedAtResult.publishedAt.toISOString(),
    categories: [taxonomy.value.legacyName],
    featuredImageSrc: featuredImageSrc.length > 0 ? featuredImageSrc : null
  };

  return {
    ok: true,
    record,
    taxonomy,
    legacyUrls: {
      current: legacyNewsUrlCurrent(Number(row.id_ber), title),
      pre2000: legacyNewsUrlPre2000(Number(row.id_ber), title)
    }
  };
}

/** `berita_vid`'s `tgl`/`jam` are `YYMMDD`/`HHMMSS` (per seputarborneo's own video-time-normalization migrations), reformatted to `resolvePublishedAt`'s expected shape. */
function reformatLegacyVideoTimestamp(tgl: string, jam: string): { tgl: string; jam: string } | null {
  if (!/^\d{6}$/.test(tgl) || !/^\d{6}$/.test(jam)) return null;
  const yy = Number(tgl.slice(0, 2));
  const year = yy < 70 ? 2000 + yy : 1900 + yy;
  return {
    tgl: `${year}-${tgl.slice(2, 4)}-${tgl.slice(4, 6)}`,
    jam: `${jam.slice(0, 2)}:${jam.slice(2, 4)}:${jam.slice(4, 6)}`
  };
}

/**
 * Builds one `berita_vid` row. `bodyHtml` is `text_vid` PLUS a plain link
 * paragraph to the video — `legacy-import-record.ts` has no content-block
 * field, only `bodyHtml`, so there is nowhere to put an embedded `videoNews`
 * block through this pipeline. A plain `<a href>` link is the honest
 * degradation: `convertLegacyHtmlToPortableText` accepts a link (unlike an
 * `<iframe>` embed, which it refuses outright — checked directly against
 * that converter's own docblock, "rejects <script>, <iframe>, ... unmanaged
 * <img> sources"), so the video imports as an article with a link to watch
 * it, not an embedded player. Documented as a known gap, not invented around.
 */
export function buildVideoRecord(
  row: Record<string, SqlValue>,
  taken: ReadonlySet<string>,
  now: Date
): BuildResult<LegacyImportRecordJson> {
  const legacyId = String(row.id_vid);
  const title = String(row.judul_vid ?? "").trim();
  const slug = newPostSlug(title, Number(row.id_vid), taken);
  const rawLink = String(row.link ?? "");
  const videoId = normalizeYoutubeVideoId(rawLink);

  if (!videoId) {
    return {
      ok: false,
      legacyId,
      table: "berita_vid",
      reason: "link did not normalize to a YouTube video id"
    };
  }

  const reformatted = reformatLegacyVideoTimestamp(String(row.tgl ?? ""), String(row.jam ?? ""));
  if (!reformatted) {
    return { ok: false, legacyId, table: "berita_vid", reason: "tgl/jam is not YYMMDD/HHMMSS" };
  }

  const publishedAtResult = resolvePublishedAt(reformatted.tgl, reformatted.jam, now);
  if (!publishedAtResult.ok) {
    return { ok: false, legacyId, table: "berita_vid", reason: publishedAtResult.reason };
  }

  const videoUrl = `https://youtu.be/${videoId}`;
  const bodyHtml =
    `${String(row.text_vid ?? "")}\n<p>Tonton video: <a href="${videoUrl}">${videoUrl}</a></p>`;
  const isPast = publishedAtResult.publishedAt.getTime() <= now.getTime();

  const record: LegacyImportRecordJson = {
    legacyId,
    title,
    slug,
    excerpt: null,
    bodyHtml,
    locale: "id",
    status: isPast ? "published" : "draft",
    publishedAt: publishedAtResult.publishedAt.toISOString(),
    categories: [],
    featuredImageSrc: null
  };

  return {
    ok: true,
    record,
    taxonomy: { ok: false, reason: "berita_vid carries no rubrik/kategori mapping in this exporter" },
    legacyUrls: { current: legacyVideoUrl(Number(row.id_vid), title) }
  };
}

// ---------------------------------------------------------------------------
// Redirects — built directly by this exporter, NOT derived through
// `blog:legacy:redirects:import`. That sibling script templates its source
// path from `{legacyId}` and the STORED slug (`listLegacyRedirectMappings`:
// `pathTemplate.replace("{legacyId}", ...).replace("{slug}", row.slug)`) —
// which is WRONG for the ~84 collision groups / ~171 rows
// `blog-legacy-import.ts`'s own comment names, because a de-duplicated
// stored slug (`title-slug-{legacyId}`) never equals the plain `sb_slug`
// the real legacy current-style URL was built from. Building both legacy URL
// forms here, straight from the raw `title` (never the stored slug), is
// correct for every row including the colliding ones. `blog:legacy:redirects
// :import`/`blog:legacy:rubrik-redirects`/`blog:legacy:cutover:verify`
// remain available upstream tools (documented in the runbook) but are not
// used by this exporter for that reason.
// ---------------------------------------------------------------------------

export type RedirectEntry = {
  sourcePath: string;
  target: string;
  origin: "import";
  statusCode: 301;
};

export function buildRedirectEntry(sourcePath: string, tenantCode: string, slug: string): RedirectEntry {
  return { sourcePath, target: `/blog/${tenantCode}/${slug}`, origin: "import", statusCode: 301 };
}

// ---------------------------------------------------------------------------
// Site profile (`config` -> `PUT /api/v1/site-profile`) — unchanged from
// this issue's first pass; `blog:legacy:import` has nothing to do with the
// site profile at all.
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
// Manifest
// ---------------------------------------------------------------------------

export type ManifestSkip = { legacyId: string; table: string; reason: string };

export type Manifest = {
  generatedAt: string;
  dump: string;
  counts: {
    beritaRedTotal: number;
    beritaRedExported: number;
    beritaVidTotal: number;
    beritaVidExported: number;
    iklOnlineTotal: number;
    logoTotal: number;
    newsletterSubscribers: number;
    postsNeedingFeaturedImage: number;
  };
  perLegacyCategory: Record<string, number>;
  perYear: Record<string, number>;
  unmappedTaxonomy: Record<string, number>;
  skipped: ManifestSkip[];
};

// ---------------------------------------------------------------------------
// Export — reads the dump ONCE, writes every file the runbook needs.
// ---------------------------------------------------------------------------

function flag(name: string): string | null {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split("=").slice(1).join("=") : null;
}

function usage(message: string): void {
  console.error(
    `import-seputarborneo — ${message}\n\n` +
      "  (default)              export the dump to tools/out/seputarborneo/*  — no network call\n" +
      "  --limit=<n>            cap the number of berita_red rows exported\n" +
      "  --since=<yyyy-mm-dd>   only berita_red rows with tgl on or after this date\n" +
      "  --assign-institutions  a follow-up pass over the public API, run AFTER blog:legacy:import\n" +
      "                         --commit — see this file's header for why it exists\n"
  );
  process.exitCode = 1;
}

type ExportOptions = { limit: number | null; since: string | null };

async function runExport(options: ExportOptions): Promise<void> {
  if (!DUMP_PATH) return usage("SEPUTARBORNEO_DUMP must name the dump's path.");

  const now = new Date();
  const takenPostSlugs = new Set<string>();
  const takenVideoSlugs = new Set<string>();

  const postLines: string[] = [];
  const videoLines: string[] = [];
  const redirects: RedirectEntry[] = [];
  const termMapHints: Record<string, TermMapHint> = {};
  /** `legacyId -> institution name`, for `--assign-institutions` (re-derived from the dump at that time; not persisted between the two runs). */
  let configRow: Record<string, SqlValue> | null = null;
  let adRows = 0;
  let logoRows = 0;
  let newsletterSubscribers = 0;
  let beritaRedTotal = 0;
  let beritaVidTotal = 0;
  let postsNeedingFeaturedImage = 0;

  const perLegacyCategory: Record<string, number> = {};
  const perYear: Record<string, number> = {};
  const unmappedTaxonomy: Record<string, number> = {};
  const skipped: ManifestSkip[] = [];

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
      adRows++;
      continue;
    }
    if (table === "logo") {
      logoRows++;
      continue;
    }

    if (table === "berita_vid") {
      beritaVidTotal++;
      const built = buildVideoRecord(row, takenVideoSlugs, now);
      if (!built.ok) {
        skipped.push({ legacyId: built.legacyId, table: built.table, reason: built.reason });
        continue;
      }
      takenVideoSlugs.add(built.record.slug);
      videoLines.push(JSON.stringify(built.record));
      redirects.push(buildRedirectEntry(built.legacyUrls.current, TENANT_CODE, built.record.slug));
      continue;
    }

    // berita_red
    beritaRedTotal++;

    if (options.since) {
      const tgl = String(row.tgl ?? "");
      if (tgl < options.since) continue;
    }
    if (options.limit !== null && postLines.length >= options.limit) continue;

    const built = buildPostRecord(row, takenPostSlugs, now);
    const year = String(row.tgl ?? "").slice(0, 4);
    perYear[year] = (perYear[year] ?? 0) + 1;

    if (!built.ok) {
      if (built.reason.startsWith("unmapped taxonomy")) {
        unmappedTaxonomy[built.reason] = (unmappedTaxonomy[built.reason] ?? 0) + 1;
      }
      skipped.push({ legacyId: built.legacyId, table: built.table, reason: built.reason });
      continue;
    }

    takenPostSlugs.add(built.record.slug);
    postLines.push(JSON.stringify(built.record));

    if (built.taxonomy.ok) {
      const legacyName = built.taxonomy.value.legacyName;
      perLegacyCategory[legacyName] = (perLegacyCategory[legacyName] ?? 0) + 1;
      termMapHints[legacyName] = termMapHintFor(built.taxonomy.value);
    }

    if (built.record.featuredImageSrc) postsNeedingFeaturedImage++;

    redirects.push(buildRedirectEntry(built.legacyUrls.current, TENANT_CODE, built.record.slug));
    if (built.legacyUrls.pre2000) {
      redirects.push(buildRedirectEntry(built.legacyUrls.pre2000, TENANT_CODE, built.record.slug));
    }
  }

  await Bun.write(`${OUT_DIR}/posts.ndjson`, `${postLines.join("\n")}\n`);
  await Bun.write(`${OUT_DIR}/videos.ndjson`, `${videoLines.join("\n")}\n`);
  await Bun.write(`${OUT_DIR}/redirects.json`, `${JSON.stringify(redirects, null, 2)}\n`);
  await Bun.write(`${OUT_DIR}/term-map-hints.json`, `${JSON.stringify(termMapHints, null, 2)}\n`);

  if (configRow) {
    const siteProfile = buildSiteProfileUpdateFromConfig(configRow);
    await Bun.write(`${OUT_DIR}/site-profile.json`, `${JSON.stringify(siteProfile, null, 2)}\n`);
  }

  const manifest: Manifest = {
    generatedAt: now.toISOString(),
    dump: DUMP_PATH,
    counts: {
      beritaRedTotal,
      beritaRedExported: postLines.length,
      beritaVidTotal,
      beritaVidExported: videoLines.length,
      iklOnlineTotal: adRows,
      logoTotal: logoRows,
      newsletterSubscribers,
      postsNeedingFeaturedImage
    },
    perLegacyCategory,
    perYear,
    unmappedTaxonomy,
    skipped
  };
  await Bun.write(`${OUT_DIR}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `\nimport-seputarborneo — EXPORT\n` +
      `  dump                       ${DUMP_PATH}\n` +
      `  berita_red (dump total)    ${beritaRedTotal}\n` +
      `  berita_red (exported)      ${postLines.length}\n` +
      `  berita_vid (dump total)    ${beritaVidTotal}\n` +
      `  berita_vid (exported)      ${videoLines.length}\n` +
      `  ikl_online rows            ${adRows} (read for context only — this exporter writes nothing for them, see docs/deployment.md)\n` +
      `  logo rows                  ${logoRows} (same — issue #59's to consume)\n` +
      `  newsletter_subscribers     ${newsletterSubscribers} (never imported — no consent record; PII)\n` +
      `  posts needing lead photo   ${postsNeedingFeaturedImage}\n` +
      `  redirect entries           ${redirects.length}\n` +
      `  unmapped taxonomy values   ${Object.keys(unmappedTaxonomy).length}\n` +
      `  skipped rows               ${skipped.length}\n\n` +
      "  per legacy category:\n" +
      Object.entries(perLegacyCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `    ${count}\t${name}`)
        .join("\n") +
      "\n\n  per year:\n" +
      Object.entries(perYear)
        .sort()
        .map(([year, count]) => `    ${year}\t${count}`)
        .join("\n") +
      (Object.keys(unmappedTaxonomy).length > 0
        ? `\n\n  UNMAPPED TAXONOMY VALUES:\n${Object.entries(unmappedTaxonomy)
            .map(([reason, count]) => `    ${count}\t${reason}`)
            .join("\n")}`
        : "") +
      `\n\n  wrote ${OUT_DIR}/{posts.ndjson,videos.ndjson,redirects.json,term-map-hints.json,site-profile.json,manifest.json}\n` +
      "  (git-ignored — see docs/deployment.md's \"Importing seputarborneo\" for the next steps)\n"
  );
}

// ---------------------------------------------------------------------------
// --assign-institutions — see this file's header and tools/lib/awcms-api.ts's
// header for why this one, small follow-up pass stays. Run AFTER
// `blog:legacy:import --commit` has created the posts. Re-derives the
// legacy-id -> institution-name assignment by reading the dump again
// (cheap, streaming, no file hand-off needed between the two runs) rather
// than trusting a possibly-stale exported file.
// ---------------------------------------------------------------------------

type PendingAssignment = { legacyId: string; slug: string; institutionName: string };

async function collectPendingAssignments(): Promise<PendingAssignment[]> {
  const now = new Date();
  const taken = new Set<string>();
  const pending: PendingAssignment[] = [];

  for await (const { table, row } of readMysqlDumpRows(DUMP_PATH, ["berita_red"])) {
    if (table !== "berita_red") continue;

    const built = buildPostRecord(row, taken, now);
    if (!built.ok) continue;
    taken.add(built.record.slug);

    if (!built.taxonomy.ok) continue;
    const hint = termMapHintFor(built.taxonomy.value);
    if (hint.suggestedInstitutionName) {
      pending.push({
        legacyId: built.record.legacyId,
        slug: built.record.slug,
        institutionName: hint.suggestedInstitutionName
      });
    }
  }

  return pending;
}

async function runAssignInstitutions(): Promise<void> {
  if (!DUMP_PATH) return usage("SEPUTARBORNEO_DUMP must name the dump's path.");

  const session: Session = await resolveExistingTenantSession(BASE_URL, OWNER_EMAIL, OWNER_PASSWORD);
  console.log(`import-seputarborneo --assign-institutions — authenticated against tenant ${session.tenantId}.`);

  const pending = await collectPendingAssignments();
  console.log(`  ${pending.length} post(s) need an institution assignment.`);

  const institutionsResult = await apiCall<{ institutions: Array<{ id: string; name: string }> }>(
    BASE_URL,
    "GET",
    "/api/v1/blog/institutions",
    { session }
  );
  assertOk("GET /api/v1/blog/institutions", institutionsResult);
  const institutionByName = new Map(
    institutionsResult.data.institutions.map((i) => [i.name.trim().toLowerCase(), i.id])
  );

  // Page through every post (stable order) to build slug -> id — there is no
  // slug-lookup route on the public API (checked directly: no file under
  // apps/cms/src/pages/api/v1/blog/posts matches *slug*, and
  // blog-post-list-query.ts has no slug filter).
  const slugToPostId = new Map<string, string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await apiCall<{ posts: Array<{ id: string; slug: string }>; nextCursor: string | null }>(
      BASE_URL,
      "GET",
      `/api/v1/blog/posts?order=created_at&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { session }
    );
    assertOk("GET /api/v1/blog/posts", page);
    for (const post of page.data.posts) slugToPostId.set(post.slug, post.id);
    if (!page.data.nextCursor) break;
    cursor = page.data.nextCursor;
  }
  console.log(`  ${slugToPostId.size} post(s) found in the tenant.`);

  let assigned = 0;
  let missingPost = 0;
  let missingInstitution = 0;

  for (const item of pending) {
    const postId = slugToPostId.get(item.slug);
    if (!postId) {
      missingPost++;
      continue;
    }
    const institutionId = institutionByName.get(item.institutionName.toLowerCase());
    if (!institutionId) {
      missingInstitution++;
      continue;
    }

    const patchResult = await apiCall(BASE_URL, "PATCH", `/api/v1/blog/posts/${postId}`, {
      session,
      body: { institutionIds: [institutionId] }
    });
    assertOk(`PATCH /api/v1/blog/posts/${postId} (legacyId=${item.legacyId})`, patchResult);
    assigned++;
  }

  console.log(
    `\nimport-seputarborneo --assign-institutions COMMITTED\n` +
      `  assigned            ${assigned}\n` +
      `  post not found      ${missingPost} (not yet imported by blog:legacy:import, or refused)\n` +
      `  institution missing ${missingInstitution} (see docs/deployment.md — issue #57 seeds these)\n`
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--assign-institutions")) {
    return runAssignInstitutions();
  }

  const limitFlag = flag("limit");
  const sinceFlag = flag("since");
  if (limitFlag !== null && !/^\d+$/.test(limitFlag)) return usage("--limit must be a non-negative integer.");
  if (sinceFlag !== null && !/^\d{4}-\d{2}-\d{2}$/.test(sinceFlag)) return usage("--since must be YYYY-MM-DD.");

  return runExport({
    limit: limitFlag !== null ? Number(limitFlag) : null,
    since: sinceFlag
  });
}

if (import.meta.main) {
  await main();
}
