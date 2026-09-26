import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../tools/ci/lib/lock.ts";

// A PID far above any real pid_max default, so it is never alive.
const DEAD_PID = 2 ** 22 + 12345;

describe("tools/ci/lib/lock.ts", () => {
  let dir;
  let path;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-ci-lock-"));
    path = join(dir, "watch.lock");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("acquires, records this PID, and releases", () => {
    const lock = acquireLock(path);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  test("refuses while a live process holds the lock", () => {
    const lock = acquireLock(path);
    expect(() => acquireLock(path)).toThrow(/already running/);
    lock.release();
  });

  test("reclaims a lock left by a dead process", () => {
    writeFileSync(path, String(DEAD_PID));
    const lock = acquireLock(path);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    expect(existsSync(`${path}.stale.${process.pid}`)).toBe(false);
    lock.release();
  });

  test("never removes a live holder's lock while reclaiming", () => {
    // The file names a live PID (this test's own): the reclaim path must not
    // run at all, and the holder's lock must survive intact.
    writeFileSync(path, String(process.pid));
    expect(() => acquireLock(path)).toThrow(/already running/);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  });
});
