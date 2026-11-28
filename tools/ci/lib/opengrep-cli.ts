/**
 * opengrep-cli.ts — fetching and verifying the OpenGrep SAST binary the
 * `local-ci/security` leg runs, and the fixed scope/arguments of that run.
 *
 * Why OpenGrep, and why not CodeQL (ADR-0060): CodeQL is not run anywhere in
 * this portfolio, public repositories included (owner decision of 2026-11-27,
 * internal cross-portfolio standard DL-098). This repository is public, where
 * the CodeQL CLI licence would allow it, but it is a template: the repository
 * a product is created from is usually private, where the GitHub CodeQL Terms
 * and Conditions forbid the CLI without a paid GitHub Advanced Security
 * licence, and one SAST path for the template and every derived repository is
 * the point. OpenGrep's ENGINE is LGPL-2.1
 * (https://github.com/opengrep/opengrep/blob/main/LICENSE: "The act of running
 * a program using the Library is not restricted"), and the RULES this leg runs
 * are vendored under `tools/ci/sast/rules/` from opengrep/opengrep-rules at a
 * pinned commit (LGPL-2.1 with the Commons Clause condition, which only
 * withholds the right to SELL the software — see `tools/ci/sast/rules/README.md`).
 * Rules from the Semgrep registry are NOT used: they sit under the "Semgrep
 * Rules License v1.0" (internal business use only, no redistribution), which a
 * vendored, pinned copy in a public repository would breach.
 *
 * Pinned to an exact release and verified by sha256 (never trusted on URL
 * alone), cached under the state directory so a re-run does not re-download
 * ~160 MB. The download goes to a `.part` file and is renamed only after the
 * checksum matches, so a partial or tampered file is never executable here;
 * a cached binary is re-verified before every use.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";

/** Bump deliberately: re-download, re-verify the digest on the release page, and re-run the baseline. */
export const OPENGREP_VERSION = "v2.1.0";
/** sha256 of the `opengrep_linux_x86` release asset (the release's own asset digest, re-computed from a real download). */
export const OPENGREP_LINUX_X86_SHA256 = "d6a68a84c01a3d8ee933f60847decf1b4d0fd7791a26833b32b95922baf28974";
const ASSET = "opengrep_linux_x86";
const DOWNLOAD_URL = `https://github.com/opengrep/opengrep/releases/download/${OPENGREP_VERSION}/${ASSET}`;

/** Where the vendored rules live, relative to the repo root, and the prefix the engine puts in every rule id. */
export const SAST_RULES_DIR = "tools/ci/sast/rules";
export const SAST_RULE_ID_PREFIX = "tools.ci.sast.rules.";

/** The committed baseline of triaged ERROR findings, relative to the repo root (see `lib/baseline.ts`). */
export const SAST_BASELINE_PATH = "tools/ci/security-baseline.json";

/**
 * What is NOT scanned: the same set as the removed `.github/codeql/codeql-config.yml`
 * `paths-ignore` (dependency/build output, generated or vendored datasets, tool
 * run artefacts, the machine-generated knowledge graph), plus the vendored rules.
 * apps/cms SOURCE stays in scope. A bare name matches at any depth.
 */
export const SAST_EXCLUDES: readonly string[] = [
  "node_modules",
  "dist",
  ".astro",
  "graphify-out",
  "apps/cms/src/lib/i18n/catalogs/*.generated.ts",
  "bun.lock",
  "apps/cms/data",
  "redesign",
  "playwright-report",
  "test-results",
  "blob-report",
  SAST_RULES_DIR
];

export function opengrepCacheDir(stateRoot: string): string {
  return join(stateRoot, "opengrep", OPENGREP_VERSION);
}

/** sha256 of a file, streamed (the binary is ~160 MB). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Ensure the pinned OpenGrep binary is present and verified under `stateRoot`.
 * Returns the path to the executable. Fails closed on an unsupported platform,
 * a failed download or a checksum mismatch. `options` exist for the unit test
 * (a local file URL and a fake digest); the leg always uses the defaults.
 */
export async function ensureOpengrepCli(
  stateRoot: string,
  options: { url?: string; sha256?: string; skipPlatformCheck?: boolean } = {}
): Promise<string> {
  const url = options.url ?? DOWNLOAD_URL;
  const expected = options.sha256 ?? OPENGREP_LINUX_X86_SHA256;
  if (!options.skipPlatformCheck && (platform() !== "linux" || arch() !== "x64")) {
    throw new Error(
      `No pinned OpenGrep binary for ${platform()}/${arch()} (only linux/x64 is pinned). ` +
        "Run this leg on a linux/x64 host, or add a verified pin for this platform."
    );
  }
  const cacheDir = opengrepCacheDir(stateRoot);
  const executable = join(cacheDir, "opengrep");
  // A cached binary is trusted only after it re-verifies: a truncated or
  // replaced file in the cache must not run just because it exists.
  if (existsSync(executable) && (await sha256File(executable)) === expected) return executable;

  mkdirSync(cacheDir, { recursive: true });
  const partPath = `${executable}.part`;
  rmSync(partPath, { force: true });
  rmSync(executable, { force: true });

  const response = await fetch(url, { signal: AbortSignal.timeout(45 * 60 * 1000) });
  if (!response.ok) {
    throw new Error(`Downloading OpenGrep failed: ${response.status} ${url}`);
  }
  await Bun.write(partPath, response);

  const actual = await sha256File(partPath);
  if (actual !== expected) {
    rmSync(partPath, { force: true });
    throw new Error(
      `OpenGrep download checksum mismatch: expected ${expected}, got ${actual}. ` +
        "Refusing to keep and run an unverified binary."
    );
  }
  chmodSync(partPath, 0o755);
  renameSync(partPath, executable);
  return executable;
}

/**
 * Worker count: `CI_LOKAL_CPUS` (the owner's local-CI wrapper quota) when set to
 * an integer >= 1, otherwise 5. OpenGrep's own default is 16, far above the CPU
 * quota of the owner's workstation (5 vCPU, internal cross-portfolio standard DL-099).
 */
export function sastJobs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CI_LOKAL_CPUS;
  if (raw !== undefined && /^[0-9]+$/.test(raw.trim())) {
    const value = Number.parseInt(raw.trim(), 10);
    if (value >= 1) return value;
  }
  return 5;
}

/**
 * The fixed argv of the scan, run with `cwd` = the tree under test and target `.`.
 * No network after the pinned download: the version check is off and the
 * rules are the vendored directory. There is no `--metrics` option: OpenGrep
 * v2.1.0 rejects it ("unknown option", exit 2); telemetry is switched off by
 * {@link opengrepScanEnv} instead.
 */
export function opengrepScanArgs(jsonOutputPath: string, jobs = sastJobs()): string[] {
  return [
    "scan",
    `--config=${SAST_RULES_DIR}`,
    "--disable-version-check",
    // Without this the engine applies its built-in default ignore list (tests/,
    // vendor/ and similar), narrower than the CodeQL scope this leg replaces.
    // An unstable `--x-` flag: re-check it whenever OPENGREP_VERSION is bumped.
    "--x-ignore-semgrepignore-files",
    `--jobs=${jobs}`,
    "--json",
    `--json-output=${jsonOutputPath}`,
    "--quiet",
    ...SAST_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
    "."
  ];
}

/** The scan's environment: the caller's, with telemetry off (belt and braces; never a `--metrics` flag). */
export function opengrepScanEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return { ...env, SEMGREP_SEND_METRICS: "off" };
}
