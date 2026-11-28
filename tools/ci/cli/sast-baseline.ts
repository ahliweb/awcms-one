#!/usr/bin/env bun
/**
 * `bun tools/ci/cli/sast-baseline.ts` — generate the one-time ADOPTION baseline
 * of the `local-ci/security` OpenGrep scan (ADR-0060 D4; `lib/sast-baseline.ts`).
 *
 * Run once, on the CI server, from a clean checkout of the commit under review,
 * at the repository root. It scans the tree exactly as the leg does (same
 * pinned binary, same vendored rules, same excludes), writes every ERROR
 * finding to `tools/ci/security-baseline.json` and deletes
 * `tools/ci/sast/ADOPTION-BASELINE-PENDING`. It refuses (exit 2) when that
 * marker is absent or the baseline is not empty: it never adds to an existing
 * baseline. Nothing is posted anywhere; the result is a working-tree change for
 * a human to triage, then commit together with `BASELINE_CEILING` in
 * `tests/local-ci-baseline.test.mjs` set to the printed entry count.
 *
 * Exit codes: 0 written; 2 refused or tool failure (download, checksum,
 * engine error, zero files scanned).
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitRunOrThrow } from "../../../packages/gerbang/lib/git.mjs";
import { parseBaseline } from "../lib/baseline.ts";
import { run } from "../lib/exec.ts";
import {
  OPENGREP_VERSION,
  SAST_BASELINE_PATH,
  ensureOpengrepCli,
  opengrepScanArgs,
  opengrepScanEnv
} from "../lib/opengrep-cli.ts";
import { parseOpengrepReport } from "../lib/opengrep-json.ts";
import {
  ADOPTION_MARKER_PATH,
  adoptionBaselinePending,
  buildAdoptionBaseline,
  generatorRefusal,
  withTempDir
} from "../lib/sast-baseline.ts";
import { stateRoot } from "../lib/state-dir.ts";

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function main(): Promise<number> {
  const root = process.cwd();
  if (!existsSync(join(root, "tools", "ci", "legs.ts"))) {
    console.error("sast-baseline: run this from the repository root.");
    return 2;
  }
  const baselineFile = join(root, SAST_BASELINE_PATH);
  const refusal = generatorRefusal(adoptionBaselinePending(root), parseBaseline(await Bun.file(baselineFile).text()));
  if (refusal) {
    console.error(`sast-baseline: refused: ${refusal}`);
    return 2;
  }
  // The scan reads the working tree, so the tree must be exactly the commit:
  // an untracked or modified file would end up in (or hide from) the baseline.
  const dirty = gitRunOrThrow(root, "status", "--porcelain", "--untracked-files=all").trim();
  if (dirty !== "") {
    console.error("sast-baseline: refused: the working tree is not clean (git status --porcelain is not empty).");
    return 2;
  }
  const sha = gitRunOrThrow(root, "rev-parse", "HEAD").trim();

  const opengrep = await ensureOpengrepCli(stateRoot());
  return withTempDir("sast-baseline-", async (dir) => {
    const reportPath = join(dir, "opengrep-results.json");
    const started = performance.now();
    const scan = await run([opengrep, ...opengrepScanArgs(reportPath)], { cwd: root, env: opengrepScanEnv() });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (scan.exitCode !== 0 || !existsSync(reportPath)) {
      console.error(`sast-baseline: opengrep scan failed (exit ${scan.exitCode}):\n${scan.stderr.slice(-2000)}`);
      return 2;
    }
    const summary = parseOpengrepReport(await Bun.file(reportPath).text());
    if (summary.fatalErrors.length > 0) {
      console.error(`sast-baseline: opengrep reported engine error(s): ${summary.fatalErrors.slice(0, 3).join("; ")}`);
      return 2;
    }
    if (summary.scannedFiles === 0) {
      console.error("sast-baseline: opengrep scanned 0 files (scope or rules misconfigured).");
      return 2;
    }
    const counts = { ERROR: 0, WARNING: 0, INFO: 0 };
    for (const finding of summary.findings) counts[finding.severity]++;
    const entries = buildAdoptionBaseline(summary.findings, today());

    writeFileSync(baselineFile, `${JSON.stringify(entries, null, 2)}\n`);
    rmSync(join(root, ADOPTION_MARKER_PATH));

    console.log(`sast-baseline: OpenGrep ${OPENGREP_VERSION} at ${sha}, ${summary.scannedFiles} files in ${seconds} s`);
    console.log(`sast-baseline: findings ERROR=${counts.ERROR} WARNING=${counts.WARNING} INFO=${counts.INFO}`);
    console.log(`sast-baseline: wrote ${entries.length} (ruleId, path) entr${entries.length === 1 ? "y" : "ies"} to ${SAST_BASELINE_PATH}; deleted ${ADOPTION_MARKER_PATH}`);
    console.log(`sast-baseline: next: triage every entry, set BASELINE_CEILING = ${entries.length} in tests/local-ci-baseline.test.mjs, commit the three changes together`);
    return 0;
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`sast-baseline: ${(error as Error).message}`);
    process.exitCode = 2;
  });
