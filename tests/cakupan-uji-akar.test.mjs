/**
 * Root `bun test` coverage gate: the `apps/cms` exclusion must live where it
 * cannot be stepped around.
 *
 * ## The defect is real, not hypothetical
 *
 * `apps/cms` is `ahliweb/awcms`, embedded via `git subtree`. Its suite is
 * roughly 500 files and needs a live PostgreSQL; it is meant to run under
 * its own gate (`bun run check:cms`), never under the root suite.
 *
 * That exclusion could be written as a flag inside the `test` script:
 *
 *     "test": "bun test --path-ignore-patterns='apps/cms/**'"
 *
 * That would be green on a contributor's machine and RED under local CI,
 * because `tools/ci/runners/check.ts`'s `toko` leg calls `bun test` BARE,
 * not `bun run test` — the flag would be silently skipped, the whole CMS
 * suite would be collected against a database that leg never provisions,
 * and every one of those tests would fail. Two commands that look alike
 * would give two different answers, and the green one is the one typed
 * more often on a workstation.
 *
 * ## What this gate guards
 *
 * `bunfig.toml` is read by `bun test` however it is invoked. Two assertions:
 *
 *   1. `bunfig.toml` declares the exclusion.
 *   2. No script in `package.json` repeats it as a flag — two sources of
 *      truth for one rule are two sources that have to be kept in step, and
 *      one of them will eventually drift.
 *
 * What this gate does NOT see, stated so it is not mistaken for guarded: it
 * checks the DECLARATION, not the result. It does not run `bun test` itself
 * and does not count how many files actually get collected — that proof is
 * external, in each verification run's own reported file count.
 */
import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const PATTERN = "apps/cms";

describe("root bun test coverage", () => {
  test("bunfig.toml exists — a script-level flag alone is missed by a bare `bun test`", () => {
    assert.ok(
      existsSync(`${ROOT}bunfig.toml`),
      "bunfig.toml does not exist. Without it, a bare `bun test` collects " +
        "apps/cms and CI goes red while `bun run test` stays green."
    );
  });

  test(`bunfig.toml excludes ${PATTERN}`, () => {
    const content = readFileSync(`${ROOT}bunfig.toml`, "utf8");

    assert.match(content, /\[test\]/, "bunfig.toml has no [test] block.");
    assert.ok(content.includes("pathIgnorePatterns"), "bunfig.toml does not set pathIgnorePatterns.");
    assert.ok(
      content.includes(PATTERN),
      `pathIgnorePatterns does not mention ${PATTERN}. Its suite needs a live PostgreSQL; its own gate is check:cms.`
    );
  });

  test("no package.json script repeats the exclusion as a flag", () => {
    const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8"));

    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      assert.ok(
        !script.includes("--path-ignore-patterns"),
        `script "${name}" repeats --path-ignore-patterns. The rule already ` +
          "lives in bunfig.toml, which applies to every invocation style. A " +
          "second copy here is a second source of truth that will drift."
      );
    }
  });
});
