/**
 * Issue #535: the `landing` profile builds without CMS credentials.
 *
 * `buildsWithoutCms()` is true only for `SITE_PROFILE=landing` with
 * `AWCMS_API_URL` unset, and each build-time reader the landing profile
 * reaches returns its empty value on that answer WITHOUT any network call
 * (every `fetch` below throws). `toko`/`berita` with no URL, and `landing`
 * with a URL, are unchanged: the existing loud failure / normal fetch.
 *
 * Starts no server and uses no port.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildsWithoutCms } from "../src/lib/awcms/tanpa-cms";
import {
  getStaticPage,
  listStaticPages,
  resetStaticPagesCacheForTests,
} from "../src/lib/awcms/pages";
import {
  getSiteIdentity,
  resetSiteIdentityCacheForTests,
} from "../src/lib/awcms/profil";
import {
  getMediaPublicOrigin,
  resetMediaCachesForTests,
} from "../src/lib/awcms/media";
import {
  getStoreSettings,
  resetPemasaranCacheForTests,
} from "../src/lib/awcms/pemasaran";

const KEYS = [
  "SITE_PROFILE",
  "AWCMS_API_URL",
  "AWCMS_API_TOKEN",
  "SITE_NAME",
  "SITE_DESCRIPTION",
] as const;
const SAVED: Record<string, string | undefined> = {};
const ORIGINAL_FETCH = globalThis.fetch;
let fetchCalls = 0;

function setEnv(profile: string | undefined, apiUrl: string | undefined): void {
  for (const [key, value] of [
    ["SITE_PROFILE", profile],
    ["AWCMS_API_URL", apiUrl],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  for (const key of KEYS) SAVED[key] = process.env[key];
  delete process.env.SITE_NAME;
  delete process.env.SITE_DESCRIPTION;
  fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("network call is forbidden in this test");
  }) as unknown as typeof fetch;
  resetStaticPagesCacheForTests();
  resetSiteIdentityCacheForTests();
  resetMediaCachesForTests();
  resetPemasaranCacheForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const key of KEYS) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

describe("buildsWithoutCms", () => {
  test("true only for landing with AWCMS_API_URL unset", () => {
    setEnv("landing", undefined);
    expect(buildsWithoutCms()).toBe(true);
    setEnv("landing", "   ");
    expect(buildsWithoutCms()).toBe(true);
  });

  test("false for landing with a CMS configured", () => {
    setEnv("landing", "https://cms.example.test");
    expect(buildsWithoutCms()).toBe(false);
  });

  test("false for toko and berita, and for the default profile, without a URL", () => {
    for (const profile of ["toko", "berita", undefined]) {
      setEnv(profile, undefined);
      expect(buildsWithoutCms()).toBe(false);
    }
  });
});

describe("landing without a CMS: early returns, no network", () => {
  beforeEach(() => setEnv("landing", undefined));

  test("pages: empty list, null detail", async () => {
    expect(await listStaticPages()).toEqual([]);
    expect(await getStaticPage("kebijakan-privasi")).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  test("site identity: defaults and SITE_NAME / SITE_DESCRIPTION apply", async () => {
    const identity = await getSiteIdentity();
    expect(identity.name.length).toBeGreaterThan(0);
    expect(identity.socialLinks).toEqual([]);
    expect(identity.logoMediaId).toBeNull();

    resetSiteIdentityCacheForTests();
    process.env.SITE_NAME = "Contoh Perusahaan";
    process.env.SITE_DESCRIPTION = "Profil perusahaan";
    const overridden = await getSiteIdentity();
    expect(overridden.name).toBe("Contoh Perusahaan");
    expect(overridden.description).toBe("Profil perusahaan");
    expect(fetchCalls).toBe(0);
  });

  test("store settings: the empty settings", async () => {
    const settings = await getStoreSettings();
    expect(settings.storeName).toBe("");
    expect(settings.logo).toBeNull();
    expect(settings.favicon).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  test("media public origin: unconfigured", async () => {
    expect(await getMediaPublicOrigin()).toEqual({
      configured: false,
      origin: null,
      baseUrl: null,
    });
    expect(fetchCalls).toBe(0);
  });
});

describe("everything else is unchanged", () => {
  test("toko without a URL still fails loudly", async () => {
    setEnv("toko", undefined);
    await expect(listStaticPages()).rejects.toThrow(/AWCMS_API_URL is not set/);
    await expect(getSiteIdentity()).rejects.toThrow(/AWCMS_API_URL is not set/);
    await expect(getMediaPublicOrigin()).rejects.toThrow(
      /AWCMS_API_URL is not set/,
    );
    await expect(getStoreSettings()).rejects.toThrow(
      /AWCMS_API_URL is not set/,
    );
  });

  test("berita without a URL still fails loudly", async () => {
    setEnv("berita", undefined);
    await expect(listStaticPages()).rejects.toThrow(/AWCMS_API_URL is not set/);
  });

  test("landing with a URL still reads the CMS", async () => {
    setEnv("landing", "http://awcms.test");
    process.env.AWCMS_API_TOKEN = "t";
    await expect(listStaticPages()).rejects.toThrow();
    expect(fetchCalls).toBe(1);
  });
});
