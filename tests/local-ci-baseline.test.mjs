/**
 * Security-baseline matching (`tools/ci/lib/baseline.ts`) and the one-time
 * adoption baseline (`tools/ci/lib/sast-baseline.ts`, ADR-0060 D4) — the
 * `security` leg fails on any OpenGrep ERROR finding unless it matches
 * `tools/ci/security-baseline.json` by ruleId + path exactly, and fails while
 * the adoption baseline has not been generated.
 *
 * The baseline may only shrink. BASELINE_CEILING below is the size the
 * adoption baseline was generated with; it is 0 while
 * `tools/ci/sast/ADOPTION-BASELINE-PENDING` exists (the baseline is then `[]`).
 * The CI-server run of `bun tools/ci/cli/sast-baseline.ts` prints the count it
 * wrote, and the commit that brings that baseline sets this ceiling to it.
 * Raising it later needs a recorded decision, never a quiet edit.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isBaselined, parseBaseline, partitionBlockingFindings } from "../tools/ci/lib/baseline.ts";
import {
  ADOPTION_MARKER_PATH,
  adoptionBaselinePending,
  buildAdoptionBaseline,
  generatorRefusal,
  withTempDir
} from "../tools/ci/lib/sast-baseline.ts";

const BASELINE_CEILING = 0;

describe("tools/ci/lib/baseline.ts", () => {
  test("the baseline never grows past its recorded ceiling and has no duplicate entry", () => {
    const entries = parseBaseline(readFileSync("tools/ci/security-baseline.json", "utf8"));
    assert.ok(entries.length <= BASELINE_CEILING, `${entries.length} entries > ceiling ${BASELINE_CEILING}`);
    const keys = entries.map((e) => `${e.ruleId} @ ${e.path}`);
    assert.equal(new Set(keys).size, keys.length);
  });

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
    assert.throws(() => parseBaseline(JSON.stringify([{ ruleId: "js/x", path: "a.ts", reason: "  " }])), /reason/);
  });

  test("parseBaseline rejects a non-array top level", () => {
    assert.throws(() => parseBaseline(JSON.stringify({})), /array/);
  });

  test("isBaselined matches by ruleId + path exactly, not by either alone", () => {
    const baseline = parseBaseline(JSON.stringify([{ ruleId: "js/sql-injection", path: "a.ts", reason: "false positive: parameterised" }]));
    assert.equal(isBaselined({ ruleId: "js/sql-injection", path: "a.ts", severity: "ERROR", message: "" }, baseline), true);
    assert.equal(isBaselined({ ruleId: "js/sql-injection", path: "b.ts", severity: "ERROR", message: "" }, baseline), false);
    assert.equal(isBaselined({ ruleId: "js/other", path: "a.ts", severity: "ERROR", message: "" }, baseline), false);
  });

  test("partitionBlockingFindings never blocks on WARNING or INFO", () => {
    const { blocking, baselined, advisory } = partitionBlockingFindings(
      [
        { ruleId: "js/x", path: "a.ts", severity: "WARNING", message: "" },
        { ruleId: "js/y", path: "a.ts", severity: "INFO", message: "" }
      ],
      []
    );
    assert.deepEqual(blocking, []);
    assert.deepEqual(baselined, []);
    assert.equal(advisory.length, 2);
  });

  test("partitionBlockingFindings blocks an un-baselined ERROR finding", () => {
    const finding = { ruleId: "js/x", path: "a.ts", severity: "ERROR", message: "bad" };
    const { blocking, baselined } = partitionBlockingFindings([finding], []);
    assert.deepEqual(blocking, [finding]);
    assert.deepEqual(baselined, []);
  });

  test("partitionBlockingFindings excuses a baselined ERROR finding", () => {
    const finding = { ruleId: "js/x", path: "a.ts", severity: "ERROR", message: "bad" };
    const baseline = parseBaseline(JSON.stringify([{ ruleId: "js/x", path: "a.ts", reason: "triaged, accepted" }]));
    const { blocking, baselined } = partitionBlockingFindings([finding], baseline);
    assert.deepEqual(blocking, []);
    assert.deepEqual(baselined, [finding]);
  });

  test("removing an entry from the baseline turns its finding into a blocking one (the gate bites)", () => {
    const finding = { ruleId: "js/x", path: "a.ts", severity: "ERROR", message: "bad" };
    const full = parseBaseline(JSON.stringify([{ ruleId: "js/x", path: "a.ts", reason: "triaged, accepted" }]));
    assert.equal(partitionBlockingFindings([finding], full).blocking.length, 0);
    assert.equal(partitionBlockingFindings([finding], full.slice(1)).blocking.length, 1);
  });
});

describe("tools/ci/lib/sast-baseline.ts (adoption baseline)", () => {
  test("the committed state is consistent: the pending marker and an empty baseline go together", () => {
    const entries = parseBaseline(readFileSync("tools/ci/security-baseline.json", "utf8"));
    if (adoptionBaselinePending(".")) {
      assert.deepEqual(entries, [], `${ADOPTION_MARKER_PATH} exists, so the baseline must still be []`);
      assert.equal(BASELINE_CEILING, 0, "the ceiling is set together with the generated baseline, not before");
    } else {
      assert.ok(BASELINE_CEILING >= entries.length);
    }
  });

  test("the generator refuses unless the marker exists and the baseline is empty (it never adds)", () => {
    assert.equal(generatorRefusal(true, []), undefined);
    assert.match(generatorRefusal(false, []), /already generated/);
    assert.match(generatorRefusal(true, [{ ruleId: "r", path: "p", reason: "x" }]), /already holds 1 entry/);
  });

  test("buildAdoptionBaseline keeps ERROR findings only, one entry per (ruleId, path), sorted, each with a reason", () => {
    const entries = buildAdoptionBaseline(
      [
        { ruleId: "javascript.b", path: "z.ts", severity: "ERROR", message: "", line: 9 },
        { ruleId: "javascript.a", path: "a.ts", severity: "ERROR", message: "", line: 12 },
        { ruleId: "javascript.a", path: "a.ts", severity: "ERROR", message: "", line: 3 },
        { ruleId: "javascript.w", path: "a.ts", severity: "WARNING", message: "" },
        { ruleId: "javascript.i", path: "b.ts", severity: "INFO", message: "" }
      ],
      "2026-11-28"
    );
    assert.deepEqual(
      entries.map((e) => `${e.path} ${e.ruleId}`),
      ["a.ts javascript.a", "z.ts javascript.b"]
    );
    assert.match(entries[0].reason, /^pre-existing finding at adoption 2026-11-28 \(lines 3, 12\); not yet triaged/);
    assert.match(entries[1].reason, /\(line 9\)/);
    // The output is a valid baseline the gate then accepts.
    const baseline = parseBaseline(JSON.stringify(entries));
    assert.equal(
      partitionBlockingFindings([{ ruleId: "javascript.a", path: "a.ts", severity: "ERROR", message: "" }], baseline).blocking.length,
      0
    );
  });

  test("withTempDir removes its directory after success and after a throw", async () => {
    let seen;
    const value = await withTempDir("local-ci-baseline-test-", async (dir) => {
      seen = dir;
      assert.equal(existsSync(dir), true);
      return 42;
    });
    assert.equal(value, 42);
    assert.equal(existsSync(seen), false);

    let thrownIn;
    await assert.rejects(
      withTempDir("local-ci-baseline-test-", async (dir) => {
        thrownIn = dir;
        throw new Error("boom");
      }),
      /boom/
    );
    assert.equal(existsSync(thrownIn), false);
  });

  test("the pending marker explains how the baseline is generated", () => {
    if (!adoptionBaselinePending(".")) return;
    const text = readFileSync(ADOPTION_MARKER_PATH, "utf8");
    assert.match(text, /bun tools\/ci\/cli\/sast-baseline\.ts/);
    assert.match(text, /BASELINE_CEILING/);
    assert.ok(readdirSync(join("tools", "ci", "sast")).includes("ADOPTION-BASELINE-PENDING"));
  });
});
