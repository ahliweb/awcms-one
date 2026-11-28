/**
 * The SAST leg's pins and inputs (`tools/ci/lib/opengrep-cli.ts`,
 * `tools/ci/lib/opengrep-json.ts`, `tools/ci/sast/`): the binary pin and its
 * verified download, the vendored rules matching their recorded upstream commit
 * exactly, the report parser's fail-closed severity handling, and CodeQL
 * staying removed (ADR-0060; internal cross-portfolio standard DL-098). No test
 * here reaches the network: the download test serves its own bytes from
 * 127.0.0.1.
 */
import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  OPENGREP_LINUX_X86_SHA256,
  OPENGREP_VERSION,
  SAST_EXCLUDES,
  SAST_RULES_DIR,
  ensureOpengrepCli,
  opengrepCacheDir,
  opengrepScanArgs,
  opengrepScanEnv,
  sastJobs,
  sha256File
} from "../tools/ci/lib/opengrep-cli.ts";
import { normalizeRuleId, parseOpengrepReport } from "../tools/ci/lib/opengrep-json.ts";

const RULES_COMMIT = "f1d2b562b414783763fd02a6ed2736eaed622efa";
const RULES_FILE_COUNT = 203;

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out.sort();
}

/** The git blob id of a file: sha1("blob <size>\0" + content). */
function gitBlobSha(path) {
  const content = readFileSync(path);
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

describe("OpenGrep pin", () => {
  test("version and sha256 are the reviewed pair", () => {
    assert.equal(OPENGREP_VERSION, "v2.1.0");
    assert.equal(OPENGREP_LINUX_X86_SHA256, "d6a68a84c01a3d8ee933f60847decf1b4d0fd7791a26833b32b95922baf28974");
    assert.match(OPENGREP_LINUX_X86_SHA256, /^[0-9a-f]{64}$/);
  });

  test("the scan reads only the vendored rules, offline, and excludes them from the target", () => {
    const args = opengrepScanArgs("/tmp/out.json");
    assert.ok(args.includes(`--config=${SAST_RULES_DIR}`));
    assert.ok(args.includes("--disable-version-check"));
    assert.ok(args.includes(`--exclude=${SAST_RULES_DIR}`));
    for (const pattern of SAST_EXCLUDES) assert.ok(args.includes(`--exclude=${pattern}`), pattern);
    assert.equal(args.filter((a) => a.startsWith("--config=")).length, 1);
    assert.ok(!args.some((a) => a.startsWith("--config=p/") || a.startsWith("--config=r/") || a.includes("semgrep.dev")));
    assert.equal(args.at(-1), ".");
  });

  test("telemetry is off through the environment, never through a --metrics flag", () => {
    assert.equal(opengrepScanEnv({ PATH: "/bin" }).SEMGREP_SEND_METRICS, "off");
    assert.equal(opengrepScanEnv({ PATH: "/bin" }).PATH, "/bin");
    assert.equal(opengrepScanEnv({ SEMGREP_SEND_METRICS: "on" }).SEMGREP_SEND_METRICS, "off");
    assert.ok(!opengrepScanArgs("/tmp/o.json").some((a) => a.startsWith("--metrics")));
  });
});

describe("scan worker count", () => {
  test("follows CI_LOKAL_CPUS when it is an integer >= 1, otherwise 5", () => {
    assert.equal(sastJobs({}), 5);
    assert.equal(sastJobs({ CI_LOKAL_CPUS: "2" }), 2);
    assert.equal(sastJobs({ CI_LOKAL_CPUS: " 5 " }), 5);
    for (const bad of ["0", "-1", "1.5", "abc", ""]) assert.equal(sastJobs({ CI_LOKAL_CPUS: bad }), 5, bad);
  });

  test("the scan argv carries --jobs once, and an explicit count wins", () => {
    assert.ok(opengrepScanArgs("/tmp/o.json", 3).includes("--jobs=3"));
    assert.equal(opengrepScanArgs("/tmp/o.json").filter((a) => a.startsWith("--jobs=")).length, 1);
  });
});

describe("verified download (ensureOpengrepCli)", () => {
  const payload = new TextEncoder().encode("#!/bin/sh\necho fake-opengrep\n");
  const goodSha = createHash("sha256").update(payload).digest("hex");
  let server;
  let requests = 0;
  let url;
  let state;

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests++;
        if (new URL(request.url).pathname !== "/opengrep_linux_x86") return new Response("not found", { status: 404 });
        return new Response(payload);
      }
    });
    url = `http://127.0.0.1:${server.port}/opengrep_linux_x86`;
    state = mkdtempSync(join(tmpdir(), "local-ci-opengrep-test-"));
  });

  afterAll(() => {
    server.stop(true);
    rmSync(state, { recursive: true, force: true });
  });

  const exe = () => join(opengrepCacheDir(state), "opengrep");

  test("a digest mismatch keeps nothing: no executable, no .part file", async () => {
    await assert.rejects(
      ensureOpengrepCli(state, { url, sha256: "0".repeat(64), skipPlatformCheck: true }),
      /checksum mismatch/
    );
    assert.equal(existsSync(exe()), false);
    assert.equal(existsSync(`${exe()}.part`), false);
  });

  test("a matching digest is renamed into place, executable, with no .part left behind", async () => {
    const path = await ensureOpengrepCli(state, { url, sha256: goodSha, skipPlatformCheck: true });
    assert.equal(path, exe());
    assert.equal(await sha256File(path), goodSha);
    assert.equal(statSync(path).mode & 0o111, 0o111);
    assert.equal(existsSync(`${path}.part`), false);
  });

  test("a verified cached binary is reused without downloading again", async () => {
    const before = requests;
    await ensureOpengrepCli(state, { url, sha256: goodSha, skipPlatformCheck: true });
    assert.equal(requests, before);
  });

  test("a tampered cached binary is never run: it is re-downloaded and re-verified", async () => {
    writeFileSync(exe(), "tampered");
    const before = requests;
    const path = await ensureOpengrepCli(state, { url, sha256: goodSha, skipPlatformCheck: true });
    assert.equal(requests, before + 1);
    assert.equal(await sha256File(path), goodSha);
  });

  test("a failed download fails closed and leaves nothing executable", async () => {
    const empty = mkdtempSync(join(tmpdir(), "local-ci-opengrep-test-"));
    try {
      await assert.rejects(
        ensureOpengrepCli(empty, { url: `http://127.0.0.1:${server.port}/missing`, sha256: goodSha, skipPlatformCheck: true }),
        /Downloading OpenGrep failed: 404/
      );
      assert.deepEqual(readdirSync(opengrepCacheDir(empty)), []);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("vendored rules", () => {
  // `git ls-tree -r` format, one `<mode> blob <sha>\t<path>` per line, hash first.
  const lock = { files: {} };
  for (const line of readFileSync("tools/ci/sast/rules.lock", "utf8").split("\n")) {
    if (line === "") continue;
    const match = /^100644 blob ([0-9a-f]{40})\t(\S+)$/.exec(line);
    assert.ok(match, `malformed lock line: ${line}`);
    lock.files[match[2]] = match[1];
  }

  test("the lock holds the full file count (the commit itself is recorded in the README)", () => {
    assert.equal(Object.keys(lock.files).length, RULES_FILE_COUNT + 1); // + LICENSE
  });

  test("the vendored tree is exactly the commit's file list (.yaml and .yml) plus LICENSE", () => {
    const present = filesUnder(SAST_RULES_DIR)
      .map((p) => relative(SAST_RULES_DIR, p))
      .filter((p) => p !== "README.md");
    assert.deepEqual(present, Object.keys(lock.files).sort());
    const rules = present.filter((p) => /\.(yaml|yml)$/.test(p));
    assert.equal(rules.length, RULES_FILE_COUNT);
    for (const p of rules) assert.ok(p.startsWith("javascript/") || p.startsWith("typescript/"), p);
    for (const p of rules) assert.ok(!/\.(test|fixed)\.ya?ml$/.test(p), `test fixture vendored as a rule: ${p}`);
    assert.ok(rules.some((p) => p.endsWith(".yml")), "the .yml rule files are included");
  });

  test("every file is byte-identical to its upstream blob", () => {
    for (const [path, blob] of Object.entries(lock.files)) {
      assert.equal(gitBlobSha(join(SAST_RULES_DIR, path)), blob, path);
    }
  });

  test("the provenance README records the commit, the count and the licence", () => {
    const readme = readFileSync(join(SAST_RULES_DIR, "README.md"), "utf8");
    assert.ok(readme.includes(RULES_COMMIT));
    assert.ok(readme.includes(`${RULES_FILE_COUNT} rule files`));
    assert.match(readFileSync(join(SAST_RULES_DIR, "LICENSE"), "utf8"), /Commons Clause/);
  });

  test("this repository has no root GitHub Actions workflow, so no workflow rules are vendored", () => {
    assert.equal(existsSync(".github/workflows"), false);
    assert.equal(existsSync(join(SAST_RULES_DIR, "yaml")), false);
  });
});

describe("report parsing", () => {
  const report = (results, extra = {}) => JSON.stringify({ results, errors: [], paths: { scanned: ["a.ts"] }, ...extra });

  test("strips the config-directory prefix from rule ids", () => {
    assert.equal(normalizeRuleId("tools.ci.sast.rules.javascript.x.y"), "javascript.x.y");
    assert.equal(normalizeRuleId("other.rule"), "other.rule");
  });

  test("maps severities, and treats an unknown severity as ERROR", () => {
    const { findings } = parseOpengrepReport(
      report([
        { check_id: "r1", path: "a.ts", start: { line: 3 }, extra: { severity: "WARNING", message: "m" } },
        { check_id: "r2", path: "b.ts", extra: { severity: "ERROR" } },
        { check_id: "r3", path: "c.ts", extra: { severity: "CRITICAL" } },
        { check_id: "r4", path: "d.ts", extra: {} }
      ])
    );
    assert.deepEqual(findings.map((f) => f.severity), ["WARNING", "ERROR", "ERROR", "ERROR"]);
    assert.equal(findings[0].line, 3);
  });

  test("only level-error engine errors are fatal; syntax-error warnings are not", () => {
    const summary = parseOpengrepReport(
      report([], { errors: [{ level: "warn", type: "Syntax error", path: "x.ts" }, { level: "error", type: "Rule parse error", message: "bad" }] })
    );
    assert.equal(summary.fatalErrors.length, 1);
    assert.match(summary.fatalErrors[0], /Rule parse error/);
  });

  test("counts scanned files so an empty scan can fail closed", () => {
    assert.equal(parseOpengrepReport(report([])).scannedFiles, 1);
    assert.equal(parseOpengrepReport(JSON.stringify({ results: [] })).scannedFiles, 0);
  });

  test("a report that is not JSON throws, so the leg fails closed", () => {
    assert.throws(() => parseOpengrepReport("not json"));
  });
});

describe("CodeQL stays removed", () => {
  test("no CodeQL CLI module, config, SARIF upload or import remains in the CI tooling", () => {
    assert.equal(existsSync("tools/ci/lib/codeql-cli.ts"), false);
    assert.equal(existsSync("tools/ci/lib/sarif.ts"), false);
    assert.equal(existsSync(".github/codeql"), false);
    const security = readFileSync("tools/ci/runners/security.ts", "utf8");
    assert.ok(!/from "\.\.\/lib\/codeql/.test(security));
    assert.ok(!/ensureCodeqlCli|database create|uploadSarif|code-scanning\/sarifs/.test(security));
    const cli = readFileSync("tools/ci/cli/ci.ts", "utf8");
    assert.ok(!/upload-sarif|uploadSarif/.test(cli));
  });
});
