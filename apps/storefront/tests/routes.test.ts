import { describe, expect, test } from "bun:test";
import { ROUTES, ROUTE_GROUPS, STATIC_PAGE_SLUGS } from "../src/config/routes";
// Issue #137: `PRIMARY_NAV`/`FOOTER_PAGE_LINKS` moved to `src/config/profil.ts`
// (the active profile's own lists); `routes.ts` keeps the routes and their
// group annotation.
import { PRIMARY_NAV, FOOTER_PAGE_LINKS } from "../src/config/profil";

describe("config/routes", () => {
  test("every ROUTES entry is a leading-slash path or a function returning one", () => {
    for (const [key, value] of Object.entries(ROUTES)) {
      if (typeof value === "function") {
        const result = value("contoh-slug");
        expect(result.startsWith("/")).toBe(true);
        expect(result).toContain("contoh-slug");
      } else {
        expect(value.startsWith("/")).toBe(true);
      }
      void key;
    }
  });

  test("PRIMARY_NAV has a label and an href resolved from ROUTES for every entry", () => {
    expect(PRIMARY_NAV.length).toBeGreaterThan(0);
    for (const item of PRIMARY_NAV) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.href.startsWith("/")).toBe(true);
    }
  });

  test("home and contact are the two routes this issue actually builds a page for", () => {
    expect(PRIMARY_NAV.some((item) => item.href === ROUTES.home)).toBe(true);
    expect(PRIMARY_NAV.some((item) => item.href === ROUTES.contact)).toBe(true);
  });

  test("FOOTER_PAGE_LINKS slugs all come from STATIC_PAGE_SLUGS, with no duplicates", () => {
    const reservedSlugs = new Set<string>(Object.values(STATIC_PAGE_SLUGS));
    const seen = new Set<string>();

    for (const link of FOOTER_PAGE_LINKS) {
      expect(reservedSlugs.has(link.slug)).toBe(true);
      expect(seen.has(link.slug)).toBe(false);
      seen.add(link.slug);
    }
  });

  test("every ROUTES key is annotated with a page group in ROUTE_GROUPS (issue #137)", () => {
    expect(Object.keys(ROUTE_GROUPS).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const group of Object.values(ROUTE_GROUPS)) {
      expect(["shared", "toko", "berita"]).toContain(group);
    }
  });

  test("ROUTES.page and ROUTES.category interpolate the given slug", () => {
    expect(ROUTES.page("panduan-belanja")).toBe("/halaman/panduan-belanja");
    expect(ROUTES.category("makanan-minuman")).toBe("/kategori/makanan-minuman");
  });
});
