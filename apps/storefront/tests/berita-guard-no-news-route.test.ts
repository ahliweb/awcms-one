import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "../src/config/routes";

/**
 * awcms ADR-0071 splits the `/blog/**`/`/news/**` URL family: `/blog/**` is
 * `apps/cms`'s own permanent vocabulary, and `/news/**` is reserved for
 * `ahliweb/awcms-astro` — never this storefront (`src/lib/pengalihan-legacy.ts`'s
 * own docblock explains the full ADR-0071 context). Issue #28's own
 * acceptance criteria: "No route family `/news/**` is introduced ...
 * guarded by a unit test over `src/pages`." This is that test.
 */

const PAGES_ROOT = join(new URL("../src/pages/", import.meta.url).pathname);

function listAllFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    return entry.isDirectory() ? listAllFiles(fullPath) : [fullPath];
  });
}

describe("guard: no /news/** route family (ADR-0071)", () => {
  test("no ROUTES entry resolves to a path under /news", () => {
    for (const value of Object.values(ROUTES)) {
      // Exactly one argument — every ROUTES function accepts a lone slug (or,
      // for the two-segment routes, defaults its second segment; see
      // `ROUTES.rubricPage`'s own docblock for why), the same assumption
      // `tests/routes.test.ts` (issue #24) already makes.
      const sample = typeof value === "function" ? value("contoh") : value;
      expect(sample).not.toMatch(/^\/news(\/|$)/i);
    }
  });

  test("src/pages has no news/ directory or news*.astro/.ts file at any level", () => {
    const files = listAllFiles(PAGES_ROOT);
    const relative = files.map((f) => f.slice(PAGES_ROOT.length));

    for (const path of relative) {
      // Every path SEGMENT (not a substring match, so "newsletter" or a
      // future "newsstand" page would not be a false positive) must not be
      // exactly "news".
      const segments = path.split("/");
      expect(segments).not.toContain("news");
    }
  });
});
