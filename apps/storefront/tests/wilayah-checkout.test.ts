/**
 * `src/lib/awcms/wilayah-checkout.ts` — the checkout address region index
 * builder (issue #30). Covers: `PUBLIC_WILAYAH_PROVINSI` parsing/defaulting,
 * the defensive re-filter by `level`/`parentCode` (needed because
 * `scripts/stub-awcms.mjs`'s OWN docblock says it "ignores query
 * parameters" for some routes — this file must not trust that the server
 * already filtered), memoization, and — issue #71 — the in-flight request
 * ceiling (`MAX_IN_FLIGHT_REGION_REQUESTS`) that keeps the 56-regency
 * default fan-out under the CMS's `interactive` work-class admission.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_IN_FLIGHT_REGION_REQUESTS,
  configuredProvinceCodes,
  createConcurrencyLimiter,
  getAllCheckoutRegencies,
  getCheckoutDistricts,
  getCheckoutProvinces,
  getCheckoutRegencies,
  resetWilayahCheckoutCachesForTests,
  type WilayahRegion
} from "../src/lib/awcms/wilayah-checkout";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_API_URL = process.env.AWCMS_API_URL;
const ORIGINAL_API_TOKEN = process.env.AWCMS_API_TOKEN;
const ORIGINAL_PROVINCES = process.env.PUBLIC_WILAYAH_PROVINSI;

function region(overrides: Partial<WilayahRegion>): WilayahRegion {
  return {
    code: "00",
    codeCompact: "00",
    parentCode: null,
    level: 1,
    regionType: "province",
    localTerm: null,
    name: "",
    shortName: null,
    fullPathName: null,
    ...overrides
  };
}

/** Every idn-regions call answers with THE WHOLE unfiltered set — the exact behaviour this file must defend against (see this file's own header). */
function mockUnfilteredFetch(allItems: WilayahRegion[]): void {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        success: true,
        data: { datasetCode: "test", items: allItems, nextCursor: null, reason: null }
      }),
      { headers: { "content-type": "application/json" } }
    )) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.AWCMS_API_URL = "http://awcms.test";
  process.env.AWCMS_API_TOKEN = "test-token";
  resetWilayahCheckoutCachesForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_API_URL === undefined) delete process.env.AWCMS_API_URL;
  else process.env.AWCMS_API_URL = ORIGINAL_API_URL;
  if (ORIGINAL_API_TOKEN === undefined) delete process.env.AWCMS_API_TOKEN;
  else process.env.AWCMS_API_TOKEN = ORIGINAL_API_TOKEN;
  if (ORIGINAL_PROVINCES === undefined) delete process.env.PUBLIC_WILAYAH_PROVINSI;
  else process.env.PUBLIC_WILAYAH_PROVINSI = ORIGINAL_PROVINCES;
  resetWilayahCheckoutCachesForTests();
});

describe("configuredProvinceCodes", () => {
  test("defaults to every Kalimantan province when unset", () => {
    delete process.env.PUBLIC_WILAYAH_PROVINSI;
    expect(configuredProvinceCodes()).toEqual(["61", "62", "63", "64", "65"]);
  });

  test("parses a comma-separated list, trimming whitespace", () => {
    process.env.PUBLIC_WILAYAH_PROVINSI = " 62 , 63,64 ";
    expect(configuredProvinceCodes()).toEqual(["62", "63", "64"]);
  });

  test("falls back to the default when the value is empty/blank", () => {
    process.env.PUBLIC_WILAYAH_PROVINSI = "  , ,";
    expect(configuredProvinceCodes()).toEqual(["61", "62", "63", "64", "65"]);
  });
});

describe("getCheckoutProvinces", () => {
  test("keeps only configured codes, sorted by name", () => {
    process.env.PUBLIC_WILAYAH_PROVINSI = "62,63";
    mockUnfilteredFetch([
      region({ code: "63", level: 1, name: "KALIMANTAN SELATAN" }),
      region({ code: "62", level: 1, name: "KALIMANTAN TENGAH" }),
      region({ code: "11", level: 1, name: "ACEH" })
    ]);

    return getCheckoutProvinces().then((provinces) => {
      expect(provinces.map((p) => p.code)).toEqual(["63", "62"]);
    });
  });

  test("defensively drops rows the server sent at the WRONG level, even though it asked for level=1", async () => {
    process.env.PUBLIC_WILAYAH_PROVINSI = "62";
    mockUnfilteredFetch([
      region({ code: "62", level: 1, name: "KALIMANTAN TENGAH" }),
      region({ code: "62.02", level: 2, parentCode: "62", name: "KOTAWARINGIN BARAT" })
    ]);

    const provinces = await getCheckoutProvinces();
    expect(provinces).toHaveLength(1);
    expect(provinces[0]?.code).toBe("62");
  });

  test("is memoized — a second call makes no second fetch", async () => {
    process.env.PUBLIC_WILAYAH_PROVINSI = "62";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          success: true,
          data: { items: [region({ code: "62", level: 1, name: "KALIMANTAN TENGAH" })], nextCursor: null, reason: null }
        })
      );
    }) as unknown as typeof fetch;

    await getCheckoutProvinces();
    await getCheckoutProvinces();
    expect(calls).toBe(1);
  });
});

describe("getCheckoutRegencies / getCheckoutDistricts", () => {
  test("filters to the requested parentCode and level, ignoring everything else in the page", async () => {
    mockUnfilteredFetch([
      region({ code: "62", level: 1, name: "KALIMANTAN TENGAH" }),
      region({ code: "62.02", level: 2, parentCode: "62", name: "KOTAWARINGIN BARAT" }),
      region({ code: "63.01", level: 2, parentCode: "63", name: "BANJAR" }),
      region({ code: "62.02.01", level: 3, parentCode: "62.02", name: "ARUT SELATAN" })
    ]);

    const regencies = await getCheckoutRegencies("62");
    expect(regencies.map((r) => r.code)).toEqual(["62.02"]);

    const districts = await getCheckoutDistricts("62.02");
    expect(districts.map((d) => d.code)).toEqual(["62.02.01"]);
  });

  test("getAllCheckoutRegencies flattens every configured province's regencies", async () => {
    process.env.PUBLIC_WILAYAH_PROVINSI = "62,63";
    mockUnfilteredFetch([
      region({ code: "62", level: 1, name: "KALIMANTAN TENGAH" }),
      region({ code: "63", level: 1, name: "KALIMANTAN SELATAN" }),
      region({ code: "62.02", level: 2, parentCode: "62", name: "KOTAWARINGIN BARAT" }),
      region({ code: "63.01", level: 2, parentCode: "63", name: "BANJAR" })
    ]);

    const all = await getAllCheckoutRegencies();
    expect(all.map((r) => r.code).sort()).toEqual(["62.02", "63.01"]);
  });
});

describe("createConcurrencyLimiter", () => {
  test("rejects a non-positive or non-integer ceiling", () => {
    expect(() => createConcurrencyLimiter(0)).toThrow(/positive integer/);
    expect(() => createConcurrencyLimiter(1.5)).toThrow(/positive integer/);
  });

  test("never runs more than `maxInFlight` tasks at once and resolves every task in order", async () => {
    const limit = createConcurrencyLimiter(3);
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        limit(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return index;
        })
      )
    );

    expect(maxInFlight).toBe(3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("a task that throws still releases its slot — the waiters behind it run", async () => {
    const limit = createConcurrencyLimiter(1);

    const failing = limit(async () => {
      throw new Error("boom");
    });
    const next = limit(async () => "ran");

    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe("ran");
  });
});

describe("in-flight ceiling over the real fan-out (issue #71)", () => {
  /**
   * Five provinces, 56 regencies (12+11+11+11+11 — the default
   * `PUBLIC_WILAYAH_PROVINSI`'s real count), one district each. The mocked
   * `fetch` answers the WHOLE set to every call, exactly like the stub, and
   * holds each response for a tick so overlapping requests are observable.
   */
  function buildKalimantan(): WilayahRegion[] {
    const items: WilayahRegion[] = [];
    const regencyCounts: Record<string, number> = { "61": 12, "62": 11, "63": 11, "64": 11, "65": 11 };

    for (const [provinceCode, count] of Object.entries(regencyCounts)) {
      items.push(region({ code: provinceCode, level: 1, name: `PROVINSI ${provinceCode}` }));
      for (let index = 1; index <= count; index += 1) {
        const cityCode = `${provinceCode}.${String(index).padStart(2, "0")}`;
        items.push(region({ code: cityCode, level: 2, parentCode: provinceCode, name: `KAB ${cityCode}` }));
        items.push(region({ code: `${cityCode}.01`, level: 3, parentCode: cityCode, name: `KEC ${cityCode}.01` }));
      }
    }

    return items;
  }

  /** A `fetch` that answers `allItems` unfiltered after one tick and reports how many calls overlapped. */
  function mockCountingFetch(allItems: WilayahRegion[]): { calls: () => number; maxInFlight: () => number; reset: () => void } {
    const body = JSON.stringify({
      success: true,
      data: { datasetCode: "test", items: allItems, nextCursor: null, reason: null }
    });
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;

    globalThis.fetch = (async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return new Response(body, { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    return {
      calls: () => calls,
      maxInFlight: () => maxInFlight,
      reset: () => {
        calls = 0;
        maxInFlight = 0;
      }
    };
  }

  test("56 regencies' district walks make 56 requests but never more than MAX_IN_FLIGHT_REGION_REQUESTS at once", async () => {
    delete process.env.PUBLIC_WILAYAH_PROVINSI;
    const counters = mockCountingFetch(buildKalimantan());

    const regencies = await getAllCheckoutRegencies();
    expect(regencies).toHaveLength(56);

    // Reset the counters so the assertion is about the district fan-out
    // alone — the exact `Promise.all` shape `wilayah-kecamatan-[cityCode]
    // .json.ts`'s `getStaticPaths` uses.
    counters.reset();
    const perRegency = await Promise.all(regencies.map((regency) => getCheckoutDistricts(regency.code)));

    expect(counters.calls()).toBe(56);
    expect(counters.maxInFlight()).toBe(MAX_IN_FLIGHT_REGION_REQUESTS);
    // `WORK_CLASS_MAX.interactive` in apps/cms/src/lib/database/work-class.ts
    // is 8 running slots; the ceiling must stay under it, not merely under
    // the 40 the queue admits — see the constant's own docblock.
    expect(MAX_IN_FLIGHT_REGION_REQUESTS).toBeLessThan(8);
    for (const [index, districts] of perRegency.entries()) {
      expect(districts.map((d) => d.parentCode)).toEqual([regencies[index]?.code]);
    }
  });

  test("the ceiling is shared across fan-outs, not per call site", async () => {
    process.env.PUBLIC_WILAYAH_PROVINSI = "61,62,63,64,65";
    const allItems = buildKalimantan();
    const counters = mockCountingFetch(allItems);

    // Two independent fan-outs started in the same tick — the way two
    // routes' `getStaticPaths` could overlap during one `astro build`.
    const regencyCodes = allItems.filter((item) => item.level === 2).map((item) => item.code);
    await Promise.all([
      getAllCheckoutRegencies(),
      Promise.all(regencyCodes.map((code) => getCheckoutDistricts(code)))
    ]);

    expect(counters.calls()).toBe(1 + 5 + 56);
    expect(counters.maxInFlight()).toBe(MAX_IN_FLIGHT_REGION_REQUESTS);
  });
});
