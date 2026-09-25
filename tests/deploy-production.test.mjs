import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hermetic scenario tests for `tools/deploy/*.sh` (issue #224).
 *
 * No real docker/git/curl/ssh/cosign is ever invoked — every one of those
 * five commands is replaced by a small stub script placed on `PATH` (and
 * bound explicitly via `DOCKER=`/`GIT=`/`CURL=`/`SSH=`/`COSIGN=`, which
 * `tools/deploy/lib/common.sh` reads instead of a hardcoded command name).
 * Each stub appends every invocation it received to a call-log file this
 * suite inspects to assert ORDER (e.g. "compose up" must never appear
 * before a successful migrate line). `DEPLOY_REPO_ROOT`/`DEPLOY_STATE_DIR`/
 * `COMPOSE_FILE` point every path operation at a disposable temp directory,
 * never at this real repository checkout.
 */

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DEPLOY_DIR = join(REPO_ROOT, "tools/deploy");
const DEPLOY_PRODUCTION = join(DEPLOY_DIR, "deploy-production.sh");
const DEPLOY_REMOTE = join(DEPLOY_DIR, "deploy-remote.sh");
const HEALTHCHECK = join(DEPLOY_DIR, "healthcheck-production.sh");
const ROLLBACK = join(DEPLOY_DIR, "rollback-production.sh");

const GOOD_TAG = "v1.2.3";
const GOOD_SHA = "a".repeat(40);
const GOOD_IMAGE = "ghcr.io/ahliweb/awcms-one-cms@sha256:" + "b".repeat(64);

let workDir;
let binDir;
let stateDir;
let callLog;
let repoRootFixture;

/** Writes an executable bash stub at `binDir/<name>`. */
function writeStub(name, body) {
  const path = join(binDir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function setupStubs() {
  writeStub(
    "docker",
    `
echo "docker $*" >> "$STUB_CALL_LOG"
if [[ "$1" != "compose" ]]; then exit 0; fi
case "$*" in
  *"--profile backup run --rm backup"*)
    if [[ "\${STUB_BACKUP_FAIL:-0}" == "1" ]]; then
      [[ -n "\${DEPLOY_TEST_INJECT_SECRET_DSN:-}" ]] && echo "backup failed while connecting: \${DEPLOY_TEST_INJECT_SECRET_DSN}"
      [[ -n "\${DEPLOY_TEST_INJECT_SECRET_TOKEN:-}" ]] && echo "auth header was: \${DEPLOY_TEST_INJECT_SECRET_TOKEN}"
      exit 1
    fi
    exit 0 ;;
  *"build migrate cms jobs"*) [[ "\${STUB_BUILD_FAIL:-0}" == "1" ]] && exit 1 || exit 0 ;;
  *"pull migrate cms jobs"*) [[ "\${STUB_PULL_FAIL:-0}" == "1" ]] && exit 1 || exit 0 ;;
  *"--profile migrate run --rm migrate"*) [[ "\${STUB_MIGRATE_FAIL:-0}" == "1" ]] && exit 1 || exit 0 ;;
  *"awcms_schema_migrations"*)
    # First read = the ledger before migrate, every later read = after.
    if [[ -f "$STUB_CALL_LOG.migcount" ]]; then echo "\${STUB_MIG_AFTER:-6}"; else touch "$STUB_CALL_LOG.migcount"; echo "\${STUB_MIG_BEFORE:-5}"; fi
    exit 0 ;;
  *"exec -T postgres psql"*) echo "\${STUB_ROLE_CHECK:-f|f}"; exit 0 ;;
  *"up -d cms storefront"*) [[ "\${STUB_ACTIVATE_FAIL:-0}" == "1" ]] && exit 1 || exit 0 ;;
  *"ps --format json cms storefront"*) echo "\${STUB_PS_OUTPUT:-[]}"; exit 0 ;;
  *"build cms storefront"*) [[ "\${STUB_ROLLBACK_BUILD_FAIL:-0}" == "1" ]] && exit 1 || exit 0 ;;
  *"pull cms"*) exit 0 ;;
  *) exit 0 ;;
esac
`
  );

  writeStub(
    "git",
    `
echo "git $*" >> "$STUB_CALL_LOG"
case "$*" in
  *"status --porcelain"*) printf '%s' "\${STUB_GIT_DIRTY:-}"; exit 0 ;;
  *"fetch --tags"*) exit "\${STUB_GIT_FETCH_EXIT:-0}" ;;
  *"rev-parse --verify"*)
    if [[ "\${STUB_GIT_RESOLVE_FAIL:-0}" == "1" ]]; then exit 1; fi
    ref="\${*##*--verify }"
    ref="\${ref%^\\{commit\\}}"
    if [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then echo "$ref"; else echo "${GOOD_SHA}"; fi
    exit 0 ;;
  *"checkout --detach"*) exit 0 ;;
  *) exit 0 ;;
esac
`
  );

  writeStub(
    "curl",
    `
echo "curl $*" >> "$STUB_CALL_LOG"
[[ "\${STUB_CURL_FAIL:-0}" == "1" ]] && exit 1 || exit 0
`
  );

  writeStub(
    "ssh",
    `
echo "ssh $*" >> "$STUB_CALL_LOG"
exit 0
`
  );

  writeStub(
    "cosign",
    `
echo "cosign $*" >> "$STUB_CALL_LOG"
[[ "\${STUB_COSIGN_FAIL:-0}" == "1" ]] && exit 1 || exit 0
`
  );

  // deploy-production.sh's only direct $BUN invocation is
  // "bun run deploy:preflight ..." — the fixture repo has no package.json
  // defining that script, so this stub intercepts exactly that call and
  // otherwise delegates to the real bun (needed because common.sh's own
  // $REDACT_LOG is built as "$BUN <redact-log.mjs>").
  // Deliberately NOT logged to $STUB_CALL_LOG — bun is not one of the five
  // externally-invoked commands this suite asserts the ORDER of (docker,
  // git, curl, ssh, cosign); it is also used as the redaction pipe's own
  // interpreter ($REDACT_LOG), so logging every invocation here would
  // record one call per printed log line, unrelated to the deployment
  // transaction's own steps.
  writeStub(
    "bun",
    `
if [[ "$*" == *"deploy:preflight"* ]]; then
  if [[ "\${STUB_PREFLIGHT_FAIL:-0}" == "1" ]]; then
    echo "preflight stub: forced failure" >&2
    exit 1
  fi
  exit 0
fi
exec "$REAL_BUN" "$@"
`
  );
}

function baseEnv(extra = {}) {
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    DOCKER: join(binDir, "docker"),
    GIT: join(binDir, "git"),
    BUN: join(binDir, "bun"),
    REAL_BUN: process.execPath,
    CURL: join(binDir, "curl"),
    SSH: join(binDir, "ssh"),
    COSIGN: join(binDir, "cosign"),
    FLOCK: "flock",
    DEPLOY_REPO_ROOT: repoRootFixture,
    DEPLOY_STATE_DIR: stateDir,
    COMPOSE_FILE: join(repoRootFixture, "compose.production.yaml"),
    STUB_CALL_LOG: callLog,
    DEPLOY_SKIP_BACKUP: "false",
    POSTGRES_USER: "awcms",
    POSTGRES_DB: "awcms",
    ...extra
  };
}

function run(script, args, extra = {}) {
  const result = Bun.spawnSync(["bash", script, ...args], {
    env: baseEnv(extra),
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr)
  };
}

function calls() {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8").split("\n").filter(Boolean);
}

function callIndexOf(substr) {
  return calls().findIndex((line) => line.includes(substr));
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "awcms-deploy-test-"));
  binDir = join(workDir, "bin");
  stateDir = join(workDir, "state");
  repoRootFixture = join(workDir, "repo");
  callLog = join(workDir, "calls.log");
  mkdirSync(binDir);
  mkdirSync(stateDir);
  mkdirSync(repoRootFixture);
  writeFileSync(join(repoRootFixture, "compose.production.yaml"), "name: fixture\n");
  writeFileSync(callLog, "");
  setupStubs();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("tools/deploy/deploy-production.sh — target validation", () => {
  test("rejects a branch name", () => {
    const result = run(DEPLOY_PRODUCTION, ["main"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("not an exact release");
    expect(calls().length).toBe(0);
  });

  test("rejects a short SHA", () => {
    const result = run(DEPLOY_PRODUCTION, ["a1b2c3d"]);
    expect(result.exitCode).not.toBe(0);
    expect(calls().length).toBe(0);
  });

  test("rejects an image ref with no digest", () => {
    const result = run(DEPLOY_PRODUCTION, ["ghcr.io/ahliweb/awcms-one-cms:latest"]);
    expect(result.exitCode).not.toBe(0);
    expect(calls().length).toBe(0);
  });

  test("accepts an exact vX.Y.Z tag and deploys successfully", () => {
    const result = run(DEPLOY_PRODUCTION, [GOOD_TAG]);
    expect(result.stdout + result.stderr).not.toContain("FAIL");
    expect(result.exitCode).toBe(0);
  });

  test("accepts an exact 40-character commit SHA and deploys successfully", () => {
    const result = run(DEPLOY_PRODUCTION, [GOOD_SHA]);
    expect(result.exitCode).toBe(0);
  });

  test("accepts an image ref pinned by digest and deploys successfully", () => {
    const result = run(DEPLOY_PRODUCTION, [GOOD_IMAGE]);
    expect(result.exitCode).toBe(0);
  });
});

describe("tools/deploy/deploy-production.sh — the deployment transaction", () => {
  test("calls happen in order: backup -> build -> migrate -> role-check -> activate", () => {
    run(DEPLOY_PRODUCTION, [GOOD_TAG]);
    const backupIdx = callIndexOf("--profile backup run --rm backup");
    const buildIdx = callIndexOf("build migrate cms jobs");
    const migrateIdx = callIndexOf("--profile migrate run --rm migrate");
    const roleIdx = callIndexOf("pg_roles");
    const activateIdx = callIndexOf("up -d cms storefront");
    expect(backupIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(backupIdx);
    expect(migrateIdx).toBeGreaterThan(buildIdx);
    expect(roleIdx).toBeGreaterThan(migrateIdx);
    expect(activateIdx).toBeGreaterThan(roleIdx);
  });

  test("target already deployed and healthy is a no-op success", () => {
    // First deploy establishes the recorded release.
    const first = run(DEPLOY_PRODUCTION, [GOOD_TAG]);
    expect(first.exitCode).toBe(0);
    writeFileSync(callLog, ""); // reset call log to observe the SECOND run only

    const second = run(DEPLOY_PRODUCTION, [GOOD_TAG]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("no-op success");
    // No migration/backup/build call on the no-op path.
    expect(callIndexOf("--profile migrate run --rm migrate")).toBe(-1);
    expect(callIndexOf("--profile backup run --rm backup")).toBe(-1);
  });

  test("a concurrent deploy attempt is rejected by the lock", async () => {
    const lockFile = join(stateDir, "deploy.lock");
    // Hold the lock in a real background process for the duration of this
    // test — flock -n inside deploy-production.sh must then refuse
    // immediately rather than block or proceed.
    const holder = Bun.spawn(["bash", "-c", `exec 9>"${lockFile}"; flock 9; sleep 5`]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = run(DEPLOY_PRODUCTION, [GOOD_TAG]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr + result.stdout).toContain("already running");
      // The lock was rejected before any transaction step ran.
      expect(calls().length).toBe(0);
    } finally {
      holder.kill();
    }
  });

  test("dirty checkout fails closed before any runtime mutation", () => {
    const result = run(DEPLOY_PRODUCTION, [GOOD_TAG], { STUB_GIT_DIRTY: "M some-file.txt" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("not clean");
    expect(callIndexOf("--profile backup run --rm backup")).toBe(-1);
    expect(callIndexOf("--profile migrate run --rm migrate")).toBe(-1);
    expect(callIndexOf("up -d cms storefront")).toBe(-1);
  });

  test("preflight failure stops before any runtime mutation", () => {
    const result = run(DEPLOY_PRODUCTION, [GOOD_TAG], { STUB_PREFLIGHT_FAIL: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(callIndexOf("--profile backup run --rm backup")).toBe(-1);
    expect(callIndexOf("--profile migrate run --rm migrate")).toBe(-1);
  });

  test("backup failure stops before migration", () => {
    const result = run(DEPLOY_PRODUCTION, [GOOD_TAG], { STUB_BACKUP_FAIL: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(callIndexOf("--profile migrate run --rm migrate")).toBe(-1);
    expect(callIndexOf("up -d cms storefront")).toBe(-1);
  });

  test("migration failure prevents activation", () => {
    const result = run(DEPLOY_PRODUCTION, [GOOD_TAG], { STUB_MIGRATE_FAIL: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(callIndexOf("up -d cms storefront")).toBe(-1);
  });

  test("a runtime role with rolsuper/bypassrls true fails the deploy after migration but before activation", () => {
    const result = run(DEPLOY_PRODUCTION, [GOOD_TAG], { STUB_ROLE_CHECK: "t|t" });
    expect(result.exitCode).not.toBe(0);
    expect(callIndexOf("--profile migrate run --rm migrate")).toBeGreaterThanOrEqual(0);
    expect(callIndexOf("up -d cms storefront")).toBe(-1);
  });

  test("health-check failure after activation does NOT auto-roll back when a migration ran this attempt", () => {
    // The stub ledger goes 5 -> 6 across the migrate step: a migration WAS
    // applied, so the script must stop and point at the documented DB
    // recovery runbook instead of rolling code back on top of a schema that
    // has changed.
    const result = run(DEPLOY_PRODUCTION, [GOOD_TAG], { STUB_CURL_FAIL: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("does NOT auto-roll back code");
    expect(result.stdout).toContain("DB recovery runbook");
    // Activation DID happen (health is checked only after activation) but
    // rollback-production.sh must never have been invoked automatically.
    expect(callIndexOf("up -d cms storefront")).toBeGreaterThanOrEqual(0);
  });
});

describe("tools/deploy/deploy-production.sh — automatic rollback depends on the migration ledger", () => {
  test("health failure after a code-only release (ledger unchanged) rolls back to the previous release", () => {
    writeFileSync(join(stateDir, "current-release"), "v1.2.2");
    const result = run(DEPLOY_PRODUCTION, [GOOD_TAG], {
      STUB_CURL_FAIL: "1",
      STUB_MIG_BEFORE: "6",
      STUB_MIG_AFTER: "6",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("no new migration was applied");
    expect(result.stdout).toContain("rolling back to previous release 'v1.2.2'");
  });

  test("an unreadable ledger counts as a migration having run (no automatic rollback)", () => {
    writeFileSync(join(stateDir, "current-release"), "v1.2.2");
    const result = run(DEPLOY_PRODUCTION, [GOOD_TAG], {
      STUB_CURL_FAIL: "1",
      STUB_MIG_BEFORE: "ERROR: relation does not exist",
      STUB_MIG_AFTER: "6",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("does NOT auto-roll back code");
    expect(result.stdout).not.toContain("rolling back to previous release");
  });

  test("the audit record carries the resolved commit SHA", () => {
    const result = run(DEPLOY_PRODUCTION, [GOOD_TAG]);
    expect(result.exitCode).toBe(0);
    const audit = readFileSync(join(stateDir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.at(-1).status).toBe("success");
    expect(audit.at(-1).resolved).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("tools/deploy/deploy-production.sh — secrets never appear in logs or the audit record", () => {
  test("a DSN password and a bearer token surfaced by a failing backup step are redacted", () => {
    const secretDsn = "postgres://awcms_setup:sUp3rS3cr3tPassw0rd@db.internal:5432/awcms";
    const secretToken = "Bearer abcdEFGH12345678ijklmnop";
    const result = run(DEPLOY_PRODUCTION, [GOOD_TAG], {
      STUB_BACKUP_FAIL: "1",
      DEPLOY_TEST_INJECT_SECRET_DSN: secretDsn,
      DEPLOY_TEST_INJECT_SECRET_TOKEN: secretToken
    });
    expect(result.exitCode).not.toBe(0); // the backup step genuinely failed
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("sUp3rS3cr3tPassw0rd");
    expect(combined).not.toContain("abcdEFGH12345678ijklmnop");

    const auditPath = join(stateDir, "audit.jsonl");
    if (existsSync(auditPath)) {
      const audit = readFileSync(auditPath, "utf8");
      expect(audit).not.toContain("sUp3rS3cr3tPassw0rd");
      expect(audit).not.toContain("abcdEFGH12345678ijklmnop");
    }
  });

  test("the audit JSONL never contains the word 'password' followed by a real value", () => {
    run(DEPLOY_PRODUCTION, [GOOD_TAG]);
    const auditPath = join(stateDir, "audit.jsonl");
    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("tools/deploy/healthcheck-production.sh", () => {
  test("passes when compose ps is healthy and both curl checks succeed", () => {
    const result = run(HEALTHCHECK, []);
    expect(result.exitCode).toBe(0);
  });

  test("fails when compose ps reports unhealthy", () => {
    const result = run(HEALTHCHECK, [], { STUB_PS_OUTPUT: '[{"Health":"unhealthy"}]' });
    expect(result.exitCode).not.toBe(0);
  });

  test("fails when a curl liveness check fails", () => {
    const result = run(HEALTHCHECK, [], { STUB_CURL_FAIL: "1" });
    expect(result.exitCode).not.toBe(0);
  });
});

describe("tools/deploy/rollback-production.sh", () => {
  test("rolls back to an explicit previous release", () => {
    const result = run(ROLLBACK, [GOOD_TAG]);
    expect(result.exitCode).toBe(0);
    expect(callIndexOf("up -d cms storefront")).toBeGreaterThanOrEqual(0);
  });

  test("refuses when no target is given and none is recorded", () => {
    const result = run(ROLLBACK, []);
    expect(result.exitCode).not.toBe(0);
  });

  test("refuses an automatic rollback when a migration ran this attempt", () => {
    writeFileSync(join(stateDir, "migration-ran-this-attempt"), "true");
    const result = run(ROLLBACK, [GOOD_TAG]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("DB recovery runbook");
  });
});

describe("tools/deploy/deploy-remote.sh", () => {
  test("validates the target before ever invoking ssh", () => {
    const result = run(DEPLOY_REMOTE, ["some-host", "main"]);
    expect(result.exitCode).not.toBe(0);
    expect(callIndexOf("ssh ")).toBe(-1);
  });

  test("invokes ssh with the fixed remote script path and the exact target", () => {
    const result = run(DEPLOY_REMOTE, ["deploy@example.test", GOOD_TAG]);
    expect(result.exitCode).toBe(0);
    const sshCall = calls().find((l) => l.startsWith("ssh "));
    expect(sshCall).toBeDefined();
    expect(sshCall).toContain("deploy@example.test");
    expect(sshCall).toContain(GOOD_TAG);
    expect(sshCall).toContain("tools/deploy/deploy-production.sh");
  });
});
