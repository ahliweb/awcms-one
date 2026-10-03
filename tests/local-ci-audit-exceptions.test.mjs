/**
 * `tools/ci/lib/audit-exceptions.ts` — the advisories `local-ci/check-toko`'s
 * `bun audit` step ignores. Every entry must be a real, reasoned, dated
 * decision, and an expired one fails the leg rather than silently lingering.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditIgnoreArgs, loadAuditIgnoreArgs, parseAuditExceptions } from "../tools/ci/lib/audit-exceptions.ts";

const valid = {
  advisory: "GHSA-ch52-4w7c-c8xp",
  packageName: "example",
  reason: "Only reachable from build-time tooling run by one operator, never at request time.",
  owner: "maintainers",
  reviewDate: "2026-11-03"
};

describe("tools/ci/lib/audit-exceptions.ts", () => {
  test("the release tool runs bun audit through the same exception list, spawning nothing itself", () => {
    const source = readFileSync("tools/rilis.mjs", "utf8");
    assert.match(source, /runBunAuditWithExceptions\("\."\)/);
    assert.doesNotMatch(source, /execSync\("bun audit/);
  });

  test("the committed dependency-audit-exceptions.json parses", () => {
    const entries = parseAuditExceptions(readFileSync("tools/ci/dependency-audit-exceptions.json", "utf8"));
    assert.ok(Array.isArray(entries));
  });

  test("rejects a non-array, a non-GHSA id, a thin reason, and a malformed date", () => {
    assert.throws(() => parseAuditExceptions("{}"));
    assert.throws(() => parseAuditExceptions(JSON.stringify([{ ...valid, advisory: "CVE-2026-1" }])));
    assert.throws(() => parseAuditExceptions(JSON.stringify([{ ...valid, advisory: "GHSA-aaaa-bbbb-cccc" }])));
    assert.throws(() => parseAuditExceptions(JSON.stringify([{ ...valid, reason: "low risk" }])));
    assert.throws(() => parseAuditExceptions(JSON.stringify([{ ...valid, reviewDate: "soon" }])));
    assert.throws(() => parseAuditExceptions(JSON.stringify([{ ...valid, owner: " " }])));
  });

  test("builds one --ignore per entry while every reviewDate is today or later", () => {
    const result = auditIgnoreArgs([valid], "2026-11-03");
    assert.deepEqual(result, { ok: true, args: ["--ignore=GHSA-ch52-4w7c-c8xp"] });
  });

  test("fails, naming the entry, once a reviewDate has passed", () => {
    const result = auditIgnoreArgs([valid], "2026-11-04");
    assert.equal(result.ok, false);
    assert.deepEqual(result.expired.map((e) => e.advisory), ["GHSA-ch52-4w7c-c8xp"]);
  });

  test("an empty list ignores nothing", () => {
    assert.deepEqual(auditIgnoreArgs([], "2026-10-03"), { ok: true, args: [] });
  });

  test("a worktree without the exceptions file ignores nothing; a malformed one throws", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-exceptions-"));
    try {
      assert.deepEqual(loadAuditIgnoreArgs(root, "2026-10-03"), { ok: true, args: [] });
      mkdirSync(join(root, "tools", "ci"), { recursive: true });
      writeFileSync(join(root, "tools", "ci", "dependency-audit-exceptions.json"), "{}");
      assert.throws(() => loadAuditIgnoreArgs(root, "2026-10-03"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("both local-ci legs that run bun audit apply the same exceptions", () => {
    for (const runner of ["tools/ci/runners/check.ts", "tools/ci/runners/security.ts"]) {
      const source = readFileSync(runner, "utf8");
      assert.match(source, /loadAuditIgnoreArgs\(worktreeRoot\)/, `${runner} must load the exceptions`);
      assert.match(source, /"bun",\s*"audit",\s*"--audit-level=low",\s*\.\.\.ignore\.args/, `${runner} must pass them`);
    }
  });
});
