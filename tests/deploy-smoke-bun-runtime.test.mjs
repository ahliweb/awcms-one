/**
 * `tools/deploy/smoke-bun-runtime.sh` (issue #469, ADR-0002): the opt-in
 * runtime half of the Bun-only gate, driven here against a stub `docker` so no
 * daemon, image or network is involved. The stub answers the two commands the
 * script issues (`docker run ... bun -e ...` and `docker inspect ...`) from
 * environment variables, which lets each test describe one image:
 *
 *   - a correct image (pinned Bun, CMD starts with bun) passes;
 *   - an image reporting another Bun version, a non-bun `execPath`, a missing
 *     bun, or a non-bun CMD fails, naming the role;
 *   - the pin is the root `packageManager` value read at run time, so this file
 *     never hard-codes a version either.
 *
 * What a real run adds, and a stub cannot prove, is that the image the operator
 * built or pulled really contains that Bun: that is the operator step in
 * docs/pengujian.md.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SCRIPT = join(REPO_ROOT, "tools", "deploy", "smoke-bun-runtime.sh");
const PIN = /^bun@(\d+\.\d+\.\d+)/.exec(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).packageManager)[1];

let workDir;
let stubDocker;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "smoke-bun-"));
  stubDocker = join(workDir, "docker");
  writeFileSync(
    stubDocker,
    `#!/usr/bin/env bash
case "$1" in
  run)
    [[ "\${STUB_RUN_FAIL:-0}" == "1" ]] && { echo "exec: bun: not found" >&2; exit 127; }
    echo "\${STUB_PROBE:-}"
    ;;
  inspect) echo "\${STUB_CMD:-null}" ;;
esac
exit 0
`
  );
  chmodSync(stubDocker, 0o755);
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

function smoke(args, env = {}) {
  const result = Bun.spawnSync(["bash", SCRIPT, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER: stubDocker, ...env },
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    code: result.exitCode,
    out: `${result.stdout.toString()}${result.stderr.toString()}`
  };
}

const GOOD = {
  STUB_PROBE: `${PIN} /usr/local/bin/bun`,
  STUB_CMD: '["bun","dist/server/penyaji.mjs"]'
};

describe("tools/deploy/smoke-bun-runtime.sh", () => {
  test("passes for an image that runs the pinned Bun and starts bun", () => {
    const result = smoke(["--image", "storefront=img:toko", "--image", "cms=img:cms", "--image", "jobs=img:jobs"], GOOD);
    expect(result.out).toContain("bun-smoke: PASS");
    expect(result.code).toBe(0);
  });

  test("fails, naming the role, when the image runs another Bun version", () => {
    const result = smoke(["--image", "cms=img:cms"], { ...GOOD, STUB_PROBE: "1.0.0 /usr/local/bin/bun" });
    expect(result.code).toBe(1);
    expect(result.out).toContain(`cms: image runs Bun 1.0.0, expected ${PIN}`);
  });

  test("fails when process.execPath is not a bun binary", () => {
    const result = smoke(["--image", "jobs=img:jobs"], { ...GOOD, STUB_PROBE: `${PIN} /usr/bin/other` });
    expect(result.code).toBe(1);
    expect(result.out).toContain("jobs: process.execPath is '/usr/bin/other'");
  });

  test("fails when bun cannot be started inside the image", () => {
    const result = smoke(["--image", "jobs=img:jobs"], { ...GOOD, STUB_RUN_FAIL: "1" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("jobs: bun did not run inside img:jobs");
  });

  test("fails when a server image's CMD does not start with bun", () => {
    const result = smoke(["--image", "storefront=img:toko"], { ...GOOD, STUB_CMD: '["sh","-c","serve"]' });
    expect(result.code).toBe(1);
    expect(result.out).toContain("storefront: image CMD does not start with bun");
  });

  test("does not require a bun CMD from the jobs role, which a scheduler launches", () => {
    const result = smoke(["--image", "jobs=img:jobs"], { ...GOOD, STUB_CMD: '["bun"]' });
    expect(result.code).toBe(0);
    expect(smoke(["--image", "jobs=img:jobs"], { ...GOOD, STUB_CMD: "null" }).code).toBe(0);
  });

  test("refuses to run without an image, or with an unknown role (exit 2)", () => {
    expect(smoke([], GOOD).code).toBe(2);
    expect(smoke(["--image", "worker=img:x"], GOOD).code).toBe(2);
    expect(smoke(["--image", "cms="], GOOD).code).toBe(2);
    expect(smoke(["--bogus"], GOOD).code).toBe(2);
  });

  test("is opt-in: no local-ci leg, runner or root test script launches it", () => {
    const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(rootPackage.scripts["deploy:smoke-bun"]).toBe("bash tools/deploy/smoke-bun-runtime.sh");
    for (const script of ["test", "check", "ci", "ci:pr", "ci:watch"]) {
      expect(rootPackage.scripts[script]).not.toContain("smoke-bun");
    }
    for (const file of ["tools/ci/legs.ts", "tools/ci/runners/check.ts", "tools/ci/runners/e2e.ts", "tools/ci/runners/template.ts"]) {
      expect(readFileSync(join(REPO_ROOT, file), "utf8")).not.toContain("smoke-bun");
    }
  });
});
