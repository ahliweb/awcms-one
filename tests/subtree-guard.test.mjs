/**
 * Unit tests for `packages/gerbang/lib/subtree-guard.mjs` — the write-path
 * guard every knowledge-graph TOOL routes through before touching disk.
 * Pure path arithmetic, so every case below is a literal string, no
 * filesystem or fixture tree involved.
 */
import { describe, expect, test } from "bun:test";
import { assertNotUnderSubtree, isUnderSubtree } from "../packages/gerbang/lib/subtree-guard.mjs";

const ROOT = "/repo";

describe("isUnderSubtree", () => {
  test("a path directly under apps/cms/ is under the subtree", () => {
    expect(isUnderSubtree("apps/cms/graphify-out/graph.json", ROOT)).toBe(true);
  });

  test("apps/cms itself (no trailing path) is under the subtree", () => {
    expect(isUnderSubtree("apps/cms", ROOT)).toBe(true);
  });

  test("a path that merely starts with the same characters is NOT under the subtree", () => {
    // apps/cms-backup is a sibling, not a descendant — string-prefix matching
    // would get this wrong; path-relative matching does not.
    expect(isUnderSubtree("apps/cms-backup/x.json", ROOT)).toBe(false);
  });

  test("a root-owned graphify-out path is not under the subtree", () => {
    expect(isUnderSubtree("graphify-out/combined/graph.json", ROOT)).toBe(false);
  });

  test("a knowledge/ path is not under the subtree", () => {
    expect(isUnderSubtree("knowledge/generated/graphify/note.md", ROOT)).toBe(false);
  });

  test("a traversal that resolves back into apps/cms is caught", () => {
    expect(isUnderSubtree("packages/../apps/cms/x.json", ROOT)).toBe(true);
  });

  test("an absolute path under the subtree is caught even when root differs", () => {
    expect(isUnderSubtree("/repo/apps/cms/y.json", ROOT)).toBe(true);
  });
});

describe("assertNotUnderSubtree", () => {
  test("throws for a subtree path, naming it and the reason", () => {
    expect(() => assertNotUnderSubtree("apps/cms/graphify-out/combined.json", ROOT, "write")).toThrow(
      /apps\/cms.*git subtree/s
    );
  });

  test("returns the path unchanged for a safe write", () => {
    const path = "graphify-out/combined/graph.json";
    expect(assertNotUnderSubtree(path, ROOT, "write")).toBe(path);
  });
});
