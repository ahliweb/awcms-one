/**
 * Fork-PR refusal policy (`tools/ci/lib/fork.ts`) — running untrusted fork
 * code on a trusted host needs an explicit `--allow-fork`. Pure predicate
 * only; `fetchPullRequestInfo` itself needs `gh` and a network, so it is
 * not exercised here.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { enforceForkPolicyOrThrow, isFromFork } from "../tools/ci/lib/fork.ts";

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
});
