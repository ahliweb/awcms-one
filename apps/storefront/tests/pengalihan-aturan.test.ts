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
 * for every bullet of that issue's scope, PLUS the six defects found in
 * PR #61's review (each test below that exercises one names it explicitly).
 * `apps/storefront/tests/berita-penyaji-legacy.test.ts` (issue #28) is a
 * SEPARATE file, per that issue's own instruction not to edit it; the last
 * `describe` block below exercises the SAME "row-based map wins on overlap"
 * guarantee through `legacyRedirectLocation` itself, now that it also
 * consults this module.
 *
 * `ROW_MAP` deliberately reuses the SAME numeric id (`123`) for a news row
 * AND a video row with DIFFERENT destinations — the row-based map's
 * `/news/…`/`berita_red` and `/video/?video=…`/`berita_vid` id spaces are
 * independent (issue #58/B2), so this is the one fixture shape that can
 * actually catch a video id being resolved through the news index by
 * mistake (review defect 1).
 */
const ROW_MAP = {
  "/news/123-panduan-pemilu-2024.html": "/berita/panduan-pemilu-2024",
  // The CMS legacy importer's documented template for this site
  // (`/news/{legacyId}_{slug}.html`, underscore) — review defect 2.
  "/news/24150_artikel-legacy-underscore.html": "/berita/artikel-legacy-underscore",
  // A bare id with no slug at all — the third separator review defect 2 asks for.
  "/news/999.html": "/berita/artikel-tanpa-slug",
  // Video id 123 is a DIFFERENT post than news id 123 above (review defect 1).
  "/video/?video=123-liputan-video-banjir.html": "/berita/liputan-video-banjir",
  "/video/?video=456_video-lama-underscore.html": "/berita/video-lama-underscore"
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

describe("pengalihan-aturan: /rubrik/VIDEO.html and /rubrik/video.html -> /video (review defect 5)", () => {
  test.each([
    ["/rubrik/VIDEO.html", "/video"],
    ["/rubrik/video.html", "/video"],
    ["/rubrik/Video.html", "/video"]
  ])("%s -> %s", (source, expected) => {
    expect(ruleBasedRedirectLocation(source)).toBe(expected);
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

describe("pengalihan-aturan: /rubriks/?news=&kt=&lanjut= is the SAME dispatch as /{A}/{B}.html (review defect 3)", () => {
  test("news alone, page 1 (no lanjut) -> bare /rubrik/{slug}, exactly like /rubrik/{slug}.html", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=politik")).toBe("/rubrik/politik");
  });

  test("news alone with the OLAHRAGA display spelling -> the canonical rubrik slug", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=Olah%20Raga")).toBe("/rubrik/olahraga");
  });

  test("news alone, VIDEO -> /video, exactly like /rubrik/VIDEO.html", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=VIDEO")).toBe("/video");
  });

  test("news=daerah&kt=Sampit -> /daerah/kotawaringin-timur, NOT /rubrik/kotawaringin-timur", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=daerah&kt=Sampit")).toBe("/daerah/kotawaringin-timur");
  });

  test("news=mitra-borneo&kt=pemprov-kalteng -> /mitra/pemprov-kalteng", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=mitra-borneo&kt=pemprov-kalteng")).toBe(
      "/mitra/pemprov-kalteng"
    );
  });

  test("news=umum&kt=Wisata -> /rubrik/wisata (UMUM's children are rubriks here)", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=umum&kt=Wisata")).toBe("/rubrik/wisata");
  });

  test("lanjut > 1 -> the paginated route, only for a /rubrik/ destination", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=politik&lanjut=3")).toBe("/rubrik/politik/halaman/3");
  });

  test("lanjut=1 is page one, not a paginated URL", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=politik&lanjut=1")).toBe("/rubrik/politik");
  });

  test("lanjut is ignored for a daerah/mitra destination — no paginated route exists for them", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=daerah&kt=Sampit&lanjut=3")).toBe(
      "/daerah/kotawaringin-timur"
    );
    expect(ruleBasedRedirectLocation("/rubriks/?news=mitra-borneo&kt=pemprov-kalteng&lanjut=2")).toBe(
      "/mitra/pemprov-kalteng"
    );
  });

  test("an unrecognized first segment (via kt) matches no rule", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=produk&kt=sesuatu")).toBeNull();
  });

  test("neither news nor kt present -> no rule match", () => {
    expect(ruleBasedRedirectLocation("/rubriks/")).toBeNull();
  });
});

describe("pengalihan-aturan: /rubriks/ empty-slug guard (review defect 4)", () => {
  test("news normalizing to empty (punctuation only) matches no rule — never Location: /rubrik/", () => {
    const result = ruleBasedRedirectLocation("/rubriks/?news=%21%21%21");
    expect(result).toBeNull();
  });

  test("kt normalizing to empty, with a real news parent, also matches no rule", () => {
    expect(ruleBasedRedirectLocation("/rubriks/?news=daerah&kt=%21%21%21")).toBeNull();
  });
});

describe("pengalihan-aturan: /video/?video={id}-{slug}.html and {id}_{slug}.html (review defect 1: video id space)", () => {
  test("a known video id (hyphen separator) -> /video/{slug} of the VIDEO row's own destination slug", () => {
    expect(ruleBasedRedirectLocation("/video/?video=123-old-slug-here.html", ROW_MAP)).toBe(
      "/video/liputan-video-banjir"
    );
  });

  test("a known video id (underscore separator, the stale-slug shape) -> the same destination", () => {
    expect(ruleBasedRedirectLocation("/video/?video=456_old_slug.html", ROW_MAP)).toBe(
      "/video/video-lama-underscore"
    );
  });

  test("the bare ?video={id} shape (no slug at all) the old homepage hard-coded still resolves", () => {
    expect(ruleBasedRedirectLocation("/video/?video=123", ROW_MAP)).toBe("/video/liputan-video-banjir");
  });

  test("a video id that ALSO exists as a news id never resolves through the news row — the id spaces are disjoint", () => {
    // ROW_MAP's news row for id 123 points at /berita/panduan-pemilu-2024;
    // the video rule for the SAME id must use the VIDEO row instead,
    // never the news one.
    expect(ruleBasedRedirectLocation("/video/?video=123-x.html", ROW_MAP)).toBe("/video/liputan-video-banjir");
    expect(ruleBasedRedirectLocation("/video/?video=123-x.html", ROW_MAP)).not.toBe(
      "/video/panduan-pemilu-2024"
    );
  });

  test("an id that exists ONLY in the news id space falls back to the list, never the news target", () => {
    // id 999 exists only as a /news/999.html row in ROW_MAP.
    expect(ruleBasedRedirectLocation("/video/?video=999-x.html", ROW_MAP)).toBe("/video");
  });

  test("an unknown id -> the list page, never a guessed slug", () => {
    expect(ruleBasedRedirectLocation("/video/?video=777-unknown.html", ROW_MAP)).toBe("/video");
  });

  test("bare /video (no query) is not touched — it is already the real page", () => {
    expect(ruleBasedRedirectLocation("/video/", ROW_MAP)).toBeNull();
    expect(ruleBasedRedirectLocation("/video", ROW_MAP)).toBeNull();
  });

  test("no rowMap at all still resolves to the list page for a well-shaped but unmatchable id", () => {
    expect(ruleBasedRedirectLocation("/video/?video=1-x.html")).toBe("/video");
  });
});

describe("pengalihan-aturan: /img/?news={id} (review defect 2: -, _ and . separators)", () => {
  test("a known id, hyphen separator -> the row's own destination, verbatim", () => {
    expect(ruleBasedRedirectLocation("/img/?news=123", ROW_MAP)).toBe("/berita/panduan-pemilu-2024");
  });

  test("a known id, underscore separator (the importer's documented template) -> the row's destination", () => {
    expect(ruleBasedRedirectLocation("/img/?news=24150", ROW_MAP)).toBe("/berita/artikel-legacy-underscore");
  });

  test("a known id with a bare (dot) row and no slug at all -> the row's destination", () => {
    expect(ruleBasedRedirectLocation("/img/?news=999", ROW_MAP)).toBe("/berita/artikel-tanpa-slug");
  });

  test("an unknown id -> the news front page, never a guess", () => {
    expect(ruleBasedRedirectLocation("/img/?news=555", ROW_MAP)).toBe("/berita");
  });

  test("an id that exists only in the VIDEO id space never resolves here either — the spaces stay disjoint", () => {
    // id 456 exists only as a /video/?video=456_… row in ROW_MAP.
    expect(ruleBasedRedirectLocation("/img/?news=456", ROW_MAP)).toBe("/berita");
  });

  test("a non-numeric news value -> the news front page", () => {
    expect(ruleBasedRedirectLocation("/img/?news=abc", ROW_MAP)).toBe("/berita");
  });

  test("bare /img with no news parameter matches no rule here", () => {
    expect(ruleBasedRedirectLocation("/img/", ROW_MAP)).toBeNull();
  });
});

describe("pengalihan-aturan: the id index is built once per rowMap object, not rescanned per request (review defect 6)", () => {
  test("Object.entries/ownKeys on the row map is invoked at most once across many resolutions of the SAME object", () => {
    let ownKeysCalls = 0;
    const target: Record<string, string> = {
      "/news/1-a.html": "/berita/a",
      "/video/?video=2-b.html": "/berita/b"
    };
    const proxied = new Proxy(target, {
      ownKeys(t) {
        ownKeysCalls++;
        return Reflect.ownKeys(t);
      }
    });

    expect(ruleBasedRedirectLocation("/img/?news=1", proxied)).toBe("/berita/a");
    expect(ruleBasedRedirectLocation("/img/?news=1", proxied)).toBe("/berita/a");
    expect(ruleBasedRedirectLocation("/video/?video=2-b.html", proxied)).toBe("/video/b");

    expect(ownKeysCalls).toBe(1);
  });

  test("two DIFFERENT rowMap objects are indexed independently — no cross-object cache bleed", () => {
    const mapA = { "/news/1-a.html": "/berita/a" };
    const mapB = { "/news/1-b.html": "/berita/b" };
    expect(ruleBasedRedirectLocation("/img/?news=1", mapA)).toBe("/berita/a");
    expect(ruleBasedRedirectLocation("/img/?news=1", mapB)).toBe("/berita/b");
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
      "/rubrik/politik/halaman/3",
      "/daerah/kotawaringin-timur",
      "/daerah/palangka-raya",
      "/mitra/pemprov-kalteng",
      "/mitra/dprd-kalteng",
      "/video/panduan-pemilu-2024",
      "/video/liputan-video-banjir",
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

  test("the video/img rules see the SAME map legacyRedirectLocation was given, and keep their id spaces separate", () => {
    expect(legacyRedirectLocation("/img/?news=123", ROW_MAP)).toBe("/berita/panduan-pemilu-2024");
    expect(legacyRedirectLocation("/video/?video=123-x.html", ROW_MAP)).toBe("/video/liputan-video-banjir");
  });

  test("a path neither map nor any rule recognizes still returns null", () => {
    expect(legacyRedirectLocation("/produk/whatever.html", {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue #58 review round 2 — the QUERY-FREE synthetic video key.
//
// The CMS strips the query string from every redirect source at write time
// (`validateRedirectInput` → `normalizeRedirectPath` without `keepQuery`),
// so the `/video/?video={id}-…` keys `ROW_MAP` above carries can never come
// out of `GET /api/v1/seo/redirects`. What the exporter writes — and what
// `pengalihan-legacy.json` therefore really holds after the import — is
// `/video/{id}-{slug}.html` (`videoRedirectSourcePath` in
// `tools/import-seputarborneo.ts`). The tests below are the contract for
// that shape; the `?video=` tests above stay as the defensive path.
// ---------------------------------------------------------------------------

const ROW_MAP_SYNTHETIC_VIDEO_KEYS = {
  // News id 123 and video id 123 are still two different posts (defect 1).
  "/news/123-panduan-pemilu-2024.html": "/berita/panduan-pemilu-2024",
  "/video/123-liputan-video-banjir.html": "/video/liputan-video-banjir",
  // An underscore-separated key (accepted, though the exporter never emits it).
  "/video/456_video-lama-underscore.html": "/video/video-lama-underscore",
  // A title that slugified to nothing — the exporter's `/video/{id}.html` fallback.
  "/video/789.html": "/video/video-tanpa-judul"
};

describe("pengalihan-aturan: the exporter's query-free /video/{id}-{slug}.html key answers the REAL /video/?video= inbound URL (issue #58 review round 2)", () => {
  test("/video/?video={id}-{slug}.html resolves through a /video/{id}-… row, by id only", () => {
    expect(ruleBasedRedirectLocation("/video/?video=123-liputan-video-banjir.html", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBe(
      "/video/liputan-video-banjir"
    );
    // A stale slug in the request — the legacy page itself only read the id.
    expect(ruleBasedRedirectLocation("/video/?video=123-judul-basi.html", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBe(
      "/video/liputan-video-banjir"
    );
  });

  test("the underscore and bare ?video={id} request shapes resolve through the same key", () => {
    expect(ruleBasedRedirectLocation("/video/?video=123_judul_lama.html", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBe(
      "/video/liputan-video-banjir"
    );
    expect(ruleBasedRedirectLocation("/video/?video=123", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBe(
      "/video/liputan-video-banjir"
    );
  });

  test("every separator the exporter (or an operator) can put after the id is indexed: -, _ and .", () => {
    expect(ruleBasedRedirectLocation("/video/?video=456", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBe(
      "/video/video-lama-underscore"
    );
    expect(ruleBasedRedirectLocation("/video/?video=789-x.html", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBe(
      "/video/video-tanpa-judul"
    );
  });

  test("the id spaces stay disjoint under the new key: video id 123 never resolves through news row 123, and vice versa", () => {
    expect(ruleBasedRedirectLocation("/video/?video=123-x.html", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).not.toBe(
      "/berita/panduan-pemilu-2024"
    );
    expect(ruleBasedRedirectLocation("/img/?news=456", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBe("/berita");
    expect(ruleBasedRedirectLocation("/img/?news=123", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBe(
      "/berita/panduan-pemilu-2024"
    );
  });

  test("a /video/{id}-… key is a prefix match on the digits, never a substring one — id 12 does not hit the 123 row", () => {
    expect(ruleBasedRedirectLocation("/video/?video=12-x.html", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBe("/video");
    expect(ruleBasedRedirectLocation("/video/?video=1", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBe("/video");
  });

  test("a map holding BOTH shapes for different ids indexes each once, first key per id wins", () => {
    const mixed = {
      "/video/1-a.html": "/video/a",
      "/video/?video=2-b.html": "/video/b",
      // A second key for id 1 (the shape the exporter does not emit) is ignored — not a conflict.
      "/video/1_a-lama.html": "/video/a-lama"
    };
    expect(ruleBasedRedirectLocation("/video/?video=1-x.html", mixed)).toBe("/video/a");
    expect(ruleBasedRedirectLocation("/video/?video=2-x.html", mixed)).toBe("/video/b");
  });

  test("the bare /video list page is still untouched when the map only has synthetic keys", () => {
    expect(ruleBasedRedirectLocation("/video", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBeNull();
    expect(ruleBasedRedirectLocation("/video/", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBeNull();
  });

  test("through legacyRedirectLocation: the synthetic key itself is an ordinary row hit, and the real URL falls through to the rule", () => {
    // Nobody ever linked to this path, but if they do, the row map answers it directly.
    expect(legacyRedirectLocation("/video/123-liputan-video-banjir.html", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBe(
      "/video/liputan-video-banjir"
    );
    // The real legacy URL: path `/video` misses the map, the rule answers by id.
    expect(legacyRedirectLocation("/video/?video=123-liputan-video-banjir.html", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBe(
      "/video/liputan-video-banjir"
    );
    // And the list page itself is never redirected — the defect the synthetic key exists to prevent.
    expect(legacyRedirectLocation("/video", ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBeNull();
  });

  test("loop guard holds for the new key's destinations: /video/{slug} matches no rule and no row", () => {
    for (const destination of Object.values(ROW_MAP_SYNTHETIC_VIDEO_KEYS)) {
      expect(legacyRedirectLocation(destination, ROW_MAP_SYNTHETIC_VIDEO_KEYS)).toBeNull();
    }
  });
});
