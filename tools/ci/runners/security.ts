/**
 * runners/security.ts — the `local-ci/security` leg, in place of
 * `.github/workflows/codeql.yml`.
 *
 * Three checks: a SAST scan with OpenGrep (JS/TS, rules vendored at a pinned
 * commit, see `lib/opengrep-cli.ts`), gitleaks (a container image pinned BY
 * DIGEST, never a moving tag), and `bun audit`. CodeQL is NOT used and must not
 * be reintroduced here (ADR-0060; internal cross-portfolio standard DL-098).
 * Fails closed when the scanner cannot be fetched/verified, exits non-zero,
 * reports an engine error, produces no report, or scans zero files; fails on
 * any ERROR-severity finding not in `tools/ci/security-baseline.json`
 * (ruleId + path); and fails while the one-time adoption baseline has not been
 * generated (`lib/sast-baseline.ts`).
 *
 * ## Honest blind spots — this is not CodeQL- or GHAS-equivalent
 *
 *   - OpenGrep is pattern/taint matching on the syntax tree, not CodeQL's
 *     whole-program dataflow: it finds fewer inter-procedural flows, so a
 *     clean run is weaker evidence than a clean CodeQL run was.
 *   - The rules are the vendored JS/TS subset of opengrep-rules (a frozen,
 *     pinned snapshot, no updates until deliberately bumped). Rule quality is
 *     uneven and some rules target frameworks this repo does not use.
 *   - `.astro` files are not scanned (the same limit CodeQL had); JS/TS only.
 *   - Only ERROR findings block; WARNING/INFO ones are counted and kept in the
 *     evidence report, not gated.
 *   - No GitHub code-scanning upload and no alert lifecycle: the scan result
 *     lives in this leg's evidence directory only.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadAuditIgnoreArgs } from "../lib/audit-exceptions.ts";
import { partitionBlockingFindings, parseBaseline } from "../lib/baseline.ts";
import { run } from "../lib/exec.ts";
import { SAST_BASELINE_PATH, ensureOpengrepCli, opengrepScanArgs, opengrepScanEnv } from "../lib/opengrep-cli.ts";
import { parseOpengrepReport } from "../lib/opengrep-json.ts";
import { adoptionBaselinePending } from "../lib/sast-baseline.ts";
import { stateRoot } from "../lib/state-dir.ts";
import type { LegContext, LegOutcome } from "../lib/types.ts";

const GITLEAKS_IMAGE =
  "docker.io/zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";

export async function runSecurityLeg(
  context: string,
  ctx: LegContext
): Promise<LegOutcome> {
  const start = performance.now();
  const { worktreeRoot, evidenceDir } = ctx;
  const log = (name: string) => join(evidenceDir, `${name}.log`);
  const root = stateRoot();

  // ---- 1. SAST (OpenGrep) ------------------------------------------------
  let opengrep: string;
  try {
    opengrep = await ensureOpengrepCli(root);
  } catch (error) {
    return fail(`OpenGrep setup failed: ${(error as Error).message}`);
  }

  // The report is the leg's evidence (kept); the engine writes nothing else here.
  const reportPath = join(evidenceDir, "opengrep-results.json");
  const scan = await run([opengrep, ...opengrepScanArgs(reportPath)], {
    cwd: worktreeRoot,
    env: opengrepScanEnv(),
    logFile: log("opengrep-scan")
  });
  // Exit 0 = scan completed (findings are read from the report, not the exit
  // code); anything else is an engine failure.
  if (scan.exitCode !== 0 || !existsSync(reportPath)) {
    return fail(`opengrep scan failed (exit ${scan.exitCode})`);
  }

  let summary: ReturnType<typeof parseOpengrepReport>;
  let baseline: ReturnType<typeof parseBaseline>;
  try {
    summary = parseOpengrepReport(await Bun.file(reportPath).text());
    baseline = parseBaseline(await Bun.file(join(worktreeRoot, SAST_BASELINE_PATH)).text());
  } catch (error) {
    return fail(`opengrep report or security baseline unreadable: ${(error as Error).message}`);
  }
  if (summary.fatalErrors.length > 0) {
    return fail(`opengrep reported ${summary.fatalErrors.length} engine error(s): ${summary.fatalErrors.slice(0, 3).join("; ")}`);
  }
  if (summary.scannedFiles === 0) return fail("opengrep scanned 0 files (scope or rules misconfigured)");

  const { blocking, baselined, advisory } = partitionBlockingFindings(summary.findings, baseline);

  if (adoptionBaselinePending(worktreeRoot)) {
    return fail(
      `SAST adoption baseline not generated yet (${blocking.length} ERROR finding(s) in ${summary.scannedFiles} files): ` +
        "run `bun tools/ci/cli/sast-baseline.ts` once on the CI server and commit its result (ADR-0060 D4)"
    );
  }

  if (blocking.length > 0) {
    const detail = blocking
      .slice(0, 5)
      .map((f) => `${f.ruleId} @ ${f.path}${f.line ? `:${f.line}` : ""}`)
      .join("; ");
    return fail(`${blocking.length} OpenGrep ERROR finding(s) not in the baseline: ${detail}`);
  }

  // ---- 2. gitleaks (pinned by digest) ------------------------------------
  const gitleaksReport = join(evidenceDir, "gitleaks-report.json");
  const gitleaks = await run(
    [
      "docker",
      "run",
      "--rm",
      "-v",
      `${worktreeRoot}:/repo`,
      "-v",
      `${join(worktreeRoot, "tools", "ci", "gitleaks.toml")}:/gitleaks.toml:ro`,
      GITLEAKS_IMAGE,
      // The image's own ENTRYPOINT is already ["gitleaks"] — an argv
      // element repeating that name makes the container try to run the
      // subcommand "gitleaks" ("unknown command \"gitleaks\" for
      // \"gitleaks\""), so this argv starts directly at the subcommand.
      "detect",
      "--source=/repo",
      "--config=/gitleaks.toml",
      "--no-git",
      "--report-format=json",
      "--report-path=/repo/.gitleaks-report.json",
      "--exit-code=2"
    ],
    { logFile: log("gitleaks") }
  );
  // gitleaks own convention: exit 0 = clean, 1 = error, our chosen 2 = leaks found.
  if (gitleaks.exitCode === 1) return fail("gitleaks failed to run (exit 1)");
  const reportInWorktree = join(worktreeRoot, ".gitleaks-report.json");
  if (existsSync(reportInWorktree)) {
    await Bun.write(gitleaksReport, await Bun.file(reportInWorktree).text());
  }
  if (gitleaks.exitCode === 2) {
    return fail(`gitleaks found potential secret(s) — see ${gitleaksReport}`);
  }

  // ---- 3. bun audit -------------------------------------------------------
  // Same dated, reasoned exceptions `local-ci/check-toko` applies — one list
  // for both legs, read from the commit under test (lib/audit-exceptions.ts).
  const ignore = loadAuditIgnoreArgs(worktreeRoot);
  if (!ignore.ok) {
    return fail(`dependency-audit exception(s) past reviewDate: ${ignore.expired.map((e) => e.advisory).join(", ")}`);
  }
  const audit = await run(["bun", "audit", "--audit-level=low", ...ignore.args], {
    cwd: worktreeRoot,
    logFile: log("bun-audit")
  });
  if (audit.exitCode !== 0) return fail(`bun audit failed (exit ${audit.exitCode})`);

  return {
    context,
    ok: true,
    summary: `OpenGrep ${summary.scannedFiles} files (0 blocking, ${baselined.length} baselined, ${advisory.length} advisory) + gitleaks + bun audit green`,
    durationMs: performance.now() - start,
    evidenceDir
  };

  function fail(summary: string): LegOutcome {
    return { context, ok: false, summary, durationMs: performance.now() - start, evidenceDir };
  }
}
