/**
 * The news chrome's single source of navigation structure (issue #48) —
 * ported from seputarborneo.com v2.4.0's `include/nav_menu.php`
 * (`seputarborneo_nav_primary()`/`_nav_daerah()`/`_nav_mitra()`/`_nav_umum()`/
 * `_nav_perusahaan()`), which is itself a single file for the same reason:
 * before it existed, seputarborneo's own menu was copy-pasted across seven
 * entry points and drifted (that file's own docblock records six links that
 * quietly went dead). This app has one entry point per menu (the components
 * below), so the risk that ported here is smaller, but the PATTERN — one
 * file owns "what the menu contains", every component only renders it — is
 * kept because it is what makes adding a 15th daerah or a 25th mitra later a
 * one-line change here rather than an edit to every component that lists
 * them.
 *
 * Every function below reads from awcms's ALREADY-VERIFIED shapes
 * (`src/lib/awcms/{blog,wilayah,pages}.ts`) or from `src/lib/berita.ts`'s
 * exported pure helpers — never a second, parallel fetch of something one of
 * those files already owns. `src/lib/berita.ts` itself is NOT edited by this
 * issue (issue #47/A1 owns it this wave); everything imported from it here
 * is a function that file already exports for reuse (`getRubrikTree`,
 * `flattenRubrikTree`, `toRegionRef`), the same way `src/components/berita/
 * ArtikelCard.astro` already imports `PostSummary` from it.
 *
 * ## Why every "select…" function is exported separately from its "get…" wrapper
 *
 * Mirrors `src/lib/berita.ts`'s own convention (`buildRubrikForest`
 * exported next to `getRubrikTree`, `toRegionRef` next to `getDaerah`): the
 * `select*` functions are pure — given already-fetched data, no network — so
 * `tests/navigasi-berita.test.ts` can assert the ordering/filtering rules
 * directly, without standing up a stub CMS. The `get*` functions are the
 * only place a real fetch happens, and are what the components actually
 * call.
 */
import {
  getRubrikTree,
  flattenRubrikTree,
  toRegionRef,
  type RubrikNode,
  type RegionRef
} from "./berita";
import { getAllInstitutions, type RawInstitution } from "./awcms/blog";
import {
  getResolvableRegionsByCode,
  findKaltengProvince,
  type RegionRecord
} from "./awcms/wilayah";
import { listStaticPages } from "./awcms/pages";
import { ROUTES, STATIC_PAGE_SLUGS } from "../config/routes";

// ---------------------------------------------------------------------------
// Primary nav ("8-item nav" — issue #48's own list, `seputarborneo_nav_primary()`)
// ---------------------------------------------------------------------------

/** The panel this issue's "Daerah" nav item toggles — shared by `NavBerita.astro` for both the button's `aria-controls` and the panel's own `id`. */
export const DAERAH_PANEL_ID = "panel-daerah";

export type NavUtamaItem = {
  label: string;
  href: string;
  /**
   * The site-relative path this item is "current" for, compared against
   * `BeritaLayout`'s own `canonicalPath` prop (`NavBerita.astro`'s
   * `currentPath`) — `null` for "Daerah", which is an in-page anchor to the
   * panel, never a page of its own to be current FOR (mirrors
   * `nav_menu.php`'s own note: `rubrik` is left `''` for Daerah so it is
   * skipped by the normal active-rubrik match, and its active state instead
   * follows whether the CURRENT PAGE is any `/daerah/*` route — see
   * `NavBerita.astro`).
   */
  activePathPrefix: string | null;
  /** Present only on "Daerah" — `aria-controls` for the toggle button. */
  controls?: string;
};

/**
 * The five rubrik seputarborneo's real content form actually writes
 * (`nav_menu.php`'s own "TAKSONOMI SESUNGGUHNYA" comment: Politik, Hukum,
 * Nasional, Olah Raga, Wisata — Daerah/Mitra Borneo/Umum are a SEPARATE
 * classification with their own strips below, not part of this five).
 * `key` is compared against a rubrik's slug AND name after
 * `normalizeForMatch` strips case/spacing/punctuation — deliberately loose,
 * because "Olah Raga" (this label) and a term literally named "Olahraga" (no
 * space) both normalize to `"olahraga"`, and this app has no authority over
 * which spelling an editor gives the CMS term.
 */
const RUBRIK_UTAMA: ReadonlyArray<{ label: string; key: string }> = [
  { label: "Politik", key: "politik" },
  { label: "Hukum", key: "hukum" },
  { label: "Nasional", key: "nasional" },
  { label: "Olah Raga", key: "olahraga" },
  { label: "Wisata", key: "wisata" }
];

/** Lower-cases and strips everything but letters/digits — the loose match `RUBRIK_UTAMA`'s docblock explains. */
function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Pure — resolves `RUBRIK_UTAMA` against the rubrik tree this build
 * actually has, in `RUBRIK_UTAMA`'s own order, OMITTING any candidate with
 * no matching rubrik (issue #48: "missing ones omitted, never a dead
 * link") rather than linking to a rubrik that does not exist this build.
 */
export function selectNavUtamaRubrik(allRubrik: readonly RubrikNode[]): NavUtamaItem[] {
  const items: NavUtamaItem[] = [];

  for (const candidate of RUBRIK_UTAMA) {
    const match = allRubrik.find(
      (node) =>
        normalizeForMatch(node.slug) === candidate.key || normalizeForMatch(node.name) === candidate.key
    );
    if (!match) continue;

    const href = ROUTES.rubric(match.slug);
    items.push({ label: candidate.label, href, activePathPrefix: href });
  }

  return items;
}

/**
 * The 8-item primary nav, in seputarborneo's own order: Beranda, the five
 * rubrik above (each omitted if missing), Daerah, Video. "Beranda" and
 * "Video" are fixed routes (`ROUTES.home`/`ROUTES.video`) — unlike the five
 * rubrik, they are never conditional on the CMS's taxonomy, the same way
 * `nav_menu.php`'s own `seputarborneo_nav_primary()` hard-codes them.
 */
export async function getNavUtama(): Promise<NavUtamaItem[]> {
  const tree = await getRubrikTree();
  const rubrikItems = selectNavUtamaRubrik(flattenRubrikTree(tree));

  return [
    { label: "Beranda", href: ROUTES.home, activePathPrefix: ROUTES.home },
    ...rubrikItems,
    { label: "Daerah", href: `#${DAERAH_PANEL_ID}`, activePathPrefix: null, controls: DAERAH_PANEL_ID },
    { label: "Video", href: ROUTES.video, activePathPrefix: ROUTES.video }
  ];
}

// ---------------------------------------------------------------------------
// Daerah panel (14 Kalteng regencies/cities — `seputarborneo_nav_daerah()`)
// ---------------------------------------------------------------------------

/**
 * Seputarborneo's own 14-item order (`nav_menu.php`'s
 * `seputarborneo_nav_daerah()`) — this app has no equivalent field in
 * `idn_admin_regions` to sort by (that dataset is alphabetical/code-ordered,
 * a national reference list with no editorial opinion about which regency
 * comes "first" in a Kalteng news menu), so the order itself is ported here
 * as a literal, named constant rather than re-derived from anything live.
 */
const DAERAH_URUTAN: readonly string[] = [
  "Palangka Raya",
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
];

/**
 * Strips a leading administrative term ("Kota "/"Kabupaten ", case-
 * insensitive) before a `DAERAH_URUTAN` comparison. The live
 * `idn_admin_regions` dataset's own `name` column embeds this term
 * ("KOTA PALANGKA RAYA", "KABUPATEN KAPUAS" — verified against a real
 * export, not assumed), while `DAERAH_URUTAN` above (ported from
 * `nav_menu.php`) never carries one, the same way seputarborneo's own menu
 * names a regency by its common name only. Without this, a bare
 * case-insensitive match never matches "Palangka Raya" against
 * "KOTA PALANGKA RAYA" — sorting it (and, via `selectMitraOrder`, every
 * Palangka Raya institution) LAST instead of first.
 */
function stripRegionTerm(name: string): string {
  return name.trim().toLowerCase().replace(/^(kota|kabupaten)\s+/, "");
}

/** A name's position in `DAERAH_URUTAN` (term-stripped, case-insensitive), or past the end for anything not on that list — never a lookup failure, just "sorts last". */
function daerahOrderIndex(name: string): number {
  const normalized = stripRegionTerm(name);
  const index = DAERAH_URUTAN.findIndex((d) => stripRegionTerm(d) === normalized);
  return index === -1 ? DAERAH_URUTAN.length : index;
}

/**
 * Pure — `regions` filtered to level-2 (regency) AND present in
 * `regionCodesWithInstitution` (issue #48: "that have an institution or
 * posts" — reduces to "have an institution" because `src/lib/berita.ts`'s
 * own file header states a post reaches a region ONLY through an
 * institution's `regionCode`; a region with an institution but zero posts
 * yet still belongs on this menu, the same way seputarborneo's own 14-item
 * list is fixed regardless of which regencies happen to have a post this
 * week), sorted into `DAERAH_URUTAN`'s order.
 */
export function selectDaerahList(
  regions: readonly RegionRef[],
  regionCodesWithInstitution: ReadonlySet<string>
): RegionRef[] {
  return regions
    .filter((region) => region.level === 2 && regionCodesWithInstitution.has(region.code))
    .slice()
    .sort(
      (a, b) => daerahOrderIndex(a.name) - daerahOrderIndex(b.name) || a.name.localeCompare(b.name)
    );
}

export async function getDaerahList(): Promise<RegionRef[]> {
  const [regionsByCode, institutions] = await Promise.all([
    getResolvableRegionsByCode(),
    getAllInstitutions()
  ]);

  const regions = [...regionsByCode.values()].map(toRegionRef);
  const codesWithInstitution = new Set(
    institutions.map((i) => i.regionCode).filter((code): code is string => Boolean(code))
  );

  return selectDaerahList(regions, codesWithInstitution);
}

// ---------------------------------------------------------------------------
// Mitra directory (24 institutions — `seputarborneo_nav_mitra()`)
// ---------------------------------------------------------------------------

export type MitraNavItem = { slug: string; name: string; href: string };

/** Executive (Pemprov/Pemkab/Pemko) before legislative (DPRD) — seputarborneo's own 24-item list alternates exactly this way per regency. */
function branchOrder(branch: RawInstitution["branch"]): number {
  return branch === "executive" ? 0 : 1;
}

/**
 * Pure — every institution, grouped provincial-first (`kaltengProvinceCode`
 * match) then per regency in `DAERAH_URUTAN` order, executive before
 * legislative within each group — "ordered as seputarborneo" (issue #48).
 * An institution whose `regionCode` is missing or does not resolve to a
 * known Kalteng region is APPENDED, sorted by name, rather than dropped:
 * "all institutions, both branches" (issue #48) means every one of them
 * renders somewhere, never silently trimmed for not fitting the 14+1 groups
 * this menu is built around.
 */
export function selectMitraOrder(
  institutions: readonly RawInstitution[],
  regionByCode: ReadonlyMap<string, Pick<RegionRecord, "level" | "name">>,
  kaltengProvinceCode: string | null
): MitraNavItem[] {
  const UNRESOLVED_RANK = DAERAH_URUTAN.length + 1;

  const ranked = institutions.map((institution) => {
    const region = institution.regionCode ? regionByCode.get(institution.regionCode) : undefined;
    const isProvincial = Boolean(
      kaltengProvinceCode && institution.regionCode === kaltengProvinceCode
    );

    const groupRank = isProvincial
      ? -1
      : region && region.level === 2
        ? daerahOrderIndex(region.name)
        : UNRESOLVED_RANK;

    return { institution, groupRank, branchRank: branchOrder(institution.branch) };
  });

  ranked.sort(
    (a, b) =>
      a.groupRank - b.groupRank ||
      a.branchRank - b.branchRank ||
      a.institution.name.localeCompare(b.institution.name)
  );

  return ranked.map(({ institution }) => ({
    slug: institution.slug,
    name: institution.name,
    href: ROUTES.partner(institution.slug)
  }));
}

export async function getMitraList(): Promise<MitraNavItem[]> {
  const [institutions, regionsByCode, kalteng] = await Promise.all([
    getAllInstitutions(),
    getResolvableRegionsByCode(),
    findKaltengProvince()
  ]);

  return selectMitraOrder(institutions, regionsByCode, kalteng?.code ?? null);
}

// ---------------------------------------------------------------------------
// Umum column (`seputarborneo_nav_umum()`)
// ---------------------------------------------------------------------------

export type UmumItem = { slug: string; name: string; href: string };

/**
 * Pure — the children of a rubrik named "Umum" (case/spacing-insensitive,
 * same `normalizeForMatch` as `RUBRIK_UTAMA`), or `[]` when this build's
 * taxonomy has no such rubrik. Unlike `RUBRIK_UTAMA`'s five, "Umum"'s own
 * children (seputarborneo: Wisata, Budaya, Provinsi, Kuliner, Travel,
 * Bisnis) are read directly from whatever this build's tree actually has —
 * this app does not hard-code that six-item list, because unlike the
 * primary five (which map onto seputarborneo's own regular-post FORM
 * fields, a fixed vocabulary), "Umum"'s children are themselves ordinary
 * category terms an editor can add to or rename.
 */
export function selectUmumChildren(allRubrik: readonly RubrikNode[]): UmumItem[] {
  const umum = allRubrik.find(
    (node) => normalizeForMatch(node.name) === "umum" || normalizeForMatch(node.slug) === "umum"
  );
  if (!umum) return [];

  return umum.children.map((child) => ({
    slug: child.slug,
    name: child.name,
    href: ROUTES.rubric(child.slug)
  }));
}

export async function getUmumList(): Promise<UmumItem[]> {
  const tree = await getRubrikTree();
  return selectUmumChildren(flattenRubrikTree(tree));
}

// ---------------------------------------------------------------------------
// Perusahaan links (Redaksi / Pedoman Media Siber / Disclaimer —
// `seputarborneo_nav_perusahaan()`)
// ---------------------------------------------------------------------------

export type PerusahaanLink = { slug: string; label: string; href: string };

/** Reuses `src/config/routes.ts`'s own reserved slugs (`STATIC_PAGE_SLUGS`) rather than a second, parallel literal — the same three `Footer.astro`'s `FOOTER_PAGE_LINKS` already names. */
const PERUSAHAAN_LINKS: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: STATIC_PAGE_SLUGS.editorial, label: "Redaksi" },
  { slug: STATIC_PAGE_SLUGS.mediaGuidelines, label: "Pedoman Media Siber" },
  { slug: STATIC_PAGE_SLUGS.disclaimer, label: "Disclaimer" }
];

/** Pure — "rendered only if the page exists in `GET /api/v1/blog/pages/public`" (issue #48), the same "render only what is set" rule `Footer.astro` already applies to its own `FOOTER_PAGE_LINKS`. */
export function selectPerusahaanLinks(publishedSlugs: ReadonlySet<string>): PerusahaanLink[] {
  return PERUSAHAAN_LINKS.filter((link) => publishedSlugs.has(link.slug)).map((link) => ({
    ...link,
    href: ROUTES.page(link.slug)
  }));
}

export async function getPerusahaanLinks(): Promise<PerusahaanLink[]> {
  const pages = await listStaticPages();
  return selectPerusahaanLinks(new Set(pages.map((page) => page.slug)));
}
