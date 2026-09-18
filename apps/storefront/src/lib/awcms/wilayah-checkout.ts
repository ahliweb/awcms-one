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
 *
 * ## Every request here is concurrency-bounded (issue #71)
 *
 * All fetching funnels through `listRegions`, which takes a slot from ONE
 * module-level limiter per page request — see `MAX_IN_FLIGHT_REGION_REQUESTS`
 * for the CMS admission numbers it is derived from. Callers (the routes'
 * `getStaticPaths`) may therefore keep a plain `Promise.all` over the
 * memoized getters below: the promises fan out, the HTTP requests do not.
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
 * How many `GET /api/v1/idn-regions/regions` requests this file lets be in
 * flight at once, across EVERY caller in one build (issue #71).
 *
 * ## Why a ceiling exists at all
 *
 * `wilayah-kecamatan-[cityCode].json.ts`'s `getStaticPaths` asks for the
 * districts of every regency under every configured province — 56 regencies
 * with the default `PUBLIC_WILAYAH_PROVINSI` — and a plain `Promise.all`
 * fires all 56 requests in the same tick. On the CMS side that route is
 * `workClass: "interactive"` (`apps/cms/src/pages/api/v1/idn-regions/
 * regions/index.ts`), and `apps/cms/src/lib/database/work-class.ts` admits
 * at most `WORK_CLASS_MAX.interactive` = 8 running plus a bounded FIFO
 * queue of 8 × `DATABASE_WORK_CLASS_QUEUE_MULTIPLIER` (default 4) = 32
 * waiting, i.e. 40 in total; the 41st and every later caller is rejected
 * IMMEDIATELY with `WorkClassQueueFullError` → HTTP 503. 56 − 40 = the 16
 * `database.pool.rejected` the issue reproduced, and the build failed
 * deterministically. Against the stub nothing ever fails, which is exactly
 * why the stub-backed gates never caught it.
 *
 * ## Why 6, not 40
 *
 * The number to stay under is the 8 RUNNING slots, not the 40 admitted:
 * a request that lands in the queue is not rejected, but it does wait its
 * full turn, and this storefront build is not the only `interactive`
 * client — the catalog/news/marketing fetches of the same `astro build`
 * run in parallel with this file, and a live deployment's CMS also serves
 * its own admin users. 6 keeps the whole region walk inside the running
 * slots on its own (so it never even queues on an otherwise idle CMS) while
 * leaving 2 running slots plus the entire queue for everything else, and
 * it still finishes the 56-regency default in ~10 rounds rather than 56
 * sequential ones. It is a constant, not an env variable: the CMS-side
 * numbers it is derived from are fixed code constants too (that file's own
 * header explains why), so there is nothing an operator could tune it
 * against.
 *
 * ## Why not one bigger call per province instead of many bounded ones
 *
 * Considered and rejected: `GET /api/v1/idn-regions/regions` filters by
 * `level`, by `parentCode` — an EXACT match on the row's direct parent
 * (`apps/cms/src/modules/idn-admin-regions/application/region-lookup.ts`,
 * `parent_code = $parentCode`) — and by `search`; there is no ancestor or
 * code-prefix filter, so "every level-3 row of province 62" is not a query
 * that route can answer. The only single-walk alternatives are (a) a
 * province-less `level=3` walk of the whole country — ~7,300 districts,
 * ~37 sequential 200-row pages, to keep ~630 of them — or (b) seeding the
 * `after` cursor with a province code to start the walk mid-way, which
 * works only because the cursor is implemented as `code > $after`, a detail
 * the route documents as "the last `code` of the previous page" and not as
 * a range start, and which also breaks for a non-contiguous
 * `PUBLIC_WILAYAH_PROVINSI` such as `62,72`. Both trade a bounded, honest
 * use of the documented shape for an invented one; this repo's rule is
 * never to guess an API shape, so the per-parent calls stay and only their
 * concurrency changes.
 */
export const MAX_IN_FLIGHT_REGION_REQUESTS = 6;

/** What `createConcurrencyLimiter` returns: runs `task` once a slot is free and resolves/rejects with exactly what `task` did. */
export type ConcurrencyLimiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A minimal in-process semaphore — the `p-limit` idea with no dependency,
 * because a static build has no business adding a package for twenty lines
 * of control flow. Tasks past `maxInFlight` wait FIFO; a finishing task
 * hands its slot straight to the next waiter (so the in-flight count never
 * dips and re-climbs between the two), and a task that throws still
 * releases its slot, so one failed request cannot wedge the rest of the
 * walk behind a slot that is never returned.
 *
 * Exported for `tests/wilayah-checkout.test.ts`; this file's own use is the
 * single module-level `regionRequestLimiter` below.
 */
export function createConcurrencyLimiter(maxInFlight: number): ConcurrencyLimiter {
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new Error(`createConcurrencyLimiter: maxInFlight must be a positive integer, got ${String(maxInFlight)}.`);
  }

  let active = 0;
  const waiting: Array<() => void> = [];

  function release(): void {
    const next = waiting.shift();
    // Hand-off: the slot passes to the next waiter without `active` moving,
    // exactly the way `apps/cms`'s own work-class gate releases a slot.
    if (next) next();
    else active -= 1;
  }

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active < maxInFlight) {
      active += 1;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }

    try {
      return await task();
    } finally {
      release();
    }
  };
}

/**
 * ONE limiter for the whole module, not one per fan-out: `wilayah-kabupaten-
 * [provinceCode].json.ts` and `wilayah-kecamatan-[cityCode].json.ts` each
 * run their own `getStaticPaths`, and nothing guarantees Astro runs them one
 * after the other. Applying the ceiling inside `listRegions` — the one place
 * every request of this file passes through — means no caller, present or
 * future, can fan out past it by forgetting to use a helper.
 */
const regionRequestLimiter = createConcurrencyLimiter(MAX_IN_FLIGHT_REGION_REQUESTS);

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
    // Each PAGE takes its own slot, not the whole walk: a slot then means
    // exactly one HTTP request in flight, which is the thing the CMS's
    // work-class gate counts (issue #71, `MAX_IN_FLIGHT_REGION_REQUESTS`).
    const pageQuery = { level: query.level, parentCode: query.parentCode, limit: PAGE_SIZE, after };
    const response = await regionRequestLimiter(() => awcmsGet<RegionsPage>(REGIONS_PATH, pageQuery));

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

/** Every level-2 region across EVERY configured province — the full set `getStaticPaths` for the kabupaten/kecamatan index pages needs to enumerate paths from. The `Promise.all` fans out promises only; `listRegions`'s limiter bounds the requests (issue #71). */
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
