/**
 * Unit tests for the bounded content-staleness logic behind `audit:graf`
 * (issue #186) — `packages/gerbang/lib/graf-checks.mjs`'s `manifestExtensions`,
 * `inScopeCandidates`, `diffManifestStaleness`, `checkStaleness`, and
 * `md5Hex`.
 *
 * Every function under test here is pure, so these run against plain
 * objects and a stub `currentHash` callback — no fixture tree, no `git`,
 * no filesystem. `tests/audit-graf.test.mjs` proves the WIRING (the runner
 * reading `manifest.json` and `git ls-files` for real); this file proves the
 * COUNTING is correct on its own, including the "under/at/over bound" and
 * "added/removed" cases issue #186's acceptance criteria name explicitly.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  checkStaleness,
  diffManifestStaleness,
  inScopeCandidates,
  manifestExtensions,
  md5Hex
} from "../packages/gerbang/lib/graf-checks.mjs";

describe("md5Hex", () => {
  test("matches node:crypto's own md5 of the same bytes", () => {
    const bytes = "the quick brown fox";
    expect(md5Hex(bytes)).toBe(createHash("md5").update(bytes).digest("hex"));
  });

  test("differs when the content differs", () => {
    expect(md5Hex("a")).not.toBe(md5Hex("b"));
  });
});

describe("manifestExtensions", () => {
  test("learns the lower-cased extension vocabulary from manifest keys", () => {
    const manifest = {
      "apps/storefront/src/config/site.ts": {},
      "apps/storefront/src/pages/index.astro": {},
      "package.json": {},
      "tools/deploy-preflight.mjs": {}
    };
    expect(manifestExtensions(manifest)).toEqual(new Set(["ts", "astro", "json", "mjs"]));
  });

  test("an empty manifest yields an empty vocabulary", () => {
    expect(manifestExtensions({})).toEqual(new Set());
  });

  test("a dotfile with no extension (a dot before any slash, not after) is not indexed", () => {
    // ".env" has no extension by this rule: the last "." is at index 0,
    // which is not > lastIndexOf("/") === -1 only when index 0... guard: "."
    // at position 0 is still > -1, so ".env" WOULD read as extension "env".
    // That matches manifest reality (graphify would never index a real
    // .env — see `_is_sensitive` in detect.py) so this is a non-issue in
    // practice; documented here so the boundary is not mysterious later.
    expect(manifestExtensions({ ".env": {} })).toEqual(new Set(["env"]));
  });
});

describe("inScopeCandidates", () => {
  const extensions = new Set(["ts", "mjs"]);

  test("keeps a tracked file whose extension is known and not excluded", () => {
    const result = inScopeCandidates(["src/thing.ts", "tools/x.mjs"], extensions, []);
    expect(result).toEqual(["src/thing.ts", "tools/x.mjs"]);
  });

  test("drops a file whose extension the manifest never showed as graphable", () => {
    const result = inScopeCandidates(["docs/notes.md"], extensions, []);
    expect(result).toEqual([]);
  });

  test("drops apps/cms/** unconditionally, even with no .graphifyignore prefix supplied", () => {
    const result = inScopeCandidates(["apps/cms/src/x.ts"], extensions, []);
    expect(result).toEqual([]);
  });

  test("drops graphify-out/** and knowledge/generated/** — this workflow's own output", () => {
    const result = inScopeCandidates(
      ["graphify-out/graph.json", "knowledge/generated/graphify/note.md"],
      new Set(["json", "md"]),
      []
    );
    expect(result).toEqual([]);
  });

  test("drops a translation mirror (*.id.md)", () => {
    const result = inScopeCandidates(["docs/x.id.md"], new Set(["md"]), []);
    expect(result).toEqual([]);
  });

  test("drops a path excluded by a supplied .graphifyignore prefix", () => {
    const result = inScopeCandidates(["packages/kontrak/x.ts"], extensions, ["packages/kontrak"]);
    expect(result).toEqual([]);
  });

  test("sorts the result", () => {
    const result = inScopeCandidates(["b.ts", "a.ts"], extensions, []);
    expect(result).toEqual(["a.ts", "b.ts"]);
  });
});

describe("diffManifestStaleness", () => {
  /** A `currentHash` stub driven by a plain path -> hash map; `null` means "unreadable". */
  function hasher(map) {
    return (filePath) => (filePath in map ? map[filePath] : null);
  }

  test("a file whose current hash matches ast_hash is neither changed nor removed", () => {
    const manifest = { "src/a.ts": { ast_hash: "hash-a" } };
    const diff = diffManifestStaleness(manifest, ["src/a.ts"], [], hasher({ "src/a.ts": "hash-a" }));
    expect(diff).toEqual({ changed: [], added: [], removed: [] });
  });

  test("a file whose current hash differs from ast_hash is changed", () => {
    const manifest = { "src/a.ts": { ast_hash: "hash-a" } };
    const diff = diffManifestStaleness(manifest, ["src/a.ts"], [], hasher({ "src/a.ts": "hash-a-edited" }));
    expect(diff.changed).toEqual(["src/a.ts"]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test("a manifest path no longer git-tracked is removed", () => {
    const manifest = { "src/a.ts": { ast_hash: "hash-a" }, "src/gone.ts": { ast_hash: "hash-gone" } };
    // "src/gone.ts" is absent from trackedPaths, so it is not a candidate.
    const diff = diffManifestStaleness(manifest, ["src/a.ts"], [], hasher({ "src/a.ts": "hash-a" }));
    expect(diff.removed).toEqual(["src/gone.ts"]);
  });

  test("a manifest path newly excluded by .graphifyignore is removed, not changed", () => {
    const manifest = { "packages/kontrak/x.ts": { ast_hash: "hash-x" } };
    const diff = diffManifestStaleness(
      manifest,
      ["packages/kontrak/x.ts"],
      ["packages/kontrak"],
      hasher({ "packages/kontrak/x.ts": "hash-x" })
    );
    expect(diff.removed).toEqual(["packages/kontrak/x.ts"]);
    expect(diff.changed).toEqual([]);
  });

  test("a candidate not in the manifest at all is added", () => {
    const manifest = { "src/a.ts": { ast_hash: "hash-a" } };
    const diff = diffManifestStaleness(
      manifest,
      ["src/a.ts", "src/new.ts"],
      [],
      hasher({ "src/a.ts": "hash-a", "src/new.ts": "hash-new" })
    );
    expect(diff.added).toEqual(["src/new.ts"]);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test("an unreadable candidate (currentHash returns null) counts as changed, not removed", () => {
    const manifest = { "src/a.ts": { ast_hash: "hash-a" } };
    const diff = diffManifestStaleness(manifest, ["src/a.ts"], [], hasher({}));
    expect(diff.changed).toEqual(["src/a.ts"]);
    expect(diff.removed).toEqual([]);
  });

  test("changed, added, and removed can all be non-empty in the same diff", () => {
    const manifest = {
      "src/a.ts": { ast_hash: "hash-a" }, // changed
      "src/gone.ts": { ast_hash: "hash-gone" } // removed (untracked now)
    };
    const diff = diffManifestStaleness(
      manifest,
      ["src/a.ts", "src/new.ts"], // src/new.ts: added
      [],
      hasher({ "src/a.ts": "hash-a-edited", "src/new.ts": "hash-new" })
    );
    expect(diff).toEqual({ changed: ["src/a.ts"], added: ["src/new.ts"], removed: ["src/gone.ts"] });
  });

  test("only extensions already present in the manifest are candidates for 'added'", () => {
    // manifest only ever saw .ts, so a tracked .astro file is never counted
    // as "added" — see manifestExtensions' own docblock for why this is a
    // deliberate under-approximation rather than a bug.
    const manifest = { "src/a.ts": { ast_hash: "hash-a" } };
    const diff = diffManifestStaleness(
      manifest,
      ["src/a.ts", "src/new.astro"],
      [],
      hasher({ "src/a.ts": "hash-a" })
    );
    expect(diff.added).toEqual([]);
  });
});

describe("checkStaleness", () => {
  const emptyDiff = { changed: [], added: [], removed: [] };

  test("a total under the bound is green", () => {
    const diff = { changed: Array(10).fill("f"), added: [], removed: [] };
    expect(checkStaleness(diff, 40)).toEqual([]);
  });

  test("a total exactly at the bound is still green (not >=)", () => {
    const diff = { changed: Array(40).fill("f"), added: [], removed: [] };
    expect(checkStaleness(diff, 40)).toEqual([]);
  });

  test("a total one over the bound is a violation", () => {
    const diff = { changed: Array(41).fill("f"), added: [], removed: [] };
    const violations = checkStaleness(diff, 40);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("staleness");
    expect(violations[0].file).toBe("graphify-out/manifest.json");
    expect(violations[0].message).toContain("41 file(s)");
    expect(violations[0].message).toContain("bound is 40");
    expect(violations[0].message).toContain("knowledge:graph:update");
  });

  test("the violation message breaks the total down by changed/added/removed", () => {
    const diff = { changed: ["a", "b"], added: ["c"], removed: ["d", "e"] };
    const violations = checkStaleness(diff, 3);
    expect(violations[0].message).toContain("2 changed, 1 added, 2 removed");
  });

  test("an empty diff never violates any non-negative bound", () => {
    expect(checkStaleness(emptyDiff, 0)).toEqual([]);
  });
});
