/**
 * The local-ci leg table (`tools/ci/legs.ts`) — the single source of truth
 * issue #225's twelve `local-ci/*` status contexts come from. No network,
 * no docker, no subprocess: purely the exported table's own shape.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { LEGS, LEG_CONTEXTS, findLeg, legsInGroup } from "../tools/ci/legs.ts";

const EXPECTED_CONTEXTS = [
  "local-ci/check-toko",
  "local-ci/check-berita",
  "local-ci/check-landing",
  "local-ci/check-cms",
  "local-ci/template-toko",
  "local-ci/template-berita",
  "local-ci/template-landing",
  "local-ci/template-root",
  "local-ci/e2e-toko",
  "local-ci/e2e-berita",
  "local-ci/e2e-landing",
  "local-ci/security"
];

describe("tools/ci/legs.ts", () => {
  test("names exactly the twelve local-ci/* contexts, in order", () => {
    assert.deepEqual(LEG_CONTEXTS, EXPECTED_CONTEXTS);
  });

  test("every context is unique", () => {
    assert.equal(new Set(LEG_CONTEXTS).size, LEG_CONTEXTS.length);
  });

  test("every leg has a non-empty description", () => {
    for (const leg of LEGS) {
      assert.ok(leg.description && leg.description.length > 0, `${leg.context} has no description`);
    }
  });

  test("findLeg resolves a known context and returns undefined for an unknown one", () => {
    assert.equal(findLeg("local-ci/security")?.group, "security");
    assert.equal(findLeg("local-ci/does-not-exist"), undefined);
  });

  test("legsInGroup partitions the table correctly", () => {
    assert.equal(legsInGroup("check").length, 4);
    assert.equal(legsInGroup("template").length, 4);
    assert.equal(legsInGroup("e2e").length, 3);
    assert.equal(legsInGroup("security").length, 1);
  });

  test("check-toko and template-root are the only 'primary' legs", () => {
    const primary = LEGS.filter((leg) => leg.primary).map((leg) => leg.context);
    assert.deepEqual(primary, ["local-ci/check-toko", "local-ci/template-root"]);
  });
});

describe("tools/ci/lib/orchestrate.ts", () => {
  test("sets CI=true for every leg, as GitHub Actions did (forbidOnly, retries and the HTML report depend on it)", async () => {
    const source = await Bun.file(new URL("../tools/ci/lib/orchestrate.ts", import.meta.url)).text();
    assert.match(source, /process\.env\.CI = "true";/);
    const config = await Bun.file(new URL("../apps/storefront/playwright.config.ts", import.meta.url)).text();
    assert.match(config, /forbidOnly: !!process\.env\.CI/);
  });
});
