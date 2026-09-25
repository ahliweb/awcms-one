/**
 * Pure-logic gate for `tools/release/publish.ts` — issue #225 part 2, the
 * trusted-release-host replacement for `.github/workflows/release.yml`.
 *
 * `computeLatestFlag` is the one piece of that script's own logic that can
 * be tested without git or the GitHub CLI — see `tools/release/lib/latest.mjs`'s
 * own docblock for why the ancestry check itself stays outside this module.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import { computeLatestFlag } from "../tools/release/lib/latest.mjs";
import { isValidTag, matchesOwnRelease } from "../tools/release/lib/tag.mjs";

describe("latest.mjs — computeLatestFlag", () => {
  test("--latest when the published tag IS the highest", () => {
    const result = computeLatestFlag({
      tag: "v1.2.0",
      allTags: ["v1.0.0", "v1.1.0", "v1.2.0"],
      highestIsAncestorOfMain: true
    });
    assert.deepEqual(result, { flag: "--latest", highest: "v1.2.0" });
  });

  test("--latest=false when a newer tag exists", () => {
    const result = computeLatestFlag({
      tag: "v1.0.0",
      allTags: ["v1.0.0", "v1.1.0", "v1.2.0"],
      highestIsAncestorOfMain: true
    });
    assert.deepEqual(result, { flag: "--latest=false", highest: "v1.2.0" });
  });

  test("matches .github/workflows/release.yml's own git-tag-sort logic for a single tag", () => {
    const result = computeLatestFlag({
      tag: "v0.1.0",
      allTags: ["v0.1.0"],
      highestIsAncestorOfMain: true
    });
    assert.equal(result.flag, "--latest");
  });

  test("refuses when the highest tag is untrustworthy and is not the tag being published", () => {
    // The AGENTS.md scenario: `git tag` is polluted by an upstream remote's
    // own release tags (e.g. ahliweb/awcms's v10.3.0), which is NOT an
    // ancestor of this repo's own origin/main.
    assert.throws(
      () =>
        computeLatestFlag({
          tag: "v0.9.0",
          allTags: ["v0.9.0", "v10.3.0"],
          highestIsAncestorOfMain: false
        }),
      /not reachable from origin\/main/
    );
  });

  test("does NOT refuse when the untrustworthy-looking highest tag IS the one being published", () => {
    // Publishing the actual highest tag itself, where the ancestry check
    // for whatever reason answered false (e.g. a shallow clone) — this
    // function only refuses when the untrustworthy tag would have CHANGED
    // the answer, per its own docblock.
    const result = computeLatestFlag({
      tag: "v1.0.0",
      allTags: ["v1.0.0"],
      highestIsAncestorOfMain: false
    });
    assert.deepEqual(result, { flag: "--latest", highest: "v1.0.0" });
  });
});

describe("tag.mjs — matchesOwnRelease (the upstream-tag-pollution guard)", () => {
  test("accepts a tag whose commit's package.json is this repo's own, at that exact version", () => {
    assert.equal(
      matchesOwnRelease({ name: "awcms-one", version: "0.12.0" }, "v0.12.0", "awcms-one"),
      true
    );
  });

  test("rejects a tag belonging to a different package name — the real ahliweb/awcms v10.3.0 case", () => {
    // Verified against this repository's own clone while building this
    // tool: v10.3.0 IS an ancestor of origin/main (the subtree carries full
    // history), yet it is ahliweb/awcms's own release, not this
    // repository's — package.json at that commit reads `"name": "awcms"`.
    assert.equal(
      matchesOwnRelease({ name: "awcms", version: "10.3.0" }, "v10.3.0", "awcms-one"),
      false
    );
  });

  test("rejects a tag whose version does not match its own package.json (a stray/renamed tag)", () => {
    assert.equal(
      matchesOwnRelease({ name: "awcms-one", version: "0.11.0" }, "v0.12.0", "awcms-one"),
      false
    );
  });

  test("rejects null/malformed package.json without throwing", () => {
    assert.equal(matchesOwnRelease(null, "v0.12.0", "awcms-one"), false);
    assert.equal(matchesOwnRelease({}, "v0.12.0", "awcms-one"), false);
  });

  test("never throws on a malformed tag", () => {
    assert.equal(matchesOwnRelease({ name: "awcms-one", version: "x" }, "not-a-tag", "awcms-one"), false);
  });
});

describe("tag.mjs — isValidTag reused by publish.ts's own argument check", () => {
  test("publish.ts's own usage guard rejects anything isValidTag rejects", () => {
    for (const bad of ["1.2.3", "v1.2", "", undefined]) {
      assert.ok(!isValidTag(bad));
    }
    assert.ok(isValidTag("v1.2.3"));
  });
});
