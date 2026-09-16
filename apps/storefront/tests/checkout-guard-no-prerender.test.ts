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
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PAGES_ROOT = join(new URL("../src/pages/", import.meta.url).pathname);

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    return entry.name.endsWith(".astro") || entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

describe("guard: no prerender opt-out anywhere under src/pages (ADR-0007 revised)", () => {
  test("no page sets prerender = false", () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles(PAGES_ROOT)) {
      const contents = readFileSync(file, "utf8");
      if (/prerender\s*=\s*false/.test(contents)) {
        offenders.push(file.slice(PAGES_ROOT.length));
      }
    }

    expect(offenders).toEqual([]);
  });

  test("issue #30's own pages exist and are prerendered (no page-level `prerender` at all, which defaults to true under output: \"static\")", () => {
    for (const page of ["keranjang.astro", "checkout.astro", "pesanan.astro", "wishlist.astro"]) {
      const contents = readFileSync(join(PAGES_ROOT, page), "utf8");
      expect(contents).not.toMatch(/export const prerender/);
    }
  });
});
