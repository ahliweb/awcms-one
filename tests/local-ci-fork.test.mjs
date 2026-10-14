/**
 * Fork-PR refusal policy (`tools/ci/lib/fork.ts`) — running untrusted fork
 * code on a trusted host needs an explicit `--allow-fork`. Pure predicate
 * only, plus the pure REST-response mapping `pullRequestInfoFromRest`;
 * `fetchPullRequestInfo` itself needs `gh` and a network, so it is not
 * exercised here.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { enforceForkPolicyOrThrow, isFromFork, pullRequestInfoFromRest } from "../tools/ci/lib/fork.ts";

describe("tools/ci/lib/fork.ts", () => {
  test("isFromFork reflects isCrossRepository", () => {
    assert.equal(isFromFork({ isCrossRepository: true }), true);
    assert.equal(isFromFork({ isCrossRepository: false }), false);
  });

  test("enforceForkPolicyOrThrow throws for a fork PR without --allow-fork", () => {
    assert.throws(
      () =>
        enforceForkPolicyOrThrow(
          { isCrossRepository: true, headRepoFullName: "someone-else/awcms-one", number: 42 },
          false
        ),
      /fork/
    );
  });

  test("enforceForkPolicyOrThrow allows a fork PR with --allow-fork", () => {
    assert.doesNotThrow(() =>
      enforceForkPolicyOrThrow(
        { isCrossRepository: true, headRepoFullName: "someone-else/awcms-one", number: 42 },
        true
      )
    );
  });

  test("enforceForkPolicyOrThrow never throws for a same-repo PR", () => {
    assert.doesNotThrow(() =>
      enforceForkPolicyOrThrow({ isCrossRepository: false, headRepoFullName: "ahliweb/awcms-one", number: 1 }, false)
    );
  });

  const restPr = (headRepo, baseRepo = "ahliweb/awcms-one") => ({
    number: 7,
    head: { sha: "a".repeat(40), repo: headRepo === null ? null : { full_name: headRepo } },
    base: { repo: { full_name: baseRepo } }
  });

  test("pullRequestInfoFromRest maps a same-repo PR as not cross-repository", () => {
    assert.deepEqual(pullRequestInfoFromRest(restPr("ahliweb/awcms-one")), {
      number: 7,
      headSha: "a".repeat(40),
      headRepoFullName: "ahliweb/awcms-one",
      isCrossRepository: false
    });
  });

  test("pullRequestInfoFromRest compares repository names case-insensitively", () => {
    assert.equal(pullRequestInfoFromRest(restPr("AhliWeb/awcms-one")).isCrossRepository, false);
  });

  test("pullRequestInfoFromRest marks a fork PR as cross-repository", () => {
    const info = pullRequestInfoFromRest(restPr("someone-else/awcms-one"));
    assert.equal(info.isCrossRepository, true);
    assert.equal(info.headRepoFullName, "someone-else/awcms-one");
  });

  test("pullRequestInfoFromRest treats a deleted head repository as a fork", () => {
    const info = pullRequestInfoFromRest(restPr(null));
    assert.equal(info.isCrossRepository, true);
    assert.throws(() => enforceForkPolicyOrThrow(info, false), /fork/);
  });
});
