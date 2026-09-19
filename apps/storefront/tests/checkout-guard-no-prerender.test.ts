/**
 * ADR-0007 (revised, issue #30): "the storefront stays 100% static — no
 * `prerender = false`, no runtime credential; the browser calls the CMS
 * directly." This is the issue's own named unit test: "A unit test asserts
 * no file under `src/pages` sets `prerender = false`."
 *
 * A textual grep, not an import-and-inspect: importing every `.astro`/`.ts`
 * page here would drag in Astro's own compiler pipeline and every page's
 * own build-time data fetch (`getStoreSettings()`, `getProducts()`, …) into
 * a plain `bun test` run that must stay fast and network-free — the same
 * trade `berita-guard-no-news-route.test.ts`'s own directory walk already
 * makes for a different invariant.
 *
 * Issue #137: page files now live in TWO places — `src/pages/**` (the
 * `shared` group) and `src/profil/<group>/pages/**` (every other group,
 * injected as routes by `integrations/profil.mjs`). Both are walked: a
 * route Astro builds from an injected file is exactly as capable of
 * opting out of prerendering as a file-based one, so the guard would be
 * hollow if it stopped at `src/pages/`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(new URL("../src/", import.meta.url).pathname);
const PAGES_ROOT = join(SRC_ROOT, "pages/");
const PROFIL_ROOT = join(SRC_ROOT, "profil/");
/** Where issue #30's own four pages live now (the `toko` group). */
const TOKO_PAGES_ROOT = join(PROFIL_ROOT, "toko", "pages/");

/** Every `src/pages/**` file plus every `src/profil/<group>/pages/**` file. */
function listAllPageFiles(): string[] {
  const roots = [PAGES_ROOT];
  if (existsSync(PROFIL_ROOT)) {
    for (const group of readdirSync(PROFIL_ROOT, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const pages = join(PROFIL_ROOT, group.name, "pages");
      if (existsSync(pages)) roots.push(pages);
    }
  }
  return roots.flatMap((root) => listSourceFiles(root));
}

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    return entry.name.endsWith(".astro") || entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

describe("guard: no prerender opt-out anywhere under src/pages or src/profil/*/pages (ADR-0007 revised)", () => {
  test("no page sets prerender = false", () => {
    const offenders: string[] = [];

    const files = listAllPageFiles();
    // Non-vacuity: the walk must actually have found the shared AND the
    // injected pages, or a silent path mismatch would pass this test.
    expect(files.length).toBeGreaterThan(40);

    for (const file of files) {
      const contents = readFileSync(file, "utf8");
      if (/prerender\s*=\s*false/.test(contents)) {
        offenders.push(file.slice(SRC_ROOT.length));
      }
    }

    expect(offenders).toEqual([]);
  });

  test("issue #30's own pages exist and are prerendered (no page-level `prerender` at all, which defaults to true under output: \"static\")", () => {
    for (const page of ["keranjang.astro", "checkout.astro", "pesanan.astro", "wishlist.astro"]) {
      const contents = readFileSync(join(TOKO_PAGES_ROOT, page), "utf8");
      expect(contents).not.toMatch(/export const prerender/);
    }
  });
});
