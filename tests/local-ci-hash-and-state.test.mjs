/**
 * The CI-definition hash (`tools/ci/lib/hash.ts`) and state-directory
 * keying (`tools/ci/lib/state-dir.ts`) `bun run ci:watch` uses to decide
 * whether a previously recorded result still applies. No docker, no
 * network — the hash reads real files from this checkout (read-only), and
 * state-dir is pure path arithmetic.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { ciDefinitionHash } from "../tools/ci/lib/hash.ts";
import { evidenceDir, lockFilePath, resultKey, resultsDir, stateRoot } from "../tools/ci/lib/state-dir.ts";

describe("tools/ci/lib/hash.ts", () => {
  test("ciDefinitionHash is deterministic across two calls against the same tree", () => {
    const a = ciDefinitionHash(process.cwd());
    const b = ciDefinitionHash(process.cwd());
    assert.equal(a, b);
  });

  test("ciDefinitionHash has the sha256: prefix", () => {
    assert.match(ciDefinitionHash(process.cwd()), /^sha256:[0-9a-f]{64}$/);
  });
});

describe("tools/ci/lib/state-dir.ts", () => {
  test("stateRoot honours XDG_STATE_HOME when set", () => {
    const root = stateRoot({ XDG_STATE_HOME: "/tmp/xdg-state" });
    assert.equal(root, "/tmp/xdg-state/awcms-one-ci");
  });

  test("stateRoot falls back to ~/.local/state when unset", () => {
    const root = stateRoot({});
    assert.match(root, /\.local\/state\/awcms-one-ci$/);
  });

  test("lockFilePath, evidenceDir, resultsDir all live under stateRoot", () => {
    const env = { XDG_STATE_HOME: "/tmp/xdg-state" };
    const root = stateRoot(env);
    assert.ok(lockFilePath(env).startsWith(root));
    assert.ok(evidenceDir("run-1", env).startsWith(root));
    assert.ok(resultsDir(env).startsWith(root));
  });

  test("resultKey changes when any of its inputs change", () => {
    const base = { owner: "ahliweb", repo: "awcms-one", pr: 225, sha: "abc123", ciDefinitionVersion: "sha256:aaa" };
    const key = resultKey(base);
    assert.notEqual(key, resultKey({ ...base, pr: 226 }));
    assert.notEqual(key, resultKey({ ...base, sha: "def456" }));
    assert.notEqual(key, resultKey({ ...base, ciDefinitionVersion: "sha256:bbb" }));
    assert.equal(key, resultKey({ ...base }));
  });
});
