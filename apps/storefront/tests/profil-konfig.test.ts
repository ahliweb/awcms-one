/**
 * Unit tests for `src/config/profil.ts` (issue #137, ADR-0018 D2/D3) — the
 * single source every profile-aware consumer reads. Pure: no stub CMS, no
 * build. `tests/profil.test.ts` already exists for `src/lib/awcms/profil.ts`
 * (the CMS site-profile client), hence this file's name.
 *
 * What is asserted is the CONTRACT, not the current lists: every nav
 * entry, footer link, sitemap source, feed and robots rule a profile
 * declares must belong to a group that profile actually composes — the
 * property that makes "a `berita` deployment's header never shows a dead
 * Produk link" true by construction rather than by review.
 */
import { describe, expect, test } from "bun:test";
import {
  SITE_PROFILES,
  DEFAULT_SITE_PROFILE,
  PROFILE_GROUPS,
  resolveSiteProfile,
  isSiteProfile,
  isGroupActive,
  isRouteActive,
  activeRouteKeys,
  excludedRouteKeys,
  routePathPrefix,
  describeProfile,
  PROFILE_NAV,
  PROFILE_SEARCH,
  SITEMAP_SOURCE_GROUPS,
  FEEDS_ALL,
  ROBOTS_DISALLOW_ALL,
  GROUP_STYLESHEETS,
  cspNeedsFor,
  SITE_PROFILE,
  PRIMARY_NAV,
  ROBOTS_DISALLOW,
  type SiteProfile
} from "../src/config/profil";
import { ROUTES, ROUTE_GROUPS, STATIC_PAGE_SLUGS, type RouteKey } from "../src/config/routes";
import { selectPrimaryNav } from "../src/lib/navigasi-profil";

describe("config/profil: SITE_PROFILE resolution", () => {
  test("unset or blank resolves to the default (toko — BjekMart's own shape)", () => {
    expect(resolveSiteProfile(undefined)).toBe(DEFAULT_SITE_PROFILE);
    expect(resolveSiteProfile("")).toBe(DEFAULT_SITE_PROFILE);
    expect(resolveSiteProfile("   ")).toBe(DEFAULT_SITE_PROFILE);
    expect(DEFAULT_SITE_PROFILE).toBe("toko");
  });

  test("every known name resolves to itself, surrounding whitespace tolerated", () => {
    for (const profile of SITE_PROFILES) {
      expect(resolveSiteProfile(profile)).toBe(profile);
      expect(resolveSiteProfile(` ${profile} `)).toBe(profile);
    }
  });

  test("an unknown value throws, naming the variable and the accepted values — never a silent fallback", () => {
    expect(() => resolveSiteProfile("shop")).toThrow(/SITE_PROFILE="shop"/);
    expect(() => resolveSiteProfile("Toko")).toThrow(/toko, berita, landing/);
    expect(isSiteProfile("landing")).toBe(true);
    expect(isSiteProfile("LANDING")).toBe(false);
    expect(isSiteProfile(null)).toBe(false);
  });

  test("the module-level SITE_PROFILE is whatever this test process was started with (default toko)", () => {
    expect(SITE_PROFILE).toBe(resolveSiteProfile(process.env.SITE_PROFILE));
  });
});

describe("config/profil: group composition (ADR-0018 D2)", () => {
  test("toko = shared + toko + berita, berita = shared + berita, landing = shared only", () => {
    expect(PROFILE_GROUPS.toko).toEqual(["shared", "toko", "berita"]);
    expect(PROFILE_GROUPS.berita).toEqual(["shared", "berita"]);
    expect(PROFILE_GROUPS.landing).toEqual(["shared"]);
  });

  test("shared is in every profile; isGroupActive follows the table", () => {
    for (const profile of SITE_PROFILES) {
      expect(isGroupActive("shared", profile)).toBe(true);
    }
    expect(isGroupActive("toko", "berita")).toBe(false);
    expect(isGroupActive("berita", "berita")).toBe(true);
    expect(isGroupActive("berita", "landing")).toBe(false);
  });

  test("active + excluded route keys partition ROUTES for every profile", () => {
    const all = (Object.keys(ROUTES) as RouteKey[]).sort();
    for (const profile of SITE_PROFILES) {
      const active = activeRouteKeys(profile);
      const excluded = excludedRouteKeys(profile);
      expect([...active, ...excluded].sort()).toEqual(all);
      for (const key of active) expect(isRouteActive(key, profile)).toBe(true);
      for (const key of excluded) expect(isRouteActive(key, profile)).toBe(false);
    }
    // toko builds everything; landing builds only the shared routes.
    expect(excludedRouteKeys("toko")).toEqual([]);
    expect(activeRouteKeys("landing").every((key) => ROUTE_GROUPS[key] === "shared")).toBe(true);
    expect(activeRouteKeys("landing")).toContain("home");
    expect(activeRouteKeys("landing")).toContain("contact");
    expect(activeRouteKeys("landing")).toContain("page");
    expect(excludedRouteKeys("berita")).toContain("products");
    expect(excludedRouteKeys("berita")).toContain("cart");
    expect(excludedRouteKeys("berita")).not.toContain("news");
  });

  test("the matrix's edge cases are annotated as ADR-0018 decided them", () => {
    expect(ROUTE_GROUPS.partner).toBe("berita"); // mitra/[slug] — an institution directory, not a reseller page
    expect(ROUTE_GROUPS.search).toBe("toko"); // /cari searches the PRODUCT index
    expect(ROUTE_GROUPS.newsSearch).toBe("berita");
    expect(FEEDS_ALL.find((feed) => feed.href === "/feed.xml")?.group).toBe("toko"); // the root feed is the product feed
  });

  test("routePathPrefix gives the static part of every route", () => {
    expect(routePathPrefix("home")).toBe("/");
    expect(routePathPrefix("products")).toBe("/produk");
    expect(routePathPrefix("category")).toBe("/kategori/");
    expect(routePathPrefix("rubricPage")).toBe("/rubrik/");
    expect(routePathPrefix("accountOrder")).toBe("/akun/pesanan?kode=");
    for (const key of Object.keys(ROUTES) as RouteKey[]) {
      expect(routePathPrefix(key).startsWith("/")).toBe(true);
    }
  });
});

describe("config/profil: every per-profile list stays inside the profile's own groups", () => {
  test("navigation — static entries name a route whose group the profile composes", () => {
    for (const profile of SITE_PROFILES) {
      const nav = PROFILE_NAV[profile];
      expect(nav.length).toBeGreaterThan(0);
      for (const item of nav) {
        expect(item.label.length).toBeGreaterThan(0);
        expect(item.href).toBe(ROUTES[item.route] as string);
        expect(isRouteActive(item.route, profile)).toBe(true);
      }
      // Every profile's nav starts at home and offers contact.
      expect(nav[0]?.route).toBe("home");
      expect(nav.some((item) => item.route === "contact")).toBe(true);
    }
  });

  test("toko's nav is the pre-#137 PRIMARY_NAV, unchanged", () => {
    expect(PROFILE_NAV.toko.map((item) => [item.label, item.href])).toEqual([
      ["Beranda", "/"],
      ["Produk", "/produk"],
      ["Flash Sale", "/flash-sale"],
      ["Berita", "/berita"],
      ["Kontak", "/kontak"]
    ]);
  });

  test("berita's nav has no commerce entry; landing's has only home and contact", () => {
    expect(PROFILE_NAV.berita.map((item) => item.label)).toEqual(["Beranda", "Berita", "Video", "Buletin", "Kontak"]);
    expect(PROFILE_NAV.landing.map((item) => item.label)).toEqual(["Beranda", "Kontak"]);
  });

  test("search surface — products for toko, news for berita, none for landing, each an active route", () => {
    expect(PROFILE_SEARCH.toko?.action).toBe(ROUTES.search);
    expect(PROFILE_SEARCH.berita?.action).toBe(ROUTES.newsSearch);
    expect(PROFILE_SEARCH.landing).toBeNull();
    for (const profile of SITE_PROFILES) {
      const surface = PROFILE_SEARCH[profile];
      if (surface) expect(isRouteActive(surface.route, profile)).toBe(true);
    }
  });

  test("footer page links — reserved slugs only, no duplicates, shopping guide only where something is sold", () => {
    const reserved = new Set<string>(Object.values(STATIC_PAGE_SLUGS));
    for (const profile of SITE_PROFILES) {
      const links = describeProfile(profile).footerPageLinks;
      const seen = new Set<string>();
      for (const link of links) {
        expect(reserved.has(link.slug)).toBe(true);
        expect(seen.has(link.slug)).toBe(false);
        seen.add(link.slug);
      }
      const hasShoppingGuide = links.some((link) => link.slug === STATIC_PAGE_SLUGS.shoppingGuide);
      expect(hasShoppingGuide).toBe(isGroupActive("toko", profile));
      // Every profile keeps its legal pair.
      expect(seen.has(STATIC_PAGE_SLUGS.privacyPolicy)).toBe(true);
      expect(seen.has(STATIC_PAGE_SLUGS.termsOfService)).toBe(true);
    }
    expect(describeProfile("toko").footerPageLinks.length).toBe(6);
    expect(describeProfile("landing").footerPageLinks.length).toBe(2);
  });

  test("sitemap sources — the two shared sources everywhere, group sources only where the group is active", () => {
    for (const profile of SITE_PROFILES) {
      const sources = describeProfile(profile).sitemapSources;
      expect(sources).toContain("static-routes");
      expect(sources).toContain("static-pages");
      for (const name of sources) {
        expect(isGroupActive(SITEMAP_SOURCE_GROUPS[name], profile)).toBe(true);
      }
      for (const name of Object.keys(SITEMAP_SOURCE_GROUPS) as Array<keyof typeof SITEMAP_SOURCE_GROUPS>) {
        expect(sources.includes(name)).toBe(isGroupActive(SITEMAP_SOURCE_GROUPS[name], profile));
      }
    }
    expect(describeProfile("toko").sitemapSources.length).toBe(12);
    expect(describeProfile("landing").sitemapSources).toEqual(["static-routes", "static-pages"]);
  });

  test("feeds — product feed only with toko, posts feed only with berita, none for landing", () => {
    expect(describeProfile("toko").feeds.map((feed) => feed.href)).toEqual(["/feed.xml", "/berita/feed.xml"]);
    expect(describeProfile("berita").feeds.map((feed) => feed.href)).toEqual(["/berita/feed.xml"]);
    expect(describeProfile("landing").feeds).toEqual([]);
  });

  test("robots — toko emits the historical list verbatim; other profiles drop the paths they do not build", () => {
    expect(describeProfile("toko").robotsDisallow).toEqual([
      "/keranjang",
      "/checkout",
      "/pesanan",
      "/wishlist",
      "/cari",
      "/newsletter/confirm",
      "/newsletter/unsubscribe",
      "/masuk",
      "/daftar",
      "/akun",
      "/api/"
    ]);
    expect(describeProfile("berita").robotsDisallow).toEqual(["/newsletter/confirm", "/newsletter/unsubscribe", "/api/"]);
    expect(describeProfile("landing").robotsDisallow).toEqual(["/api/"]);
    for (const rule of ROBOTS_DISALLOW_ALL) {
      expect(rule.path.startsWith("/")).toBe(true);
    }
    expect(ROBOTS_DISALLOW).toEqual(describeProfile(SITE_PROFILE).robotsDisallow);
    expect(PRIMARY_NAV).toEqual(PROFILE_NAV[SITE_PROFILE]);
  });

  test("CSP — the CMS origin is needed on every profile (the visitor beacon), media sources follow the groups", () => {
    for (const profile of SITE_PROFILES) {
      const needs = cspNeedsFor(profile);
      expect(needs.connectAwcmsOrigin).toBe(true);
      expect(needs.mediaFromToko).toBe(isGroupActive("toko", profile));
      expect(needs.mediaFromBerita).toBe(isGroupActive("berita", profile));
    }
  });

  test("group-owned stylesheets — /product-labels.css is linked only when toko is built", () => {
    expect(GROUP_STYLESHEETS.map((sheet) => sheet.href)).toEqual(["/product-labels.css"]);
    expect(describeProfile("toko").groupStylesheets).toEqual(["/product-labels.css"]);
    expect(describeProfile("berita").groupStylesheets).toEqual([]);
    expect(describeProfile("landing").groupStylesheets).toEqual([]);
  });

  test("describeProfile is complete for every profile", () => {
    for (const profile of SITE_PROFILES) {
      const d = describeProfile(profile);
      expect(d.profile).toBe(profile);
      expect(d.groups).toEqual(PROFILE_GROUPS[profile]);
      expect(d.activeRoutes.length + d.excludedRoutes.length).toBe(Object.keys(ROUTES).length);
    }
  });
});

describe("lib/navigasi-profil: selectPrimaryNav (pure)", () => {
  const rubrik = [
    { slug: "politik", name: "Politik", parentSlug: null, children: [] },
    { slug: "hukum", name: "Hukum", parentSlug: null, children: [] },
    { slug: "kuliner", name: "Kuliner", parentSlug: null, children: [] }
  ] as unknown as Parameters<typeof selectPrimaryNav>[1] extends { rubrik?: infer R } ? R : never;

  test("toko: exactly the static list, dynamic input ignored", () => {
    const nav = selectPrimaryNav("toko", { rubrik, staticPages: [] });
    expect(nav.map((item) => item.label)).toEqual(["Beranda", "Produk", "Flash Sale", "Berita", "Kontak"]);
  });

  test("berita: the recognised rubrik pages follow 'Berita', unknown rubrik omitted, order kept", () => {
    const nav = selectPrimaryNav("berita", { rubrik });
    expect(nav.map((item) => item.label)).toEqual(["Beranda", "Berita", "Politik", "Hukum", "Video", "Buletin", "Kontak"]);
    expect(nav.find((item) => item.label === "Politik")?.href).toBe(ROUTES.rubric("politik"));
  });

  test("landing: every published static page between 'Beranda' and 'Kontak'", () => {
    const staticPages = [
      { slug: "tentang-kami", title: "Tentang Kami", locale: "id", updatedAt: "2026-01-01T00:00:00.000Z" },
      { slug: "layanan", title: "Layanan", locale: "id", updatedAt: "2026-01-01T00:00:00.000Z" }
    ] as unknown as Parameters<typeof selectPrimaryNav>[1] extends { staticPages?: infer P } ? P : never;
    const nav = selectPrimaryNav("landing", { staticPages });
    expect(nav.map((item) => [item.label, item.href])).toEqual([
      ["Beranda", "/"],
      ["Tentang Kami", "/halaman/tentang-kami"],
      ["Layanan", "/halaman/layanan"],
      ["Kontak", "/kontak"]
    ]);
  });

  test("every profile's resolved nav points only at routes that profile builds", () => {
    for (const profile of SITE_PROFILES as readonly SiteProfile[]) {
      const nav = selectPrimaryNav(profile, { rubrik, staticPages: [] });
      for (const item of nav) {
        const belongs = activeRouteKeys(profile).some((key) => {
          const prefix = routePathPrefix(key);
          return prefix === "/" ? item.href === "/" : item.href === prefix || item.href.startsWith(prefix);
        });
        expect(belongs).toBe(true);
      }
    }
  });
});
