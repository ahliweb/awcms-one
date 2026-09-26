/**
 * Security-baseline matching (`tools/ci/lib/baseline.ts`) — the `security`
 * leg fails on any CodeQL result with `security-severity >= 7.0` unless it
 * matches `tools/ci/security-baseline.json` by ruleId + path exactly.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isBaselined, parseBaseline, partitionHighSeverityFindings } from "../tools/ci/lib/baseline.ts";

describe("tools/ci/lib/baseline.ts", () => {
  test("the committed security-baseline.json parses, and every entry carries a non-empty reason", () => {
    const text = readFileSync("tools/ci/security-baseline.json", "utf8");
    const entries = parseBaseline(text);
    assert.ok(Array.isArray(entries));
    for (const entry of entries) {
      assert.ok(entry.reason.trim().length > 0, `${entry.ruleId} @ ${entry.path} has an empty reason`);
    }
  });

  test("parseBaseline rejects an entry without a reason", () => {
    assert.throws(() => parseBaseline(JSON.stringify([{ ruleId: "js/x", path: "a.ts" }])), /reason/);
  });

  test("parseBaseline rejects a non-array top level", () => {
    assert.throws(() => parseBaseline(JSON.stringify({})), /array/);
  });

  test("isBaselined matches by ruleId + path exactly, not by either alone", () => {
    const baseline = parseBaseline(JSON.stringify([{ ruleId: "js/sql-injection", path: "a.ts", reason: "false positive: parameterised" }]));
    assert.equal(isBaselined({ ruleId: "js/sql-injection", path: "a.ts", severity: 8, message: "" }, baseline), true);
    assert.equal(isBaselined({ ruleId: "js/sql-injection", path: "b.ts", severity: 8, message: "" }, baseline), false);
    assert.equal(isBaselined({ ruleId: "js/other", path: "a.ts", severity: 8, message: "" }, baseline), false);
  });

  test("partitionHighSeverityFindings ignores anything below the threshold", () => {
    const { blocking, baselined } = partitionHighSeverityFindings(
      [{ ruleId: "js/x", path: "a.ts", severity: 6.9, message: "" }],
      []
    );
    assert.deepEqual(blocking, []);
    assert.deepEqual(baselined, []);
  });

  test("partitionHighSeverityFindings blocks an un-baselined high-severity finding", () => {
    const finding = { ruleId: "js/x", path: "a.ts", severity: 9.1, message: "bad" };
    const { blocking, baselined } = partitionHighSeverityFindings([finding], []);
    assert.deepEqual(blocking, [finding]);
    assert.deepEqual(baselined, []);
  });

  test("partitionHighSeverityFindings excuses a baselined high-severity finding", () => {
    const finding = { ruleId: "js/x", path: "a.ts", severity: 9.1, message: "bad" };
    const baseline = parseBaseline(JSON.stringify([{ ruleId: "js/x", path: "a.ts", reason: "triaged, accepted" }]));
    const { blocking, baselined } = partitionHighSeverityFindings([finding], baseline);
    assert.deepEqual(blocking, []);
    assert.deepEqual(baselined, [finding]);
  });
});
