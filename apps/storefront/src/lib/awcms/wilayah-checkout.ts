/**
 * Checkout address regions — `GET /api/v1/idn-regions/regions`, fetched at
 * BUILD time and baked into `/index/wilayah-*.json` (`src/pages/index/
 * wilayah-*.json.ts`) so the checkout address step never calls awcms from
 * the browser (ADR-0002 stays intact — only cart/checkout/order MUTATIONS
 * are anonymous cross-origin calls, per ADR-0007 revised; reading a fixed
 * reference dataset like admin regions has no reason to leave build time).
 *
 * ## Why this is a SEPARATE file from `src/lib/awcms/wilayah.ts`
 *
 * `wilayah.ts` (issue #28) resolves "which region does THIS institution
 * belong to" for `/daerah/{slug}` news pages — level 1/2 only, scoped to
 * Kalteng + Lintas Kalimantan by NAME match, with its own province/regency
 * memoization keyed for that one purpose. This file answers a different
 * question — "list every province/regency/district a SHOPPER may pick an
 * address in" — down to level 3 (district/kecamatan, which `wilayah.ts`
 * never fetches at all), filtered by CODE via `PUBLIC_WILAYAH_PROVINSI`
 * rather than by name, and shaped for `getStaticPaths` (one JSON file per
 * province/regency) rather than a single in-memory index. Sharing one file
 * between two independently-evolving call shapes would make a change to
 * either issue's own scope a coupled edit to the other's.
 *
 * ## Why `PUBLIC_WILAYAH_PROVINSI` is `PUBLIC_`-prefixed despite being read
 * only at build time
 *
 * No client script reads it — `readEnv` (`src/lib/env.ts`) works the same
 * whether or not a variable is `PUBLIC_`-prefixed, because it is only ever
 * evaluated at build/server time here. The prefix is used anyway, by the
 * manager's own naming for this contract, to mark it plainly as a
 * non-secret operational default (which provinces this deployment's
 * checkout offers) that an operator may reasonably want to see alongside
 * `PUBLIC_AWCMS_ORIGIN` in a deployment's environment listing — not because
 * Astro needs to inline it into a bundle.
 */
import { awcmsGet } from "./client";
import { readEnv } from "../env";

/** Same field set as `wilayah.ts`'s `RegionRecord` — copied rather than imported so a change to either file's own needs never becomes a forced edit to the other (see this file's own header). */
export type WilayahRegion = {
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
  items: WilayahRegion[];
  nextCursor: string | null;
  reason: "no_active_dataset" | "dataset_not_found" | null;
};

const REGIONS_PATH = "/api/v1/idn-regions/regions";
const PAGE_SIZE = 200;
/** A runaway-loop backstop — `wilayah.ts`'s `MAX_PAGES` docblock explains the same reasoning. A single province's regencies/districts is at most a few hundred rows. */
const MAX_PAGES = 50;

/**
 * Keeps only rows that actually match `query` — a defensive re-filter of
 * what the server already claims to have filtered by `level`/`parentCode`.
 * `apps/storefront/scripts/stub-awcms.mjs`'s local fixture server answers
 * every `idn-regions/regions` call with the SAME committed JSON regardless
 * of query string (documented in that file's own header: "ignoring their
 * query parameters exactly the way the commerce routes above already do"),
 * so without this a stub-backed build would silently mix every level and
 * every parent into one file. The real CMS route filters correctly server-
 * side, so this is a no-op there — cheap insurance either way.
 */
function matchesQuery(region: WilayahRegion, query: { level: number; parentCode?: string }): boolean {
  if (region.level !== query.level) return false;
  if (query.parentCode !== undefined && region.parentCode !== query.parentCode) return false;
  return true;
}

async function listRegions(query: { level: number; parentCode?: string }): Promise<WilayahRegion[]> {
  const items: WilayahRegion[] = [];
  let after: string | undefined;

  for (let page = 1; ; page += 1) {
    const response = await awcmsGet<RegionsPage>(REGIONS_PATH, {
      level: query.level,
      parentCode: query.parentCode,
      limit: PAGE_SIZE,
      after
    });

    if (response.reason) return items;

    items.push(...response.items.filter((region) => matchesQuery(region, query)));
    if (!response.nextCursor) return items;

    if (page >= MAX_PAGES) {
      throw new Error(
        `Stopped walking ${REGIONS_PATH} (level=${query.level}, parentCode=${query.parentCode ?? "-"}) ` +
          `after ${MAX_PAGES} pages and awcms still returned a cursor.`
      );
    }

    after = response.nextCursor;
  }
}

const DEFAULT_PROVINCE_CODES = [
  "61", // Kalimantan Barat
  "62", // Kalimantan Tengah
  "63", // Kalimantan Selatan
  "64", // Kalimantan Timur
  "65" // Kalimantan Utara
];

/**
 * The province CODES this build's checkout offers — `PUBLIC_WILAYAH_PROVINSI`
 * (comma-separated Kemendagri level-1 codes), or every Kalimantan province
 * by default. Kept as codes, not names (unlike `wilayah.ts`'s Kalteng/
 * Lintas-Kalimantan name match): a code is what the CMS's own dataset keys
 * on, and it is what an operator configuring a NON-Kalimantan deployment of
 * this same storefront template would actually have on hand.
 */
export function configuredProvinceCodes(): string[] {
  const raw = readEnv("PUBLIC_WILAYAH_PROVINSI");
  if (!raw) return DEFAULT_PROVINCE_CODES;

  const codes = raw
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code.length > 0);

  return codes.length > 0 ? codes : DEFAULT_PROVINCE_CODES;
}

let provincesCache: Promise<WilayahRegion[]> | undefined;

/** Every level-1 (province) region CONFIGURED for this build (`configuredProvinceCodes`) — fetched once, memoized, sorted by name so the static select this feeds renders in a stable, predictable order. */
export function getCheckoutProvinces(): Promise<WilayahRegion[]> {
  provincesCache ??= (async () => {
    const codes = new Set(configuredProvinceCodes());
    const all = await listRegions({ level: 1 });
    return all.filter((region) => codes.has(region.code)).sort((a, b) => a.name.localeCompare(b.name));
  })();
  return provincesCache;
}

const regenciesCache = new Map<string, Promise<WilayahRegion[]>>();

/** Every level-2 (kabupaten/kota) region under one province code — `wilayah-kabupaten-{provinceCode}.json.ts`'s own `getStaticPaths` calls this once per configured province. */
export function getCheckoutRegencies(provinceCode: string): Promise<WilayahRegion[]> {
  let cached = regenciesCache.get(provinceCode);
  if (!cached) {
    cached = listRegions({ level: 2, parentCode: provinceCode }).then((items) =>
      [...items].sort((a, b) => a.name.localeCompare(b.name))
    );
    regenciesCache.set(provinceCode, cached);
  }
  return cached;
}

const districtsCache = new Map<string, Promise<WilayahRegion[]>>();

/** Every level-3 (kecamatan/district) region under one regency/city code — `wilayah-kecamatan-{cityCode}.json.ts`'s own `getStaticPaths`. */
export function getCheckoutDistricts(cityCode: string): Promise<WilayahRegion[]> {
  let cached = districtsCache.get(cityCode);
  if (!cached) {
    cached = listRegions({ level: 3, parentCode: cityCode }).then((items) =>
      [...items].sort((a, b) => a.name.localeCompare(b.name))
    );
    districtsCache.set(cityCode, cached);
  }
  return cached;
}

/** Every level-2 region across EVERY configured province — the full set `getStaticPaths` for the kabupaten/kecamatan index pages needs to enumerate paths from. */
export async function getAllCheckoutRegencies(): Promise<WilayahRegion[]> {
  const provinces = await getCheckoutProvinces();
  const perProvince = await Promise.all(provinces.map((province) => getCheckoutRegencies(province.code)));
  return perProvince.flat();
}

/** Test/build seam: drops every memoized fetch in this file. */
export function resetWilayahCheckoutCachesForTests(): void {
  provincesCache = undefined;
  regenciesCache.clear();
  districtsCache.clear();
}
