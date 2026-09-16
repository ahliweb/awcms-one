import { describe, expect, test } from "bun:test";
import {
  buildRubrikForest,
  collectDescendantSlugs,
  collectAncestors,
  toPublicRubrikNode,
  toRegionRef,
  slugifyName,
  paginate,
  estimasiWaktuBacaMenit
} from "../src/lib/berita";
import { toMitraSummary } from "../src/lib/awcms/lembaga";
import type { RawTerm } from "../src/lib/awcms/blog";

/**
 * Rubrik hierarchy resolution + region/institution slug mapping (issue
 * #28's own Tests bullet). Exercises a real 3-level rubrik tree
 * (Peristiwa → Hukum → Pidana, beritasampit's own shape) with pure
 * functions — no network, matching this repo's established convention for
 * testing composition logic (`src/lib/awcms/profil.ts`'s
 * `mergeSiteIdentity` is tested the same way).
 */

const TERMS: RawTerm[] = [
  { id: "t-peristiwa", taxonomyType: "category", parentId: null, name: "Peristiwa", slug: "peristiwa", description: null },
  { id: "t-politik", taxonomyType: "category", parentId: null, name: "Politik", slug: "politik", description: null },
  { id: "t-hukum", taxonomyType: "category", parentId: "t-peristiwa", name: "Hukum", slug: "hukum", description: null },
  { id: "t-kriminal", taxonomyType: "category", parentId: "t-peristiwa", name: "Kriminal", slug: "kriminal", description: null },
  { id: "t-pidana", taxonomyType: "category", parentId: "t-hukum", name: "Pidana", slug: "pidana", description: null },
  { id: "t-tag-ekonomi", taxonomyType: "tag", parentId: null, name: "Ekonomi", slug: "ekonomi", description: null }
];

describe("lib/berita: buildRubrikForest — a 3-level rubrik tree", () => {
  test("only category terms become rubrik nodes — the tag term is excluded", () => {
    const { bySlug } = buildRubrikForest(TERMS);
    expect(bySlug.has("ekonomi")).toBe(false);
    expect(bySlug.size).toBe(5);
  });

  test("roots are exactly the two parentless category terms", () => {
    const { roots } = buildRubrikForest(TERMS);
    expect(roots.map((r) => r.slug).sort()).toEqual(["peristiwa", "politik"]);
  });

  test("Peristiwa has two direct children: Hukum and Kriminal", () => {
    const { roots } = buildRubrikForest(TERMS);
    const peristiwa = roots.find((r) => r.slug === "peristiwa")!;
    expect(peristiwa.children.map((c) => c.slug).sort()).toEqual(["hukum", "kriminal"]);
  });

  test("Pidana is Hukum's child, three levels deep from the root", () => {
    const { bySlug } = buildRubrikForest(TERMS);
    const pidana = bySlug.get("pidana")!;
    expect(pidana.parentSlug).toBe("hukum");
    const hukum = bySlug.get("hukum")!;
    expect(hukum.children.map((c) => c.slug)).toEqual(["pidana"]);
  });

  test("a root's parentSlug is null", () => {
    const { bySlug } = buildRubrikForest(TERMS);
    expect(bySlug.get("peristiwa")!.parentSlug).toBeNull();
  });
});

describe("lib/berita: collectDescendantSlugs", () => {
  test("Peristiwa's descendants include itself, Hukum, Kriminal, AND Pidana (grandchild)", () => {
    const { bySlug } = buildRubrikForest(TERMS);
    const slugs = collectDescendantSlugs(bySlug.get("peristiwa")!);
    expect([...slugs].sort()).toEqual(["hukum", "kriminal", "peristiwa", "pidana"]);
  });

  test("a leaf node's descendants are only itself", () => {
    const { bySlug } = buildRubrikForest(TERMS);
    expect([...collectDescendantSlugs(bySlug.get("pidana")!)]).toEqual(["pidana"]);
  });
});

describe("lib/berita: collectAncestors", () => {
  test("Pidana's ancestor chain is [Peristiwa, Hukum], root first", () => {
    const { bySlug } = buildRubrikForest(TERMS);
    const chain = collectAncestors(bySlug.get("pidana")!, bySlug);
    expect(chain).toEqual([
      { slug: "peristiwa", name: "Peristiwa" },
      { slug: "hukum", name: "Hukum" }
    ]);
  });

  test("a root rubrik has an empty ancestor chain", () => {
    const { bySlug } = buildRubrikForest(TERMS);
    expect(collectAncestors(bySlug.get("peristiwa")!, bySlug)).toEqual([]);
  });
});

describe("lib/berita: toPublicRubrikNode", () => {
  test("strips id/parentId and recurses into children", () => {
    const { roots } = buildRubrikForest(TERMS);
    const peristiwa = toPublicRubrikNode(roots.find((r) => r.slug === "peristiwa")!);

    expect(peristiwa).not.toHaveProperty("id");
    expect(peristiwa).not.toHaveProperty("parentId");
    expect(peristiwa.children.find((c) => c.slug === "hukum")?.children[0]?.slug).toBe("pidana");
  });
});

describe("lib/berita: toRegionRef — region slug mapping (no CMS-issued slug)", () => {
  test("derives an ASCII, hyphenated slug from the region's name", () => {
    const ref = toRegionRef({ code: "62.02", name: "KOTAWARINGIN BARAT", level: 2 });
    expect(ref).toEqual({ code: "62.02", slug: "kotawaringin-barat", name: "KOTAWARINGIN BARAT", level: 2 });
  });

  test("slugifyName strips diacritics and collapses non-alphanumerics", () => {
    expect(slugifyName("Kotawaringin Barat")).toBe("kotawaringin-barat");
    expect(slugifyName("D.I. Yogyakarta")).toBe("d-i-yogyakarta");
  });
});

describe("lib/awcms/lembaga: toMitraSummary — institution slug mapping", () => {
  test("an institution's slug passes through UNCHANGED (unlike a region's derived one)", () => {
    const summary = toMitraSummary(
      {
        id: "i-1",
        branch: "executive",
        name: "Pemkab Kotawaringin Barat",
        slug: "pemkab-kotawaringin-barat",
        regionCode: "62.02",
        description: "Pemerintah Kabupaten Kotawaringin Barat."
      },
      "KOTAWARINGIN BARAT"
    );

    expect(summary).toEqual({
      slug: "pemkab-kotawaringin-barat",
      name: "Pemkab Kotawaringin Barat",
      branch: "executive",
      description: "Pemerintah Kabupaten Kotawaringin Barat.",
      regionName: "KOTAWARINGIN BARAT"
    });
  });

  test("a null region name (unresolvable regionCode) is carried through as null, not omitted", () => {
    const summary = toMitraSummary(
      { id: "i-2", branch: "legislative", name: "DPRD X", slug: "dprd-x", regionCode: null, description: null },
      null
    );
    expect(summary.regionName).toBeNull();
  });
});

describe("lib/berita: paginate", () => {
  const items = Array.from({ length: 25 }, (_, i) => i);

  test("page 1 of 25 items at 10/page has 10 items and totalPages 3", () => {
    const paged = paginate(items, 1, 10);
    expect(paged.items).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(paged.currentPage).toBe(1);
    expect(paged.totalPages).toBe(3);
  });

  test("the last page carries the remainder, not a full page", () => {
    const paged = paginate(items, 3, 10);
    expect(paged.items).toEqual([20, 21, 22, 23, 24]);
  });

  test("an empty list is page 1 of 1, never page 1 of 0", () => {
    const paged = paginate([], 1, 10);
    expect(paged.totalPages).toBe(1);
    expect(paged.items).toEqual([]);
  });

  test("a page number past the end clamps to the last real page", () => {
    const paged = paginate(items, 99, 10);
    expect(paged.currentPage).toBe(3);
  });

  test("a page number below 1 clamps to page 1", () => {
    const paged = paginate(items, 0, 10);
    expect(paged.currentPage).toBe(1);
  });
});

describe("lib/berita: estimasiWaktuBacaMenit — reading time", () => {
  test("strips HTML tags before counting words", () => {
    const html = "<p>satu dua tiga</p><p>empat lima</p>";
    // 5 words at 200 wpm rounds up to 1 minute.
    expect(estimasiWaktuBacaMenit(html)).toBe(1);
  });

  test("a long body rounds UP to the next whole minute, never down", () => {
    const words = Array.from({ length: 201 }, () => "kata").join(" ");
    expect(estimasiWaktuBacaMenit(`<p>${words}</p>`)).toBe(2);
  });

  test("an empty body is still floored at 1 minute, never 0", () => {
    expect(estimasiWaktuBacaMenit("")).toBe(1);
    expect(estimasiWaktuBacaMenit("<p></p>")).toBe(1);
  });
});
