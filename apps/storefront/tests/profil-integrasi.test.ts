/**
 * `integrations/profil.mjs` (issue #137, ADR-0018 D3) — the pure half of
 * the `injectRoute` integration, exercised without running Astro:
 *
 * - `routePatternFor` derives the route Astro's own file-based routing
 *   would have given the same relative path under `src/pages/`;
 * - `collectInjectedRoutes` walks the real `src/profil/<group>/pages/**`
 *   tree and yields one `{ pattern, entrypoint }` per page file, with
 *   project-root-relative entrypoints;
 * - the tree matches the profile matrix `docs/template.md` publishes —
 *   every path that table assigns to `toko`/`berita` exists under that
 *   group, every `shared` path stays under `src/pages/`, and nothing else
 *   is lying around in either place.
 *
 * The matrix is parsed from the document rather than re-typed here, so
 * the doc and the tree cannot drift apart without this test noticing.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  routePatternFor,
  collectInjectedRoutes,
  listPageFiles,
  berandaVariantPath,
  BERANDA_ALIAS,
  PROFIL_ROOT
} from "../integrations/profil.mjs";
import { SITE_PROFILES, PROFILE_GROUPS } from "../src/config/profil";

const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;
const REPO_ROOT = join(STOREFRONT_ROOT, "..", "..");
const TEMPLATE_DOC = join(REPO_ROOT, "docs", "template.md");

/** The matrix rows of `docs/template.md`: `| \`path\` | group | why |`. */
function readProfileMatrix(): Array<{ path: string; group: string }> {
  const doc = readFileSync(TEMPLATE_DOC, "utf8");
  const rows: Array<{ path: string; group: string }> = [];
  for (const match of doc.matchAll(/^\| `([^`]+)` \| (shared|toko|berita)(?: \([^)]*\))? \| /gm)) {
    rows.push({ path: match[1] ?? "", group: match[2] ?? "" });
  }
  return rows;
}

describe("integrations/profil: routePatternFor", () => {
  test("pages drop their extension; index folds into its directory", () => {
    expect(routePatternFor("produk.astro")).toBe("/produk");
    expect(routePatternFor("berita/index.astro")).toBe("/berita");
    expect(routePatternFor("rubrik/[slug]/index.astro")).toBe("/rubrik/[slug]");
    expect(routePatternFor("rubrik/[slug]/halaman/[n].astro")).toBe("/rubrik/[slug]/halaman/[n]");
    expect(routePatternFor("arsip/[yyyy]/[mm].astro")).toBe("/arsip/[yyyy]/[mm]");
    expect(routePatternFor("akun/index.astro")).toBe("/akun");
  });

  test("endpoints keep their document extension and drop only the module one", () => {
    expect(routePatternFor("feed.xml.ts")).toBe("/feed.xml");
    expect(routePatternFor("berita/feed.xml.ts")).toBe("/berita/feed.xml");
    expect(routePatternFor("rubrik/[slug]/feed.xml.ts")).toBe("/rubrik/[slug]/feed.xml");
    expect(routePatternFor("index/produk.json.ts")).toBe("/index/produk.json");
    expect(routePatternFor("index/wilayah-kabupaten-[provinceCode].json.ts")).toBe(
      "/index/wilayah-kabupaten-[provinceCode].json"
    );
    expect(routePatternFor("product-labels.css.ts")).toBe("/product-labels.css");
  });

  test("files Astro would not route are skipped", () => {
    expect(routePatternFor("_draft.astro")).toBeNull();
    expect(routePatternFor("akun/_shared/thing.astro")).toBeNull();
    expect(routePatternFor("notes.txt")).toBeNull();
    expect(routePatternFor("README")).toBeNull();
  });
});

describe("integrations/profil: the real src/profil tree", () => {
  const matrix = readProfileMatrix();

  test("the matrix in docs/template.md parsed (52 rows, 3 groups)", () => {
    expect(matrix.length).toBe(52);
    expect(matrix.filter((row) => row.group === "shared").length).toBe(10);
    expect(matrix.filter((row) => row.group === "toko").length).toBe(23);
    expect(matrix.filter((row) => row.group === "berita").length).toBe(19);
  });

  test("every matrix row's file lives where its group says, and nowhere else", () => {
    for (const row of matrix) {
      const sharedPath = join(STOREFRONT_ROOT, "src", "pages", row.path);
      const tokoPath = join(STOREFRONT_ROOT, PROFIL_ROOT, "toko", "pages", row.path);
      const beritaPath = join(STOREFRONT_ROOT, PROFIL_ROOT, "berita", "pages", row.path);
      const where = { shared: sharedPath, toko: tokoPath, berita: beritaPath } as const;
      const expected = where[row.group as keyof typeof where];
      expect(existsSync(expected)).toBe(true);
      for (const [group, candidate] of Object.entries(where)) {
        if (group !== row.group) expect(existsSync(candidate)).toBe(false);
      }
    }
  });

  test("src/pages holds exactly the shared rows; each group dir holds exactly its rows", () => {
    const sharedFiles = listPageFiles(join(STOREFRONT_ROOT, "src", "pages"));
    expect(sharedFiles.sort()).toEqual(matrix.filter((r) => r.group === "shared").map((r) => r.path).sort());
    for (const group of ["toko", "berita"] as const) {
      const files = listPageFiles(join(STOREFRONT_ROOT, PROFIL_ROOT, group, "pages"));
      expect(files.sort()).toEqual(matrix.filter((r) => r.group === group).map((r) => r.path).sort());
    }
  });

  test("collectInjectedRoutes yields one root-relative entrypoint per non-shared page, patterns unique and disjoint from src/pages", () => {
    const routes = collectInjectedRoutes(STOREFRONT_ROOT, ["shared", "toko", "berita"]);
    expect(routes.length).toBe(42);
    expect(routes.filter((r) => r.group === "toko").length).toBe(23);
    expect(routes.filter((r) => r.group === "berita").length).toBe(19);

    const patterns = routes.map((r) => r.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);

    const sharedPatterns = listPageFiles(join(STOREFRONT_ROOT, "src", "pages"))
      .map((file) => routePatternFor(file))
      .filter((p): p is string => p !== null);
    for (const pattern of patterns) expect(sharedPatterns).not.toContain(pattern);

    for (const route of routes) {
      expect(route.entrypoint.startsWith(`./${PROFIL_ROOT}/${route.group}/pages/`)).toBe(true);
      expect(existsSync(join(STOREFRONT_ROOT, route.entrypoint))).toBe(true);
      expect(route.pattern.startsWith("/")).toBe(true);
    }
  });

  test("the group filter is honoured: berita-only injects 19, shared-only injects nothing", () => {
    expect(collectInjectedRoutes(STOREFRONT_ROOT, ["shared", "berita"]).length).toBe(19);
    expect(collectInjectedRoutes(STOREFRONT_ROOT, ["shared"]).length).toBe(0);
    for (const profile of SITE_PROFILES) {
      const expected = PROFILE_GROUPS[profile].reduce(
        (n, group) => n + (group === "toko" ? 23 : group === "berita" ? 19 : 0),
        0
      );
      expect(collectInjectedRoutes(STOREFRONT_ROOT, PROFILE_GROUPS[profile]).length).toBe(expected);
    }
  });

  test("every profile has a home variant for the @profil/beranda alias, and src/pages/index.astro imports it", () => {
    expect(BERANDA_ALIAS).toBe("@profil/beranda");
    for (const profile of SITE_PROFILES) {
      expect(existsSync(join(STOREFRONT_ROOT, berandaVariantPath(profile)))).toBe(true);
    }
    const index = readFileSync(join(STOREFRONT_ROOT, "src", "pages", "index.astro"), "utf8");
    expect(index).toContain(`from "${BERANDA_ALIAS}"`);
  });
});
