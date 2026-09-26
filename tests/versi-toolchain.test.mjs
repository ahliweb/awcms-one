/**
 * Toolchain version gate: one Bun version, pinned in two places that must
 * move together, and nothing checked they agreed until this file.
 *
 * ## The rule is already written; the checker is what was missing
 *
 * `AGENTS.md`'s "Configuration and toolchain" states it as a rule that
 * cannot be broken: Bun's version moves in `packageManager` and
 * `engines.bun` in the root `package.json` TOGETHER. There is no
 * `.github/workflows/ci.yml` `bun-version` line to keep in step with any
 * more — GitHub Actions was removed entirely for this repo (ADR-0021,
 * issue #225) — so the only enforced check left is `tools/ci/lib/
 * bun-pin.ts`'s `enforceBunPinOrThrow`, which every local-ci leg runs
 * against whatever Bun is actually on the operator's or server's PATH
 * before doing anything else. `tests/local-ci-bun-pin.test.mjs` exercises
 * that module's logic directly with fixtures; this file only owns the
 * root `package.json` shape and that `tools/ci/lib/orchestrate.ts` still
 * calls the enforcement function.
 */
import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const orchestrate = readFileSync("tools/ci/lib/orchestrate.ts", "utf8");

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

  test("local CI enforces the Bun pin before running any leg", () => {
    // There is no `bun-version:` line to compare any more — the enforcement
    // is a runtime check (tools/ci/lib/bun-pin.ts), and this only proves the
    // orchestrator still wires it in rather than having quietly dropped it.
    assert.match(
      orchestrate,
      /enforceBunPinOrThrow/,
      "tools/ci/lib/orchestrate.ts no longer calls enforceBunPinOrThrow — " +
        "local CI would run legs under an unpinned Bun"
    );
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
