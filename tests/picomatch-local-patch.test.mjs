/**
 * Guards the local picomatch patch for GHSA-fc5q-39xc-vjpf (ReDoS through
 * repeated extglobs; no patched release exists). `bun audit` matches by
 * version and still reports 4.0.7 / 2.3.2, so the advisory is ignored in
 * `tools/ci/dependency-audit-exceptions.json` ON THE CONDITION that the patch
 * is really applied. If a dependency bump drops it, these tests go red instead
 * of the proof-of-concept patterns hanging a build again.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { parseAuditExceptions } from "../tools/ci/lib/audit-exceptions.ts";

const ADVISORY = "GHSA-fc5q-39xc-vjpf";
const POC_PATTERNS = ["+(*)", "+(*a)", "*(*)", "*(*a)", "+(*)a", "+(*a|*b)"];
const INPUT = `${"a".repeat(40)}!`;
const VERSIONS = ["4.0.7", "2.3.2"];

/** The isolated-linker store path of one resolved picomatch version. */
function storeCopy(version) {
  return join("node_modules", ".bun", `picomatch@${version}`, "node_modules", "picomatch");
}

describe(`local picomatch patch (${ADVISORY})`, () => {
  test("package.json declares a patch for every picomatch version in bun.lock", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    assert.deepEqual(Object.keys(pkg.patchedDependencies ?? {}).filter((k) => k.startsWith("picomatch@")).sort(), [
      "picomatch@2.3.2",
      "picomatch@4.0.7"
    ]);
    const lock = readFileSync("bun.lock", "utf8");
    const resolved = [...lock.matchAll(/"picomatch@([0-9.]+)"/g)].map((m) => m[1]);
    for (const version of new Set(resolved)) {
      assert.ok(VERSIONS.includes(version), `picomatch@${version} is in bun.lock but has no local patch`);
    }
    for (const version of VERSIONS) {
      const file = pkg.patchedDependencies[`picomatch@${version}`];
      assert.ok(existsSync(file), `${file} is missing`);
      assert.match(readFileSync(file, "utf8"), /opts\.noextglob = true;/);
    }
  });

  test("the exception names the patch, an owner and a review date", () => {
    const entries = parseAuditExceptions(readFileSync("tools/ci/dependency-audit-exceptions.json", "utf8"));
    const entry = entries.find((e) => e.advisory === ADVISORY);
    assert.ok(entry, `${ADVISORY} exception is missing`);
    assert.equal(entry.packageName, "picomatch");
    assert.match(entry.reason, /patches\/picomatch@4\.0\.7\.patch/);
    assert.equal(entry.owner, "unggul (owner decision via dialog, 2026-11-18)");
    assert.equal(entry.reviewDate, "2026-12-18");
  });

  for (const version of VERSIONS) {
    const dir = storeCopy(version);
    const installed = existsSync(dir);

    test(`picomatch@${version}: proof-of-concept patterns finish quickly`, { skip: !installed }, () => {
      const pm = createRequire(join(process.cwd(), "x.cjs"))(join(process.cwd(), dir));
      for (const pattern of POC_PATTERNS) {
        const started = performance.now();
        pm(pattern)(INPUT);
        assert.ok(performance.now() - started < 250, `${pattern} took too long: the patch is not applied`);
      }
    });

    test(`picomatch@${version}: ordinary globs still match`, { skip: !installed }, () => {
      const pm = createRequire(join(process.cwd(), "x.cjs"))(join(process.cwd(), dir));
      assert.equal(pm("**/*.ts")("src/a.ts"), true);
      assert.equal(pm("{a,b}/*.md")("a/x.md"), true);
      assert.equal(pm("!**/node_modules/**")("x/node_modules/y"), false);
    });
  }

  test("the patched store copies exist after bun install", () => {
    assert.ok(readdirSync(join("node_modules", ".bun")).some((d) => d.startsWith("picomatch@")), "no picomatch in node_modules/.bun");
  });
});
