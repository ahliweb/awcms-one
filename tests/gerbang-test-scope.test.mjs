/**
 * Regression test for issue #147's second finding: `bun test`'s positional
 * argument is a PATH **FILTER** (a substring match against every test
 * file's path), not a directory restriction. `tools/template-init/gates.mjs`
 * used to invoke `bun test tests` for `testScope: "root"`, believing that
 * scoped the run to the repository's own root `tests/` directory — it did
 * not, because a nested file such as `apps/storefront/tests/x.test.ts` also
 * contains the substring `tests` and matched too. That option's whole
 * purpose (stop a nested `template:init` run from re-executing the WHOLE
 * workspace suite, including every storefront build-smoke test and its own
 * stub-CMS `astro build`, inside a caller's own tight test budget) silently
 * never worked; see `gates.mjs`'s own docblock on `runFollowUpGates` for
 * the full account, and `docs/template.md`/`docs/alur-kerja-pengembangan.md`
 * for where this is documented for a human reader.
 *
 * This test proves the FIX directly against `bun` itself, in a
 * purpose-built temp directory with exactly the two-file shape that
 * exposed the bug — a root `tests/` test and a nested `apps/x/tests/`
 * test — rather than trusting a docblock. It spawns `bun` with the EXACT
 * argv `testScopeArgs("root")` exports (the same array `runFollowUpGates`
 * passes to `bun test`), so a future edit to that function that
 * reintroduces the bare `"tests"` filter fails this test, not just a
 * human review.
 *
 * Deterministic and needs no network: two trivial fixture test files, one
 * `bun test` invocation per scope, an assertion on how many files it
 * reports running. Skips loudly (never a silent false pass) when `bun`
 * cannot be spawned at all in this environment.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testScopeArgs } from "../tools/template-init/gates.mjs";

function canSpawnBun() {
  try {
    return Bun.spawnSync(["bun", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * A temp directory with a root `tests/root.test.mjs` and a nested
 * `apps/x/tests/nested.test.mjs` — the exact two-file shape that exposed
 * the bug (a root gate test, and a workspace member's own test directory
 * that also happens to be named `tests`).
 */
function makeFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "gerbang-test-scope-"));
  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, "apps", "x", "tests"), { recursive: true });
  const testFile = 'import { test, expect } from "bun:test";\ntest("passes", () => { expect(1).toBe(1); });\n';
  writeFileSync(join(dir, "tests", "root.test.mjs"), testFile);
  writeFileSync(join(dir, "apps", "x", "tests", "nested.test.mjs"), testFile);
  return dir;
}

/** Bun's own trailing summary line — `Ran <n> tests across <n> files.` — printed to stderr, not stdout. */
function filesRan(output) {
  const match = /Ran \d+ tests? across (\d+) files?\./.exec(output);
  if (!match) throw new Error(`could not find bun test's summary line in:\n${output}`);
  return Number(match[1]);
}

/** stdout and stderr concatenated — `bun test`'s own summary line is on stderr. */
function combinedOutput(result) {
  return `${result.stdout.toString()}\n${result.stderr.toString()}`;
}

describe("tools/template-init/gates.mjs's testScopeArgs — bun test scoping", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test('scope "root" (["test", "./tests/"]) runs only the root test file, not the nested one', () => {
    const dir = makeFixtureDir();
    try {
      const args = testScopeArgs("root");
      expect(args).toEqual(["test", "./tests/"]);

      const result = Bun.spawnSync(["bun", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      expect(filesRan(combinedOutput(result))).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the OLD, buggy invocation (["test", "tests"]) is a path FILTER — it runs BOTH files, proving why this had to change', () => {
    const dir = makeFixtureDir();
    try {
      const result = Bun.spawnSync(["bun", "test", "tests"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      expect(filesRan(combinedOutput(result))).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('scope "all" (["test"]) runs every test file, root and nested alike', () => {
    const dir = makeFixtureDir();
    try {
      const args = testScopeArgs("all");
      expect(args).toEqual(["test"]);

      const result = Bun.spawnSync(["bun", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      expect(filesRan(combinedOutput(result))).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
