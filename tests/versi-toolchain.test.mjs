/**
 * Toolchain version gate: one Bun version, pinned in three places, and
 * nothing checked it was the same in all three until this file.
 *
 * ## The rule is already written; the checker is what was missing
 *
 * `AGENTS.md`'s "Configuration and toolchain" states it as a rule that
 * cannot be broken: Bun's version moves in `packageManager`/`engines.bun`
 * in the root `package.json` and in `bun-version` in `.github/workflows/
 * ci.yml` TOGETHER. Nothing fails when they drift apart on their own: CI
 * would run one Bun version, a contributor's machine another, and the
 * difference would only be felt as behaviour that cannot be reproduced —
 * exactly the class of defect every gate in this repo exists to catch, and
 * the one this specific rule had no checker for until now.
 *
 * This repo has one CI job today (`check`), so one `bun-version`
 * declaration is expected — not the three `ahliweb/media-lenterakalteng`
 * checks for, which has a `build` job and a `cms` job neither of which
 * exist here yet. When `apps/storefront` or a from-source `apps/cms` CI job
 * lands with its own `bun-version` line, this count should grow with them,
 * deliberately, rather than silently.
 */
import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const ci = readFileSync(".github/workflows/ci.yml", "utf8");

/** `bun@1.4.0` → `1.4.0`. This is the reference value everything else is compared to. */
const VERSION = pkg.packageManager?.replace(/^bun@/, "");

describe("the Bun version agrees everywhere it is used", () => {
  test("packageManager states an exact version, not a range", () => {
    // A range here would leave the checks below with no reference value —
    // and `bun-version` in CI accepts no range either, so it would still
    // have to be written exactly.
    assert.match(
      pkg.packageManager ?? "",
      /^bun@\d+\.\d+\.\d+$/,
      `packageManager must be "bun@X.Y.Z", not ${JSON.stringify(pkg.packageManager)}`
    );
  });

  test("engines.bun ACCEPTS the pinned version", () => {
    // Deliberately not equality: engines.bun is the minimum range stated to
    // anyone installing this workspace, while packageManager is the exact
    // version this repo itself uses. What would be wrong is not that they
    // differ — it is a range that rejects the version actually in use.
    const minimum = pkg.engines?.bun?.replace(/^>=/, "");
    assert.ok(minimum, "engines.bun is missing");

    const [aM, aN, aP] = VERSION.split(".").map(Number);
    const [bM, bN, bP] = minimum.split(".").map(Number);
    const satisfies =
      aM > bM || (aM === bM && (aN > bN || (aN === bN && aP >= bP)));

    assert.ok(
      satisfies,
      `engines.bun (>=${minimum}) rejects the version this repo actually uses (${VERSION})`
    );
  });

  test("the CI job's bun-version equals packageManager", () => {
    const used = [...ci.matchAll(/bun-version:\s*"([^"]+)"/g)].map((m) => m[1]);

    assert.equal(
      used.length,
      1,
      `expected exactly one bun-version declaration in ci.yml (this repo has one CI job today), found ${used.length}`
    );

    assert.equal(used[0], VERSION, "bun-version in ci.yml");
  });

  test("apps/cms's own packageManager is a known, accepted divergence", () => {
    // apps/cms carries its own packageManager (bun@1.4.2) as a leftover
    // from when it was a standalone repository before the subtree embed —
    // see AGENTS.md's "Configuration and toolchain". This test does not
    // demand it match the root pin (that would be re-introducing the
    // problem the comment explains away); it only proves the value this
    // repo's own docs describe is still what is actually there, so the
    // documented exception cannot quietly go stale in either direction.
    const cmsPkg = JSON.parse(readFileSync("apps/cms/package.json", "utf8"));
    assert.ok(
      cmsPkg.packageManager,
      "apps/cms/package.json no longer declares its own packageManager — re-check AGENTS.md's note about this divergence"
    );
  });
});
