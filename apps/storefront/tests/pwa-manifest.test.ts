/**
 * The manifest contract (issue #428) — pure, for all three profiles:
 * `buildManifest()` is what `src/pages/manifest.webmanifest.ts` serves.
 * `pwa-manifest-build-smoke.test.ts` proves the same against real builds.
 */
import { describe, expect, test } from "bun:test";
import { SITE_PROFILES } from "../src/config/profil";
import {
  ICON_PATHS,
  MANIFEST_ID,
  PROFILE_CATEGORIES,
  buildManifest,
  shortNameFor
} from "../src/lib/pwa-manifest";

describe("shortNameFor", () => {
  test("a short name is kept as is", () => {
    expect(shortNameFor("BjekMart")).toBe("BjekMart");
    expect(shortNameFor("  Toko Saya ")).toBe("Toko Saya");
  });
  test("a long name shortens to its first word, hard-cut when that is long too", () => {
    expect(shortNameFor("Borneojek Mart Pangkalan Bun")).toBe("Borneojek");
    expect(shortNameFor("Perusahaanbernamapanjangsekali Tbk").length).toBeLessThanOrEqual(12);
  });
});

describe("buildManifest", () => {
  for (const profile of SITE_PROFILES) {
    test(`profile=${profile}: stable identity, scope on the storefront origin, standalone, PNG icons`, () => {
      const manifest = buildManifest({
        name: "Contoh Situs Panjang Sekali",
        description: "Deskripsi situs.",
        themeColor: "#2563eb",
        profile
      });

      expect(manifest.id).toBe(MANIFEST_ID);
      expect(manifest.id).toBe("/");
      expect(manifest.name).toBe("Contoh Situs Panjang Sekali");
      expect(manifest.short_name.length).toBeLessThanOrEqual(12);
      expect(manifest.start_url).toBe("/");
      expect(manifest.scope).toBe("/");
      expect(manifest.display).toBe("standalone");
      expect(manifest.theme_color).toBe("#2563eb");
      expect(manifest.categories).toEqual([...PROFILE_CATEGORIES[profile]]);

      const sizes = manifest.icons.filter((i) => i.type === "image/png").map((i) => `${i.sizes}:${i.purpose}`);
      expect(sizes).toEqual(["192x192:any", "512x512:any", "512x512:maskable"]);
      // Same-origin, root-relative: nothing points at another origin.
      for (const icon of manifest.icons) expect(icon.src.startsWith("/")).toBe(true);
      expect(manifest.icons.map((i) => i.src)).toContain(ICON_PATHS.icon192);
    });
  }

  test("categories differ per profile", () => {
    expect(PROFILE_CATEGORIES.toko).toEqual(["shopping"]);
    expect(PROFILE_CATEGORIES.berita).toEqual(["news"]);
    expect(PROFILE_CATEGORIES.landing).toEqual(["business"]);
  });

  test("carries no credential or contact data", () => {
    const text = JSON.stringify(
      buildManifest({ name: "X", description: "Y", themeColor: "#000000", profile: "toko" })
    );
    expect(text).not.toMatch(/token|secret|password|@|https?:/i);
  });
});
