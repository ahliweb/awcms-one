import { describe, expect, test } from "bun:test";
import { ROUTES } from "../src/config/routes";
import { AD_SLOTS } from "../src/lib/awcms/iklan";
import { AD_PLACEMENT_KEYS } from "../src/lib/awcms/blog";

/** The news-specific `ROUTES` constants this issue adds (issue #24's own `tests/routes.test.ts` is untouched — this is a new file). */
describe("config/routes: issue #28 additions", () => {
  test("article/videoArticle/rubric/rubricPage/region/partner/tag/author/archive all interpolate", () => {
    expect(ROUTES.article("slug-x")).toBe("/berita/slug-x");
    expect(ROUTES.videoArticle("slug-x")).toBe("/video/slug-x");
    expect(ROUTES.rubric("politik")).toBe("/rubrik/politik");
    expect(ROUTES.rubricPage("politik", 2)).toBe("/rubrik/politik/halaman/2");
    expect(ROUTES.region("kotawaringin-barat")).toBe("/daerah/kotawaringin-barat");
    expect(ROUTES.partner("dprd-kalteng")).toBe("/mitra/dprd-kalteng");
    expect(ROUTES.tag("ekonomi")).toBe("/tag/ekonomi");
    expect(ROUTES.author("ahmad-junaidi")).toBe("/penulis/ahmad-junaidi");
    expect(ROUTES.archive("2026", "09")).toBe("/arsip/2026/09");
  });

  test("news (the front page) and article (one post) are distinct route shapes", () => {
    expect(ROUTES.news).toBe("/berita");
    expect(ROUTES.article("berita")).not.toBe(ROUTES.news);
  });

  test("newsSearch is distinct from the commerce search route (issue #24's ROUTES.search)", () => {
    expect(ROUTES.newsSearch).toBe("/cari-berita");
    expect(ROUTES.newsSearch).not.toBe(ROUTES.search);
  });
});

describe("lib/awcms/iklan: AD_SLOTS maps only to real, verified placement keys", () => {
  test("every AD_SLOTS value is a member of the verified AD_PLACEMENT_KEYS", () => {
    for (const key of Object.values(AD_SLOTS)) {
      expect(AD_PLACEMENT_KEYS).toContain(key);
    }
  });

  test("there is no 'footer' entry — no such placement key exists server-side", () => {
    expect(Object.keys(AD_SLOTS)).not.toContain("footer");
  });
});
