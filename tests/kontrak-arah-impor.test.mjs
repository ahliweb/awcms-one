/**
 * Import-direction gate: `storefront -> kontrak -> cms`, never the reverse
 * (issue #6).
 *
 * ## The rule this guards, and why it needs its own check
 *
 * `packages/kontrak/` exports the DTO types `apps/storefront` needs,
 * IMPORTED from `apps/cms` — that is issue #6 itself. But an import can flow
 * either direction, and only ONE is allowed: `storefront -> kontrak -> cms`.
 * Never `cms -> storefront` and never `cms -> kontrak`, because `apps/cms`
 * is upstream code vendored whole via `git subtree` (`AGENTS.md`, "The
 * subtree embed") — a dependency pointing BACK at this repository's own code
 * would turn every future `git subtree pull` into a merge conflict against
 * code upstream has never heard of.
 *
 * A rule that exists only as prose gets violated sooner or later; this is
 * the gate that turns it red instead.
 *
 * ## What is checked, and what is not
 *
 * Every `.ts`/`.tsx`/`.astro` file under `apps/cms/src/` is scanned for an
 * import / re-export / `require` / dynamic `import()` specifier pointing at
 * `apps/storefront`, `packages/kontrak`, or an `@awcms-one/*` package. This
 * is a TEXT match on the specifier, not full module resolution — enough for
 * the violation class that is actually possible (pointing back into this
 * same repository), and it needs no `tsc`/bundler run to check.
 *
 * What is NOT checked: the contents of `apps/cms/node_modules` (not this
 * repo's own source), and whether `apps/storefront`/`packages/kontrak`
 * themselves accidentally import something from `apps/cms` OUTSIDE the pure
 * `domain/` layer — that is a per-PR human review concern (see
 * `packages/kontrak/src/index.ts`'s docblock for that boundary), not this
 * gate's.
 *
 * Run with `bun test`.
 */
import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const CMS_ROOT = "apps/cms/src";

/** Extensions that can carry an import/re-export specifier in this repo. */
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".astro"]);

/** Directories that never hold `apps/cms` source. */
const SKIP = new Set(["node_modules", "dist", ".astro"]);

function join(...parts) {
  return posix.join(...parts);
}

/** Every `.ts`/`.tsx`/`.astro` file under `dir`, relative to `ROOT`. */
function sourceFiles(dir) {
  const absolute = join(ROOT, dir);
  /** @type {string[]} */
  const result = [];

  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;

    const relative = join(dir, entry.name);

    if (entry.isDirectory()) {
      result.push(...sourceFiles(relative));
    } else if (SCANNED_EXTENSIONS.has(posix.extname(entry.name))) {
      result.push(relative);
    }
  }

  return result;
}

/**
 * Every import/re-export/`require`/dynamic `import()` specifier in one
 * file — four forms that equally bring another module into this file's
 * type/runtime graph, so all four must be checked or a real violation could
 * slip through unnoticed.
 */
function specifiersIn(content) {
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g
  ];

  /** @type {string[]} */
  const result = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) result.push(match[1]);
  }
  return result;
}

/**
 * A specifier pointing at the forbidden direction: `apps/storefront`,
 * `packages/kontrak`, or an `@awcms-one/*` package. The first two are
 * matched as a PATH SEGMENT, not a free substring, so a file name that
 * merely happens to contain "storefront" mid-word is not a false positive.
 */
function pointsForbiddenDirection(specifier) {
  return (
    /(^|\/)apps\/storefront(\/|$)/.test(specifier) ||
    /(^|\/)packages\/kontrak(\/|$)/.test(specifier) ||
    specifier.startsWith("@awcms-one/")
  );
}

describe("import direction storefront -> kontrak -> cms (issue #6)", () => {
  const files = sourceFiles(CMS_ROOT);

  test(`scans at least one file under ${CMS_ROOT}`, () => {
    assert.ok(
      files.length > 0,
      `found no .ts/.tsx/.astro file under ${CMS_ROOT} — this gate checks ` +
        "nothing when the list is empty."
    );
  });

  test("no apps/cms file imports from apps/storefront, packages/kontrak, or @awcms-one/*", () => {
    /** @type {{ file: string, specifier: string }[]} */
    const violations = [];

    for (const path of files) {
      const content = readFileSync(join(ROOT, path), "utf8");

      for (const specifier of specifiersIn(content)) {
        if (pointsForbiddenDirection(specifier)) {
          violations.push({ file: path, specifier });
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      "apps/cms imports back from apps/storefront, packages/kontrak, or an " +
        "@awcms-one/* package — the direction issue #6 explicitly forbids, " +
        "because apps/cms is upstream code vendored via git subtree: a " +
        "dependency pointing back at this repository's own code would turn " +
        "every future `git subtree pull` into a merge conflict against code " +
        "upstream has never heard of. Violations: " +
        JSON.stringify(violations, null, 2)
    );
  });
});
