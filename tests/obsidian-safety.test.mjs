/**
 * Unit tests for `packages/gerbang/lib/obsidian-safety.mjs` — every rejection
 * case issue #11 requires (path traversal, symlink escape, unexpected
 * extension, output outside staging, curated-filename collision), each
 * proven with a literal fixture and no real staging tree, symlink, or
 * `graphify` involved.
 */
import { describe, expect, test } from "bun:test";
import {
  checkCuratedCollision,
  classifyEntry,
  resolveWithin
} from "../packages/gerbang/lib/obsidian-safety.mjs";

describe("classifyEntry", () => {
  test("a symlink is rejected — escape vector", () => {
    const verdict = classifyEntry("thing.md", true);
    expect(verdict.action).toBe("reject");
    expect(verdict.reason).toContain("symlink");
  });

  test("an unexpected extension is rejected", () => {
    const verdict = classifyEntry("payload.sh", false);
    expect(verdict.action).toBe("reject");
    expect(verdict.reason).toContain("unexpected extension");
  });

  test("a file with no extension at all is rejected", () => {
    const verdict = classifyEntry("Makefile", false);
    expect(verdict.action).toBe("reject");
  });

  test("graphify's own housekeeping manifest is skipped, not synced, not fatal", () => {
    const verdict = classifyEntry(".graphify_obsidian_manifest.json", false);
    expect(verdict.action).toBe("skip");
  });

  test("anything under a .obsidian/ segment is skipped, not synced, not fatal", () => {
    const verdict = classifyEntry(".obsidian/graph.json", false);
    expect(verdict.action).toBe("skip");
    expect(verdict.reason).toContain("workspace/session state");
  });

  test("a .md note is allowlisted for sync", () => {
    expect(classifyEntry("thing().md", false).action).toBe("sync");
  });

  test("a .canvas file is allowlisted for sync", () => {
    expect(classifyEntry("graph.canvas", false).action).toBe("sync");
  });

  test("extension matching is case-insensitive", () => {
    expect(classifyEntry("THING.MD", false).action).toBe("sync");
  });
});

describe("resolveWithin — path traversal / output-outside-staging guard", () => {
  const root = "/repo/graphify-out/obsidian-staging";

  test("an ordinary relative entry resolves inside root", () => {
    const result = resolveWithin(root, "thing.md");
    expect(result.ok).toBe(true);
    expect(result.absolute).toBe("/repo/graphify-out/obsidian-staging/thing.md");
  });

  test("a traversal segment that escapes root is rejected", () => {
    const result = resolveWithin(root, "../../etc/passwd");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("path traversal");
  });

  test("a traversal that lands exactly on root itself is rejected", () => {
    // relative() would return "" here — not a FILE inside staging, so not a
    // valid entry to sync either.
    const result = resolveWithin(root, ".");
    expect(result.ok).toBe(false);
  });

  test("an absolute path outside root is rejected", () => {
    const result = resolveWithin(root, "/etc/passwd");
    expect(result.ok).toBe(false);
  });

  test("a nested, legitimate relative path stays inside root", () => {
    const result = resolveWithin(root, "sub/dir/note.md");
    expect(result.ok).toBe(true);
  });
});

describe("checkCuratedCollision", () => {
  test("a generated filename matching a curated one is rejected", () => {
    const curated = new Set(["ownership-boundaries.md", "monorepo-map.md"]);
    const result = checkCuratedCollision("ownership-boundaries.md", curated);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("collides");
  });

  test("a generated filename with no curated collision is accepted", () => {
    const curated = new Set(["ownership-boundaries.md"]);
    const result = checkCuratedCollision("gitRun().md", curated);
    expect(result.ok).toBe(true);
  });

  test("an empty curated set never collides", () => {
    expect(checkCuratedCollision("anything.md", new Set()).ok).toBe(true);
  });
});
