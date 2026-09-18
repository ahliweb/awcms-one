import { describe, expect, test } from "bun:test";
import {
  ruleBasedRedirectLocation,
  normalizeSlugSegment,
  DAERAH_NAMES,
  MITRA_BORNEO_NAMES,
  UMUM_NAMES
} from "../server/pengalihan-aturan.mjs";
import { legacyRedirectLocation } from "../server/penyaji.mjs";

/**
 * `server/pengalihan-aturan.mjs` (issue #55 / A9) — table-driven coverage
 * for every bullet of that issue's scope. `apps/storefront/tests/
 * berita-penyaji-legacy.test.ts` (issue #28) is a SEPARATE file, per that
 * issue's own instruction not to edit it; the last `describe` block below
 * exercises the SAME "row-based map wins on overlap" guarantee through
 * `legacyRedirectLocation` itself, now that it also consults this module.
 */

/** A row-based map shaped like `pengalihan-legacy.ts`'s `buildLegacyRedirectMap` output — `/news/{id}-{slug}.html -> /berita/{slug}`, the only shape the video/img rules ever consult. */
const ROW_MAP = {
  "/news/123-panduan-pemilu-2024.html": "/berita/panduan-pemilu-2024",
  "/news/456-liputan-video-banjir.html": "/berita/liputan-video-banjir"
};

describe("pengalihan-aturan: normalizeSlugSegment", () => {
  test("lower-cases, and turns spaces/underscores/hyphens into single hyphens", () => {
    expect(normalizeSlugSegment("Olah Raga")).toBe("olah-raga");
    expect(normalizeSlugSegment("MITRA BORNEO")).toBe("mitra-borneo");
    expect(normalizeSlugSegment("Mitra-Borneo")).toBe("mitra-borneo");
    expect(normalizeSlugSegment("mitra_borneo")).toBe("mitra-borneo");
  });

  test("decodes percent-encoding before normalizing", () => {
    expect(normalizeSlugSegment("MITRA%20BORNEO")).toBe("mitra-borneo");
  });

  test("mirrors src/lib/berita.ts's slugifyName for every daerah/mitra/umum name this module knows", () => {
    for (const name of [...DAERAH_NAMES, ...MITRA_BORNEO_NAMES, ...UMUM_NAMES]) {
      // Every one of these names is plain ASCII with only spaces as
      // separators, so slugifyName's fuller Unicode handling collapses to
      // the same lower-case/hyphenate pass this module duplicates.
      expect(normalizeSlugSegment(name)).toBe(
        name
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
      );
    }
  });
});

describe("pengalihan-aturan: /rubrik/{slug}.html", () => {
  test.each([
    ["/rubrik/politik.html", "/rubrik/politik"],
    ["/rubrik/hukum.html", "/rubrik/hukum"],
    ["/rubrik/nasional.html", "/rubrik/nasional"],
    ["/rubrik/wisata.html", "/rubrik/wisata"],
    ["/rubrik/OLAHRAGA.html", "/rubrik/olahraga"],
    ["/rubrik/Olah%20Raga.html", "/rubrik/olahraga"],
    ["/rubrik/Olah Raga.html", "/rubrik/olahraga"]
  ])("%s -> %s", (source, expected) => {
    expect(ruleBasedRedirectLocation(source)).toBe(expected);
  });

  test("a path this module does not recognize returns null (falls through to the adapter)", () => {
    expect(ruleBasedRedirectLocation("/produk/some-thing.html")).toBeNull();
    expect(ruleBasedRedirectLocation("/rubrik/politik")).toBeNull(); // no `.html` — already the new shape
  });
});

describe("pengalihan-aturan: /daerah/{kategori}.html and /DAERAH/{Kategori}.html", () => {
  test.each([
    ["/daerah/palangka-raya.html", "/daerah/palangka-raya"],
    ["/DAERAH/Barito Utara.html", "/daerah/barito-utara"],
    ["/daerah/Palangkaraya.html", "/daerah/palangka-raya"],
    // Old city names -> regency slug, one per issue #55's own list.
    ["/daerah/Sampit.html", "/daerah/kotawaringin-timur"],
    ["/daerah/Pangkalan%20Bun.html", "/daerah/kotawaringin-barat"],
    ["/daerah/Kuala Kurun.html", "/daerah/gunung-mas"],
    ["/daerah/Buntok.html", "/daerah/barito-selatan"],
    ["/daerah/Tamiang Layang.html", "/daerah/barito-timur"],
    ["/daerah/Muara Teweh.html", "/daerah/barito-utara"],
    ["/daerah/Kuala Kapuas.html", "/daerah/kapuas"],
    ["/daerah/Kasongan.html", "/daerah/katingan"],
    ["/daerah/Kuala Pembuang.html", "/daerah/seruyan"],
    ["/daerah/Nanga Bulik.html", "/daerah/lamandau"],
    ["/daerah/Puruk Cahu.html", "/daerah/murung-raya"]
  ])("%s -> %s", (source, expected) => {
    expect(ruleBasedRedirectLocation(source)).toBe(expected);
  });

  test("every one of the 14 daerah's own (non-old-city) name resolves to its own slug", () => {
    for (const name of DAERAH_NAMES) {
      const encoded = encodeURIComponent(name);
      const result = ruleBasedRedirectLocation(`/daerah/${encoded}.html`);
      expect(result).not.toBeNull();
      expect(String(result)).toMatch(/^\/daerah\//);
    }
  });
});

describe("pengalihan-aturan: /mitra-borneo/{slug}.html and its legacy first-segment spellings", () => {
  test.each([
    ["/mitra-borneo/pemprov-kalteng.html", "/mitra/pemprov-kalteng"],
    ["/MITRA%20BORNEO/DPRD Kalteng.html", "/mitra/dprd-kalteng"],
    ["/Mitra-Borneo/DPRD Kalteng.html", "/mitra/dprd-kalteng"]
  ])("%s -> %s", (source, expected) => {
    expect(ruleBasedRedirectLocation(source)).toBe(expected);
  });

  test("all 24 mitra channels resolve under /mitra/", () => {
    for (const name of MITRA_BORNEO_NAMES) {
      const encoded = encodeURIComponent(name);
      const result = ruleBasedRedirectLocation(`/Mitra-Borneo/${encoded}.html`);
      expect(result).not.toBeNull();
      expect(String(result)).toMatch(/^\/mitra\//);
    }
  });
});

describe("pengalihan-aturan: /umum/{slug}.html and /UMUM/{Nama}.html — UMUM children are rubriks here", () => {
  test.each([
    ["/umum/wisata.html", "/rubrik/wisata"],
    ["/UMUM/Budaya.html", "/rubrik/budaya"],
    ["/umum/Provinsi.html", "/rubrik/provinsi"],
    ["/umum/Kuliner.html", "/rubrik/kuliner"],
    ["/umum/Travel.html", "/rubrik/travel"],
    ["/umum/Bisnis.html", "/rubrik/bisnis"]
  ])("%s -> %s", (source, expected) => {
    expect(ruleBasedRedirectLocation(source)).toBe(expected);
  });

  test("position-aware: /rubrik/wisata.html and /umum/wisata.html both land on /rubrik/wisata — the same rubrik tree, not a collision", () => {
    expect(ruleBasedRedirectLocation("/rubrik/wisata.html")).toBe("/rubrik/wisata");
    expect(ruleBasedRedirectLocation("/umum/wisata.html")).toBe("/rubrik/wisata");
  });
});

describe("pengalihan-aturan: no other pair of known names collides", () => {
  test("every rubrik topic + daerah + mitra + umum name maps to a distinct destination, except the documented WISATA/Wisata pair", () => {
    const RUBRIK_TOPICS = ["politik", "hukum", "nasional", "olahraga", "wisata"];
    const destinations = [
      ...RUBRIK_TOPICS.map((slug) => ruleBasedRedirectLocation(`/rubrik/${slug}.html`)),
      ...DAERAH_NAMES.map((name) => ruleBasedRedirectLocation(`/daerah/${encodeURIComponent(name)}.html`)),
      ...MITRA_BORNEO_NAMES.map((name) =>
        ruleBasedRedirectLocation(`/mitra-borneo/${encodeURIComponent(name)}.html`)
      ),
      ...UMUM_NAMES.map((name) => ruleBasedRedirectLocation(`/umum/${encodeURIComponent(name)}.html`))
    ];

    const seen = new Map<string, number>();
    for (const destination of destinations) {
      const key = String(destination);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
    expect(duplicates).toEqual([["/rubrik/wisata", 2]]);
  });
});

describe("pengalihan-aturan: /rubriks/?news=&kt=&lanjut=", () => {
  test("news alone, page 1 (no lanjut) -> bare /rubrik/{slug}", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=politik")).toBe("/rubrik/politik");
  });

  test("kt wins over news when both are present", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=daerah&kt=kotawaringin-timur")).toBe(
      "/rubrik/kotawaringin-timur"
    );
  });

  test("lanjut > 1 -> the paginated route", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=politik&lanjut=3")).toBe("/rubrik/politik/halaman/3");
  });

  test("lanjut=1 is page one, not a paginated URL", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=politik&lanjut=1")).toBe("/rubrik/politik");
  });

  test("neither news nor kt present -> no rule match", () => {
    expect(ruleBasedRedirectLocation("/rubriks/")).toBeNull();
  });
});

describe("pengalihan-aturan: /video/?video={id}-{slug}.html and {id}_{slug}.html", () => {
  test("a known id (hyphen separator) -> /video/{slug} of the row's OWN destination slug", () => {
    expect(ruleBasedRedirectLocation("/video/?video=123-old-slug-here.html", ROW_MAP)).toBe(
      "/video/panduan-pemilu-2024"
    );
  });

  test("a known id (underscore separator, the stale-slug shape) -> the same destination", () => {
    expect(ruleBasedRedirectLocation("/video/?video=456_old_slug.html", ROW_MAP)).toBe(
      "/video/liputan-video-banjir"
    );
  });

  test("an unknown id -> the list page, never a guessed slug", () => {
    expect(ruleBasedRedirectLocation("/video/?video=999-unknown.html", ROW_MAP)).toBe("/video");
  });

  test("bare /video (no query) is not touched — it is already the real page", () => {
    expect(ruleBasedRedirectLocation("/video/", ROW_MAP)).toBeNull();
    expect(ruleBasedRedirectLocation("/video", ROW_MAP)).toBeNull();
  });

  test("no rowMap at all still resolves to the list page for a well-shaped but unmatchable id", () => {
    expect(ruleBasedRedirectLocation("/video/?video=1-x.html")).toBe("/video");
  });
});

describe("pengalihan-aturan: /img/?news={id}", () => {
  test("a known id -> the row's own destination, verbatim", () => {
    expect(ruleBasedRedirectLocation("/img/?news=123", ROW_MAP)).toBe("/berita/panduan-pemilu-2024");
  });

  test("an unknown id -> the news front page, never a guess", () => {
    expect(ruleBasedRedirectLocation("/img/?news=999", ROW_MAP)).toBe("/berita");
  });

  test("a non-numeric news value -> the news front page", () => {
    expect(ruleBasedRedirectLocation("/img/?news=abc", ROW_MAP)).toBe("/berita");
  });

  test("bare /img with no news parameter matches no rule here", () => {
    expect(ruleBasedRedirectLocation("/img/", ROW_MAP)).toBeNull();
  });
});

describe("pengalihan-aturan: the three static pages", () => {
  test.each([
    ["/tentang_kami.html", "/halaman/redaksi"],
    ["/pedoman_media_cyber.html", "/halaman/pedoman-media-siber"],
    ["/disclimer.html", "/halaman/disclaimer"]
  ])("%s -> %s", (source, expected) => {
    expect(ruleBasedRedirectLocation(source)).toBe(expected);
  });
});

describe("pengalihan-aturan: /pencarian/?cari_berita={q} — 302, not 301", () => {
  test("a real query -> /cari-berita?q={q}, encoded", () => {
    expect(ruleBasedRedirectLocation("/pencarian/?cari_berita=pemilu%202024")).toEqual({
      location: "/cari-berita?q=pemilu%202024",
      status: 302
    });
  });

  test("an empty query -> the bare search page, still 302", () => {
    expect(ruleBasedRedirectLocation("/pencarian/?cari_berita=")).toEqual({
      location: "/cari-berita",
      status: 302
    });
  });

  test("no cari_berita parameter at all -> no rule match", () => {
    expect(ruleBasedRedirectLocation("/pencarian/")).toBeNull();
  });
});

describe("pengalihan-aturan: /index.php and /?subscribed=1", () => {
  test("/index.php -> /berita", () => {
    expect(ruleBasedRedirectLocation("/index.php")).toBe("/berita");
  });

  test("/?subscribed=1 -> /berita", () => {
    expect(ruleBasedRedirectLocation("/?subscribed=1")).toBe("/berita");
  });

  test("/ with no subscribed param, or a different value, matches no rule", () => {
    expect(ruleBasedRedirectLocation("/")).toBeNull();
    expect(ruleBasedRedirectLocation("/?subscribed=0")).toBeNull();
  });
});

describe("pengalihan-aturan: loop guard — no rule's destination matches any rule's own source shape", () => {
  test("every destination produced above is stable under a second pass", () => {
    const destinations = [
      "/rubrik/olahraga",
      "/rubrik/wisata",
      "/daerah/kotawaringin-timur",
      "/daerah/palangka-raya",
      "/mitra/pemprov-kalteng",
      "/mitra/dprd-kalteng",
      "/video/panduan-pemilu-2024",
      "/video",
      "/berita/panduan-pemilu-2024",
      "/berita",
      "/halaman/redaksi",
      "/halaman/pedoman-media-siber",
      "/halaman/disclaimer",
      "/cari-berita?q=pemilu",
      "/cari-berita"
    ];

    for (const destination of destinations) {
      expect(ruleBasedRedirectLocation(destination, ROW_MAP)).toBeNull();
    }
  });
});

describe("legacyRedirectLocation: the row-based map still wins on overlap (issue #55 wired in AFTER it, per that issue's own scope)", () => {
  test("a row-based hit is returned even when a rule-based path would also match the same source", () => {
    const map = { "/tentang_kami.html": "/halaman/some-operator-override" };
    expect(legacyRedirectLocation("/tentang_kami.html", map)).toBe("/halaman/some-operator-override");
  });

  test("a rule-based match still fires when the row-based map misses", () => {
    expect(legacyRedirectLocation("/tentang_kami.html", {})).toBe("/halaman/redaksi");
    expect(legacyRedirectLocation("/rubrik/politik.html", {})).toBe("/rubrik/politik");
  });

  test("the video/img rules see the SAME map legacyRedirectLocation was given", () => {
    expect(legacyRedirectLocation("/img/?news=123", ROW_MAP)).toBe("/berita/panduan-pemilu-2024");
  });

  test("a path neither map nor any rule recognizes still returns null", () => {
    expect(legacyRedirectLocation("/produk/whatever.html", {})).toBeNull();
  });
});
