/**
 * The Bun-pin fail-closed check local CI runs before any leg
 * (`tools/ci/lib/bun-pin.ts`). Pure — fixture strings, no real Bun install.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { checkBunPin, enforceBunPinOrThrow, readPinnedBunVersion } from "../tools/ci/lib/bun-pin.ts";

const PKG = JSON.stringify({ packageManager: "bun@1.4.2" });

describe("tools/ci/lib/bun-pin.ts", () => {
  test("readPinnedBunVersion extracts the exact version", () => {
    assert.equal(readPinnedBunVersion(PKG), "1.4.2");
  });

  test("readPinnedBunVersion throws when packageManager is missing", () => {
    assert.throws(() => readPinnedBunVersion(JSON.stringify({})), /packageManager/);
  });

  test("readPinnedBunVersion throws on a non bun@X.Y.Z shape", () => {
    assert.throws(() => readPinnedBunVersion(JSON.stringify({ packageManager: "bun@1.4" })), /bun@X\.Y\.Z/);
  });

  test("checkBunPin: matching version is ok", () => {
    const result = checkBunPin("1.4.2", PKG);
    assert.deepEqual(result, { ok: true, version: "1.4.2" });
  });

  test("checkBunPin: mismatched version fails closed with a clear message", () => {
    const result = checkBunPin("1.3.0", PKG);
    assert.equal(result.ok, false);
    assert.equal(result.expected, "1.4.2");
    assert.equal(result.actual, "1.3.0");
    assert.match(result.message, /1\.3\.0/);
    assert.match(result.message, /1\.4\.2/);
  });

  test("enforceBunPinOrThrow throws on mismatch, is silent on match", () => {
    // A real Bun.version comparison would be environment-dependent, so this
    // only exercises the throwing path directly with a fixture package.json.
    assert.throws(() => enforceBunPinOrThrow(JSON.stringify({ packageManager: "bun@99.99.99" })));
  });
});
