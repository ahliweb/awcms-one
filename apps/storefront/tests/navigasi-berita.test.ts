import { describe, expect, test } from "bun:test";
import {
  selectNavUtamaRubrik,
  selectDaerahList,
  selectMitraOrder,
  selectUmumChildren,
  selectPerusahaanLinks,
  DAERAH_PANEL_ID
} from "../src/lib/navigasi-berita";
import type { RubrikNode, RegionRef } from "../src/lib/berita";
import type { RawInstitution } from "../src/lib/awcms/blog";
import { ROUTES } from "../src/config/routes";

/**
 * Pure-function coverage for `src/lib/navigasi-berita.ts` (issue #48's own
 * Tests bullet: "nav omits rubriks missing from the tree; platform
 * detection; URL-scheme filter rejects `javascript:` and schemeless" — the
 * platform-detection/URL-scheme coverage lives in
 * `tests/ikon-sosial.test.ts`). No network: every `select*` function here
 * takes already-fetched data, the same convention
 * `tests/berita-rubrik.test.ts` establishes for `src/lib/berita.ts`'s own
 * pure helpers.
 */

function rubrik(overrides: Partial<RubrikNode> & { slug: string; name: string }): RubrikNode {
  return { parentSlug: null, children: [], ...overrides };
}

describe("navigasi-berita: selectNavUtamaRubrik", () => {
  test("resolves a rubrik by slug", () => {
    const items = selectNavUtamaRubrik([rubrik({ slug: "politik", name: "Politik" })]);
    expect(items).toEqual([{ label: "Politik", href: ROUTES.rubric("politik"), activePathPrefix: ROUTES.rubric("politik") }]);
  });

  test("resolves a rubrik by NAME when the slug does not match (spacing/case differ)", () => {
    const items = selectNavUtamaRubrik([rubrik({ slug: "olahraga", name: "Olah Raga" })]);
    expect(items).toEqual([{ label: "Olah Raga", href: "/rubrik/olahraga", activePathPrefix: "/rubrik/olahraga" }]);
  });

  test("a candidate with no matching rubrik is OMITTED, never a dead link", () => {
    const items = selectNavUtamaRubrik([rubrik({ slug: "politik", name: "Politik" })]);
    expect(items.map((i) => i.label)).toEqual(["Politik"]);
    expect(items.some((i) => i.label === "Nasional")).toBe(false);
  });

  test("preserves RUBRIK_UTAMA's own order regardless of input order", () => {
    const items = selectNavUtamaRubrik([
      rubrik({ slug: "wisata", name: "Wisata" }),
      rubrik({ slug: "politik", name: "Politik" }),
      rubrik({ slug: "hukum", name: "Hukum" })
    ]);
    expect(items.map((i) => i.label)).toEqual(["Politik", "Hukum", "Wisata"]);
  });

  test("an unrelated rubrik (e.g. Daerah/Mitra Borneo/Umum's own children) never matches", () => {
    const items = selectNavUtamaRubrik([rubrik({ slug: "kapuas", name: "Kapuas" })]);
    expect(items).toEqual([]);
  });
});

describe("navigasi-berita: selectDaerahList", () => {
  const regions: RegionRef[] = [
    { code: "62", slug: "kalimantan-tengah", name: "Kalimantan Tengah", level: 1 },
    { code: "62.01", slug: "kotawaringin-barat", name: "Kotawaringin Barat", level: 2 },
    { code: "62.02", slug: "palangka-raya", name: "Palangka Raya", level: 2 },
    { code: "62.03", slug: "kapuas", name: "Kapuas", level: 2 }
  ];

  test("excludes level-1 provinces — only regencies/cities belong on this menu", () => {
    const codes = new Set(["62", "62.01", "62.02", "62.03"]);
    const result = selectDaerahList(regions, codes);
    expect(result.every((r) => r.level === 2)).toBe(true);
    expect(result.some((r) => r.code === "62")).toBe(false);
  });

  test("excludes a regency with no institution", () => {
    const codes = new Set(["62.02"]);
    const result = selectDaerahList(regions, codes);
    expect(result.map((r) => r.slug)).toEqual(["palangka-raya"]);
  });

  test("sorts into seputarborneo's own canonical order, not input order", () => {
    const codes = new Set(["62.01", "62.02", "62.03"]);
    const result = selectDaerahList(regions, codes);
    // Canonical order: Palangka Raya, Kapuas, ..., Kotawaringin Barat — see
    // DAERAH_URUTAN in the source file, ported from nav_menu.php.
    expect(result.map((r) => r.name)).toEqual(["Palangka Raya", "Kapuas", "Kotawaringin Barat"]);
  });

  test("sorts correctly against the REAL dataset's own naming — the local term ('KOTA '/'KABUPATEN ') embedded in `name`, upper-case, exactly as idn_admin_regions actually exports it (not the bare display names the other tests above use)", () => {
    const realNamedRegions: RegionRef[] = [
      { code: "62.09", slug: "kabupaten-sukamara", name: "KABUPATEN SUKAMARA", level: 2 },
      { code: "62.03", slug: "kabupaten-kapuas", name: "KABUPATEN KAPUAS", level: 2 },
      { code: "62.01", slug: "kota-palangka-raya", name: "KOTA PALANGKA RAYA", level: 2 }
    ];
    const codes = new Set(["62.09", "62.03", "62.01"]);
    const result = selectDaerahList(realNamedRegions, codes);
    // Without stripping "KOTA "/"KABUPATEN ", "KOTA PALANGKA RAYA" cannot
    // match "Palangka Raya" in DAERAH_URUTAN at all and sorts LAST — this
    // asserts it sorts FIRST, per seputarborneo's own canonical order.
    expect(result.map((r) => r.name)).toEqual([
      "KOTA PALANGKA RAYA",
      "KABUPATEN KAPUAS",
      "KABUPATEN SUKAMARA"
    ]);
  });
});

describe("navigasi-berita: selectMitraOrder", () => {
  function institution(overrides: Partial<RawInstitution> & { id: string; slug: string; name: string }): RawInstitution {
    return { branch: "executive", regionCode: null, description: null, ...overrides };
  }

  test("Pemprov/DPRD Kalteng (the province) sort first, executive before legislative", () => {
    const institutions: RawInstitution[] = [
      institution({ id: "1", slug: "dprd-kalteng", name: "DPRD Kalteng", branch: "legislative", regionCode: "62" }),
      institution({ id: "2", slug: "pemprov-kalteng", name: "Pemprov Kalteng", branch: "executive", regionCode: "62" })
    ];
    const result = selectMitraOrder(institutions, new Map([["62", { level: 1, name: "Kalimantan Tengah" }]]), "62");
    expect(result.map((m) => m.name)).toEqual(["Pemprov Kalteng", "DPRD Kalteng"]);
  });

  test("regencies sort into DAERAH_URUTAN's own order, provincial always first", () => {
    const regionByCode = new Map([
      ["62.01", { level: 2, name: "Kotawaringin Barat" }],
      ["62.02", { level: 2, name: "Palangka Raya" }],
      ["62", { level: 1, name: "Kalimantan Tengah" }]
    ]);
    const institutions: RawInstitution[] = [
      institution({ id: "1", slug: "pemkab-kobar", name: "Pemkab Kotawaringin Barat", regionCode: "62.01" }),
      institution({ id: "2", slug: "pemko-palangka-raya", name: "Pemko Palangka Raya", regionCode: "62.02" }),
      institution({ id: "3", slug: "pemprov-kalteng", name: "Pemprov Kalteng", regionCode: "62" })
    ];
    const result = selectMitraOrder(institutions, regionByCode, "62");
    expect(result.map((m) => m.name)).toEqual([
      "Pemprov Kalteng",
      "Pemko Palangka Raya",
      "Pemkab Kotawaringin Barat"
    ]);
  });

  test("sorts Pemko/DPRD Palangka Raya BEFORE every other regency even when `regionByCode` uses the REAL dataset's 'KOTA '/'KABUPATEN '-prefixed names", () => {
    const regionByCode = new Map([
      ["62.01", { level: 2, name: "KOTA PALANGKA RAYA" }],
      ["62.03", { level: 2, name: "KABUPATEN KAPUAS" }],
      ["62", { level: 1, name: "KALIMANTAN TENGAH" }]
    ]);
    const institutions: RawInstitution[] = [
      institution({ id: "1", slug: "pemkab-kapuas", name: "Pemkab Kapuas", regionCode: "62.03" }),
      institution({ id: "2", slug: "pemko-palangka-raya", name: "Pemko Palangka Raya", regionCode: "62.01" })
    ];
    // Before the fix, "KOTA PALANGKA RAYA" never matches "Palangka Raya" in
    // DAERAH_URUTAN at all, so `daerahOrderIndex` answers "past the end" for
    // BOTH regencies and this test would see them in input order (Kapuas
    // first) rather than seputarborneo's own Palangka-Raya-first order.
    const result = selectMitraOrder(institutions, regionByCode, "62");
    expect(result.map((m) => m.name)).toEqual(["Pemko Palangka Raya", "Pemkab Kapuas"]);
  });

  test("an institution with no resolvable regionCode is APPENDED, never dropped", () => {
    const institutions: RawInstitution[] = [
      institution({ id: "1", slug: "unresolved", name: "Lembaga Tanpa Wilayah", regionCode: "99.99" }),
      institution({ id: "2", slug: "pemprov-kalteng", name: "Pemprov Kalteng", regionCode: "62" })
    ];
    const result = selectMitraOrder(institutions, new Map([["62", { level: 1, name: "Kalimantan Tengah" }]]), "62");
    expect(result.map((m) => m.slug)).toEqual(["pemprov-kalteng", "unresolved"]);
  });
});

describe("navigasi-berita: selectUmumChildren", () => {
  test("returns the children of a rubrik named 'Umum' (case-insensitive)", () => {
    const wisata = rubrik({ slug: "wisata-umum", name: "Wisata", parentSlug: "umum" });
    const umum = rubrik({ slug: "umum", name: "UMUM", children: [wisata] });
    expect(selectUmumChildren([umum, wisata])).toEqual([
      { slug: "wisata-umum", name: "Wisata", href: ROUTES.rubric("wisata-umum") }
    ]);
  });

  test("no 'Umum' rubrik in this build's taxonomy — an empty list, not an error", () => {
    expect(selectUmumChildren([rubrik({ slug: "politik", name: "Politik" })])).toEqual([]);
  });
});

describe("navigasi-berita: selectPerusahaanLinks", () => {
  test("renders only pages confirmed published, in Redaksi/Pedoman/Disclaimer order", () => {
    const links = selectPerusahaanLinks(new Set(["disclaimer", "redaksi"]));
    expect(links.map((l) => l.label)).toEqual(["Redaksi", "Disclaimer"]);
  });

  test("no published legal pages yet — an empty list", () => {
    expect(selectPerusahaanLinks(new Set())).toEqual([]);
  });
});

describe("navigasi-berita: DAERAH_PANEL_ID", () => {
  test("is a non-empty id usable as both an element id and an aria-controls target", () => {
    expect(DAERAH_PANEL_ID.length).toBeGreaterThan(0);
    expect(DAERAH_PANEL_ID).not.toMatch(/\s/);
  });
});
