/**
 * Indonesian administrative region reads (issue #28's `/daerah/[slug]`) —
 * `GET /api/v1/idn-regions/regions*`, verified field-by-field against
 * `region-lookup.ts`'s `RegionRecord`/`RegionRow`.
 *
 * ## A post reaches a region ONLY through its institution
 *
 * `RawPost` (`src/lib/awcms/blog.ts`) carries no region field at all —
 * verified against `BlogPostFeedView`: the `region_code` column exists on
 * `awcms_blog_posts` (migration `sql/131`) but no application/domain code
 * reads or writes it, and the OpenAPI schema correctly omits it too. Only
 * `RawInstitution.regionCode` is real, end-to-end. So a `/daerah/{slug}`
 * page's post list is: posts whose `institutionIds` include an institution
 * whose `regionCode` resolves to this region — the exact membership rule
 * the sibling `media-lenterakalteng`'s own `arsip-wilayah.ts` uses for the
 * same reason, arrived at independently here by reading this CMS's schema
 * rather than by copying that file.
 *
 * ## Resolving "Kalteng" and "Lintas Kalimantan" without inventing a code
 *
 * The issue's IA calls for "14 Kalteng regencies/cities" and "provinces of
 * Lintas Kalimantan" — a Kemendagri numeric code for Kalimantan Tengah is
 * knowable, but hand-writing it here would be exactly the "invent a value
 * the code does not hand you" this repo's contribution rule forbids for a
 * value this cheap to look up instead. `findKaltengProvince`/
 * `listLintasKalimantanProvinces` below resolve both by NAME match against
 * the live level-1 (province) list, so a build never silently drifts from
 * whatever the active `idn_admin_regions` dataset actually calls them.
 */
import { awcmsGet } from "./client";

const REGIONS_PATH = "/api/v1/idn-regions/regions";

/** One row — verified against `RegionRecord` (`region-lookup.ts`). `level` is 1 (province) through 4 (village); this app only ever asks for 1 and 2. */
export type RegionRecord = {
  code: string;
  codeCompact: string;
  parentCode: string | null;
  level: number;
  regionType: string;
  localTerm: string | null;
  name: string;
  shortName: string | null;
  fullPathName: string | null;
};

type RegionsPage = {
  items: RegionRecord[];
  nextCursor: string | null;
  reason: "no_active_dataset" | "dataset_not_found" | null;
};

/** Server-side max (`region-lookup.ts`'s `REGION_PAGE_LIMIT_MAX`). */
const REGION_PAGE_SIZE = 200;

/** A runaway-loop backstop, same reasoning as `src/lib/awcms/blog.ts`'s `MAX_PAGES` — a national dataset has ~90,000 villages at level 4, but this app only ever queries level 1/2, which is a few hundred rows at most. */
const MAX_PAGES = 50;

async function listRegions(query: {
  level?: number;
  parentCode?: string;
}): Promise<RegionRecord[]> {
  const items: RegionRecord[] = [];
  let after: string | undefined;

  for (let page = 1; ; page += 1) {
    const response = await awcmsGet<RegionsPage>(REGIONS_PATH, {
      level: query.level,
      parentCode: query.parentCode,
      limit: REGION_PAGE_SIZE,
      after
    });

    // "No active dataset" is a real, buildable state (a fresh awcms that has
    // never imported `idn_admin_regions`) — every `/daerah/*` page then has
    // nothing to list, not a build failure.
    if (response.reason) return items;

    items.push(...response.items);
    if (!response.nextCursor) return items;

    if (page >= MAX_PAGES) {
      throw new Error(
        `Stopped walking ${REGIONS_PATH} after ${MAX_PAGES} pages and awcms ` +
          `still returned a cursor — see src/lib/awcms/blog.ts's MAX_PAGES ` +
          `docblock for the same tradeoff.`
      );
    }

    after = response.nextCursor;
  }
}

let provincesCache: Promise<RegionRecord[]> | undefined;

/** Every level-1 (province) region, fetched once and memoized. */
export function getProvinces(): Promise<RegionRecord[]> {
  provincesCache ??= listRegions({ level: 1 });
  return provincesCache;
}

const regenciesCache = new Map<string, Promise<RegionRecord[]>>();

/** Every level-2 (kabupaten/kota) region under one province code, fetched once per parent and memoized. */
export function getRegenciesOf(provinceCode: string): Promise<RegionRecord[]> {
  let cached = regenciesCache.get(provinceCode);
  if (!cached) {
    cached = listRegions({ level: 2, parentCode: provinceCode });
    regenciesCache.set(provinceCode, cached);
  }
  return cached;
}

/** Matches a province by name, case- and whitespace-insensitive — Kemendagri data is conventionally upper-cased ("KALIMANTAN TENGAH"), but this does not assume that casing. */
function matchesProvinceName(region: RegionRecord, name: string): boolean {
  return region.name.trim().toLowerCase() === name.trim().toLowerCase();
}

/** The active dataset's own row for "Kalimantan Tengah", or `null` if this dataset does not carry one (a fresh install with nothing imported yet — a real, buildable state, not an error). */
export async function findKaltengProvince(): Promise<RegionRecord | null> {
  const provinces = await getProvinces();
  return provinces.find((p) => matchesProvinceName(p, "Kalimantan Tengah")) ?? null;
}

/** Every OTHER Kalimantan province ("Lintas Kalimantan" in the issue's IA) — every level-1 row whose name starts with "Kalimantan", excluding Kalteng itself. */
export async function listLintasKalimantanProvinces(): Promise<RegionRecord[]> {
  const provinces = await getProvinces();
  return provinces.filter(
    (p) =>
      p.name.trim().toLowerCase().startsWith("kalimantan") &&
      !matchesProvinceName(p, "Kalimantan Tengah")
  );
}

let regionByCodeCache: Promise<Map<string, RegionRecord>> | undefined;

/**
 * Every region this build can resolve a name for (Kalteng's own regencies
 * plus every Lintas Kalimantan province), keyed by `code` — built once from
 * the two calls above rather than a per-institution lookup, mirroring
 * `src/lib/catalog.ts`'s "one traversal, not N+1 requests" rule.
 */
export async function getResolvableRegionsByCode(): Promise<Map<string, RegionRecord>> {
  regionByCodeCache ??= buildRegionIndex();
  return regionByCodeCache;
}

async function buildRegionIndex(): Promise<Map<string, RegionRecord>> {
  const index = new Map<string, RegionRecord>();
  const kalteng = await findKaltengProvince();
  const lintasKalimantan = await listLintasKalimantanProvinces();

  for (const province of lintasKalimantan) {
    index.set(province.code, province);
  }

  if (kalteng) {
    index.set(kalteng.code, kalteng);
    const regencies = await getRegenciesOf(kalteng.code);
    for (const regency of regencies) {
      index.set(regency.code, regency);
    }
  }

  return index;
}

/** A region this build knows how to name, by code — `null` when the code does not resolve (an institution's `regionCode` pointing outside Kalteng/Lintas Kalimantan, or an inactive dataset). Degrading here, not throwing, matches the sibling template's own choice for the same lookup: one institution with an unresolvable region loses its region label, not the whole build. */
export async function resolveRegion(code: string): Promise<RegionRecord | null> {
  const index = await getResolvableRegionsByCode();
  return index.get(code) ?? null;
}

/** Test/build seam: drops every memoized fetch in this file. */
export function resetWilayahCachesForTests(): void {
  provincesCache = undefined;
  regenciesCache.clear();
  regionByCodeCache = undefined;
}
