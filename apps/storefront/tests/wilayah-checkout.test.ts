/**
 * `src/lib/awcms/wilayah-checkout.ts` — the checkout address region index
 * builder (issue #30). Covers: `PUBLIC_WILAYAH_PROVINSI` parsing/defaulting,
 * the defensive re-filter by `level`/`parentCode` (needed because
 * `scripts/stub-awcms.mjs`'s OWN docblock says it "ignores query
 * parameters" for some routes — this file must not trust that the server
 * already filtered), and memoization.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  configuredProvinceCodes,
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
