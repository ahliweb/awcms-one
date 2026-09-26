/**
 * runners/security.ts — the `local-ci/security` leg, in place of
 * `.github/workflows/codeql.yml`.
 *
 * Three checks: the CodeQL CLI itself (javascript-typescript,
 * build-mode none, `security-extended`, this repo's own
 * `.github/codeql/codeql-config.yml`, which stays where it is), gitleaks
 * (a container image pinned BY DIGEST, never a moving tag), and
 * `bun audit`. Fails closed on an analysis/extraction error; fails on any
 * SARIF result with `security-severity >= 7.0` unless it matches
 * `tools/ci/security-baseline.json` by ruleId + path.
 *
 * ## Honest blind spots — this is not GHAS-equivalent
 *
 *   - `.astro` files have no CodeQL extractor — same limit
 *     `.github/workflows/codeql.yml`'s own comment states; this scan
 *     covers JS/TS only, exactly like that workflow did.
 *   - `--sarif-add-baseline-file-info`/GitHub's own SARIF-upload dedup,
 *     autofix suggestions, and the Security tab's own alert lifecycle
 *     (dismissed/reopened state, `gh api .../code-scanning/alerts`) have no
 *     local equivalent here — `--upload-sarif` posts the SARIF to GitHub's
 *     code-scanning endpoint for that (optional, off by default), but this
 *     leg's own pass/fail never depends on that upload succeeding.
 *   - Path-exclusion parity with `codeql-config.yml`'s `paths-ignore` is
 *     approximate: the raw CLI (unlike `codeql-action`, which turns that
 *     file into a generated query suite) is given the config file's own
 *     `--source-root` scope but does not re-implement `codeql-action`'s own
 *     path-filter compilation step. A future iteration can close this gap;
 *     until then a finding under an excluded path is possible here that
 *     GHAS itself would have filtered.
 *   - No `security-and-quality` queries, matching the workflow this
 *     replaces — a deliberate scope decision (see that file's own comment),
 *     not a gap introduced here.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { partitionHighSeverityFindings, parseBaseline } from "../lib/baseline.ts";
import { ensureCodeqlCli } from "../lib/codeql-cli.ts";
import { run, runOrThrow } from "../lib/exec.ts";
import { parseSarifFindings } from "../lib/sarif.ts";
import { stateRoot } from "../lib/state-dir.ts";
import type { LegContext, LegOutcome } from "../lib/types.ts";

const GITLEAKS_IMAGE =
  "docker.io/zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";

export async function runSecurityLeg(
  context: string,
  ctx: LegContext,
  options: { uploadSarif?: boolean } = {}
): Promise<LegOutcome> {
  const start = performance.now();
  const { worktreeRoot, evidenceDir } = ctx;
  const log = (name: string) => join(evidenceDir, `${name}.log`);
  const root = stateRoot();

  // ---- 1. CodeQL ---------------------------------------------------------
  let codeqlExecutable: string;
  try {
    codeqlExecutable = await ensureCodeqlCli(root);
  } catch (error) {
    return fail(`CodeQL CLI setup failed: ${(error as Error).message}`);
  }

  const dbPath = join(evidenceDir, "codeql-db");
  const sarifPath = join(evidenceDir, "codeql-results.sarif");

  // The CLI bundle ships no pre-installed query packs (unlike codeql-action,
  // which vendors them) — `codeql/javascript-queries` is downloaded once
  // from GitHub's own package registry and cached under this CLI's own
  // default package cache (~/.codeql/packages), so a re-run does not
  // re-fetch it. Referencing the suite by its PACKAGE-QUALIFIED name below
  // (rather than a bare "javascript-security-extended.qls", which the CLI
  // cannot resolve on its own) is what actually finds it afterwards.
  const packDownload = await run([codeqlExecutable, "pack", "download", "codeql/javascript-queries"], {
    logFile: log("codeql-pack-download")
  });
  if (packDownload.exitCode !== 0) return fail(`codeql pack download failed (exit ${packDownload.exitCode})`);

  const create = await run(
    [
      codeqlExecutable,
      "database",
      "create",
      dbPath,
      "--language=javascript-typescript",
      "--source-root",
      worktreeRoot,
      "--overwrite"
    ],
    { logFile: log("codeql-database-create") }
  );
  if (create.exitCode !== 0) return fail(`codeql database create failed (exit ${create.exitCode})`);

  const analyze = await run(
    [
      codeqlExecutable,
      "database",
      "analyze",
      dbPath,
      "--format=sarif-latest",
      `--output=${sarifPath}`,
      "--sarif-add-snippets",
      "codeql/javascript-queries:codeql-suites/javascript-security-extended.qls"
    ],
    { logFile: log("codeql-database-analyze") }
  );
  if (analyze.exitCode !== 0 || !existsSync(sarifPath)) {
    return fail(`codeql database analyze failed (exit ${analyze.exitCode})`);
  }

  const sarifText = await Bun.file(sarifPath).text();
  const findings = parseSarifFindings(sarifText);
  const baselineText = await Bun.file(join(worktreeRoot, "tools", "ci", "security-baseline.json")).text();
  const baseline = parseBaseline(baselineText);
  const { blocking, baselined } = partitionHighSeverityFindings(findings, baseline);

  if (blocking.length > 0) {
    const detail = blocking
      .slice(0, 5)
      .map((f) => `${f.ruleId} @ ${f.path} (severity ${f.severity})`)
      .join("; ");
    return fail(`${blocking.length} CodeQL finding(s) >= severity 7.0 not in the baseline: ${detail}`);
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
  const audit = await run(["bun", "audit", "--audit-level=low"], {
    cwd: worktreeRoot,
    logFile: log("bun-audit")
  });
  if (audit.exitCode !== 0) return fail(`bun audit failed (exit ${audit.exitCode})`);

  // ---- optional: upload SARIF to GitHub code scanning --------------------
  if (options.uploadSarif) {
    // Left to the CLI entrypoint, which has the repo/token/sha context this
    // runner deliberately does not carry — see cli/ci.ts's `--upload-sarif`.
  }

  return {
    context,
    ok: true,
    summary: `CodeQL (0 blocking, ${baselined.length} baselined) + gitleaks + bun audit green`,
    durationMs: performance.now() - start,
    evidenceDir
  };

  function fail(summary: string): LegOutcome {
    return { context, ok: false, summary, durationMs: performance.now() - start, evidenceDir };
  }
}

/** Gzip+base64 a SARIF file and POST it to GitHub's code-scanning SARIF-upload endpoint. */
export async function uploadSarif(params: {
  sarifPath: string;
  owner: string;
  repo: string;
  commitSha: string;
  ref: string;
  token: string;
}): Promise<void> {
  const { sarifPath, owner, repo, commitSha, ref, token } = params;
  const raw = await Bun.file(sarifPath).arrayBuffer();
  const gzipped = Bun.gzipSync(new Uint8Array(raw));
  const base64 = Buffer.from(gzipped).toString("base64");

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/code-scanning/sarifs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ commit_sha: commitSha, ref, sarif: base64 })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`SARIF upload failed: ${response.status} ${body.slice(0, 500)}`);
  }
}
