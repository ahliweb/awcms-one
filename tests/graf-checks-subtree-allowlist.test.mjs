/**
 * Unit tests for the subtree path allow-list behind `audit:graf` (issue #534):
 * `SUBTREE_ALLOWLIST` (single-sourced, default empty) and the three checks that
 * share it — the `.graphifyignore` consistency check, the "no subtree node"
 * check and the staleness candidates — plus the allow-list's own validation.
 *
 * The `.graphifyignore` cases read this repository's REAL file, so a change to
 * it that breaks the default-deny contract is caught here and not only by a
 * hand-written copy in a fixture.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  SUBTREE_ALLOWLIST,
  checkGraphifyIgnoreExcludesSubtree,
  checkNoSubtreeNodes,
  checkSubtreeAllowlist,
  inScopeCandidates,
  isSubtreeAllowlisted,
  parseGraphifyIgnore
} from "../packages/gerbang/lib/graf-checks.mjs";

const OWN = [{ prefix: "apps/cms/src/modules/mine/", reason: "the product's own module" }];

const node = (source_file) => ({ id: source_file, community: 0, community_name: "x", source_file });

describe("SUBTREE_ALLOWLIST default", () => {
  test("is empty in the template and valid", () => {
    expect(SUBTREE_ALLOWLIST).toEqual([]);
    expect(checkSubtreeAllowlist(SUBTREE_ALLOWLIST)).toEqual([]);
  });
});

describe("checkSubtreeAllowlist", () => {
  test("accepts a reasoned prefix under apps/cms/", () => {
    expect(checkSubtreeAllowlist(OWN)).toEqual([]);
  });

  test.each([
    [{ prefix: "apps/cms", reason: "r" }, "under apps/cms/"],
    [{ prefix: "apps/storefront/src", reason: "r" }, "under apps/cms/"],
    [{ prefix: "apps/cms/../x", reason: "r" }, "under apps/cms/"],
    [{ prefix: "apps/cms/graphify-out", reason: "r" }, "subtree's own graph"],
    [{ prefix: "apps/cms/src/x", reason: " " }, "no reason"]
  ])("refuses %j", (entry, fragment) => {
    const violations = checkSubtreeAllowlist([entry]);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain(fragment);
  });
});

describe("checkNoSubtreeNodes with an allow-list", () => {
  test("empty list: any apps/cms node fails (unchanged)", () => {
    expect(checkNoSubtreeNodes({ nodes: [node("apps/cms/src/modules/mine/a.ts")] }, [])).toHaveLength(1);
  });

  test("a node under the allow-listed prefix passes", () => {
    expect(checkNoSubtreeNodes({ nodes: [node("apps/cms/src/modules/mine/a.ts")] }, OWN)).toEqual([]);
  });

  test("a node elsewhere under apps/cms/ fails and names only that file", () => {
    const violations = checkNoSubtreeNodes(
      { nodes: [node("apps/cms/src/modules/mine/a.ts"), node("apps/cms/src/modules/other/b.ts")] },
      OWN
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("1 node(s) from 1 file(s)");
    expect(violations[0].message).toContain("other/b.ts");
  });

  test("a sibling that merely shares the prefix text is not allow-listed", () => {
    expect(isSubtreeAllowlisted("apps/cms/src/modules/mine-other/a.ts", OWN)).toBe(false);
  });
});

describe("checkGraphifyIgnoreExcludesSubtree against the real .graphifyignore", () => {
  const real = parseGraphifyIgnore(readFileSync(".graphifyignore", "utf8"));

  test("passes with the default empty allow-list", () => {
    expect(checkGraphifyIgnoreExcludesSubtree(real, SUBTREE_ALLOWLIST)).toEqual([]);
  });

  test("fails for an allow-listed prefix the file does not re-include", () => {
    const violations = checkGraphifyIgnoreExcludesSubtree(real, OWN);
    const text = violations.map((v) => v.message).join("\n");
    expect(violations.length).toBeGreaterThan(0);
    expect(text).toContain("excludes apps/cms/ wholesale");
    expect(text).toContain("does not default-deny `apps/cms/*`");
    expect(text).toContain("does not re-include `apps/cms/src/modules/mine/`");
  });
});

describe("checkGraphifyIgnoreExcludesSubtree with an allow-list", () => {
  const good = parseGraphifyIgnore(
    [
      "apps/cms/*",
      "!apps/cms/src/",
      "!apps/cms/src/modules/",
      "!apps/cms/src/modules/mine/"
    ].join("\n")
  );

  test("default-deny plus re-includes for the prefix and its parents passes", () => {
    expect(checkGraphifyIgnoreExcludesSubtree(good, OWN)).toEqual([]);
  });

  test("a missing parent re-include fails", () => {
    const ignore = parseGraphifyIgnore(["apps/cms/*", "!apps/cms/src/modules/mine/"].join("\n"));
    const text = checkGraphifyIgnoreExcludesSubtree(ignore, OWN)
      .map((v) => v.message)
      .join("\n");
    expect(text).toContain("does not re-include `apps/cms/src/`");
    expect(text).toContain("does not re-include `apps/cms/src/modules/`");
  });
});

describe("inScopeCandidates with an allow-list", () => {
  const tracked = ["apps/cms/src/modules/mine/a.ts", "apps/cms/src/modules/other/b.ts", "src/c.ts"];
  const ext = new Set(["ts"]);

  test("empty list: nothing under apps/cms/ is a candidate (unchanged)", () => {
    expect(inScopeCandidates(tracked, ext, [], [])).toEqual(["src/c.ts"]);
  });

  test("allow-listed paths become candidates, others stay out", () => {
    expect(inScopeCandidates(tracked, ext, [], OWN)).toEqual(["apps/cms/src/modules/mine/a.ts", "src/c.ts"]);
  });
});
