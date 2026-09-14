/**
 * Unit tests for `packages/gerbang/lib/graph-combine.mjs` — proving each
 * fail-closed case issue #11 requires (missing, malformed, or
 * schema-incompatible component graph) with literal fixtures, no real
 * `graphify` binary involved. See that module's own docblock for the real
 * toolchain behaviour these checks are built to cover.
 */
import { describe, expect, test } from "bun:test";
import {
  checkMergedResult,
  checkMergeInputsCompatible,
  validateGraphFile
} from "../packages/gerbang/lib/graph-combine.mjs";

describe("validateGraphFile — fails closed", () => {
  test("a missing file (null content) is invalid", () => {
    const result = validateGraphFile("root graph.json", null);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not exist");
  });

  test("malformed JSON is invalid", () => {
    const result = validateGraphFile("root graph.json", "{not valid json");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not valid JSON");
  });

  test("valid JSON that is not an object is invalid", () => {
    const result = validateGraphFile("root graph.json", "[1, 2, 3]");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a JSON object");
  });

  test("an object with no nodes array is invalid", () => {
    const result = validateGraphFile("root graph.json", '{"foo": "bar"}');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no `nodes` array");
  });

  test("an empty nodes array is invalid — the case graphify itself does not catch", () => {
    const result = validateGraphFile("apps/cms graph.json", '{"nodes": [], "links": []}');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("empty");
  });

  test("a well-formed, non-empty graph is valid", () => {
    const result = validateGraphFile("root graph.json", '{"nodes": [{"id": "n1"}], "links": [], "directed": false}');
    expect(result.ok).toBe(true);
    expect(result.graph.nodes.length).toBe(1);
  });
});

describe("checkMergeInputsCompatible", () => {
  test("a directed/undirected mismatch is incompatible", () => {
    const reasons = checkMergeInputsCompatible({ directed: true, nodes: [{}] }, { directed: false, nodes: [{}] });
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons[0]).toContain("directed flag mismatch");
  });

  test("matching directed flags are compatible", () => {
    const reasons = checkMergeInputsCompatible({ directed: false, nodes: [{}] }, { directed: false, nodes: [{}] });
    expect(reasons).toEqual([]);
  });
});

describe("checkMergedResult — a merge must never shrink or over-grow", () => {
  const root = { nodes: new Array(297).fill({}) };
  const cms = { nodes: new Array(12700).fill({}) };

  test("a merge that produced fewer nodes than the larger input is rejected", () => {
    const merged = { nodes: new Array(100).fill({}) };
    const reasons = checkMergedResult(root, cms, merged);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons[0]).toContain("fewer than the larger input");
  });

  test("a merge that produced more nodes than root + apps/cms combined is rejected", () => {
    const merged = { nodes: new Array(20000).fill({}) };
    const reasons = checkMergedResult(root, cms, merged);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons[0]).toContain("more than root");
  });

  test("the real, verified merge shape (297 + 12700 = 12997, no dedup) passes", () => {
    const merged = { nodes: new Array(12997).fill({}) };
    expect(checkMergedResult(root, cms, merged)).toEqual([]);
  });
});
