#!/usr/bin/env bun
/**
 * Runs the BPS population pipeline province by province (issue #497).
 *
 *   bun tools/bps-population/pipeline.ts [--once]
 *
 * Once at start it runs one archive pass (it frees disk taken by earlier
 * provinces). Then, on each pass, it reads `$BPS_CACHE_DIR/progress.log`, takes
 * every province with a `PROVINCE-DONE` line that the pipeline has not finished,
 * and for each in order:
 *   1. `extract/run.ts --from-state --province <code>`
 *   2. only on exit 0: `archive.ts --commit --include-unextracted`
 * Both exit codes and timestamps are saved to `$BPS_CACHE_DIR/pipeline-state.json`
 * (atomic writes) and every step is appended to `$BPS_CACHE_DIR/pipeline.log`.
 * A failing extract is not archived. A province that fails MAX_ATTEMPTS times is
 * marked `stuck` and skipped from then on. Without `--once`, passes repeat every
 * PASS_INTERVAL_MS until SIGTERM or SIGINT, which kills any running step and exits cleanly.
 *
 * Configuration (environment only):
 *   BPS_ARCHIVE_REMOTE   rclone remote and path (required; checked the same way archive.ts checks it)
 *   BPS_CACHE_DIR        default ~/.cache/awcms-bps-population
 *
 * Every child process is an argv array through Bun.spawn; no shell is involved.
 * The decision logic is pure and exported; the step runner is injected for tests.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normaliseRemoteRoot } from "./archive.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTRACT_SCRIPT = path.join(REPO_ROOT, "tools", "bps-population", "extract", "run.ts");
const ARCHIVE_SCRIPT = path.join(REPO_ROOT, "tools", "bps-population", "archive.ts");

export const PROGRESS_LOG_NAME = "progress.log";
export const PIPELINE_STATE_NAME = "pipeline-state.json";
export const PIPELINE_LOG_NAME = "pipeline.log";
/** A province that fails this many times in a row is marked stuck and no longer retried. */
export const MAX_ATTEMPTS = 3;
export const PASS_INTERVAL_MS = 10 * 60 * 1000;

export type ProvinceStatus = "pending" | "done" | "stuck";

export type ProvinceState = {
  status: ProvinceStatus;
  attempts: number;
  extractedAt: string | null;
  extractExit: number | null;
  archivedAt: string | null;
  archiveExit: number | null;
};

export type PipelineState = {
  version: 1;
  processed: Record<string, ProvinceState>;
};

export type StepResult = { code: number; stdout: string; stderr: string };
export type StepRunner = (argv: readonly string[]) => Promise<StepResult>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Province codes from `PROVINCE-DONE <code> ...` lines, in first-seen order and
 * without duplicates. A code is exactly two digits.
 */
export function parseProgressProvinces(logText: string): string[] {
  const codes: string[] = [];
  for (const line of logText.split(/\r?\n/)) {
    const match = /(?:^|\s)PROVINCE-DONE (\d{2})(?=\s|$)/.exec(line);
    if (match && !codes.includes(match[1]!)) codes.push(match[1]!);
  }
  return codes;
}

export function emptyPipelineState(): PipelineState {
  return { version: 1, processed: {} };
}

function freshProvinceState(): ProvinceState {
  return { status: "pending", attempts: 0, extractedAt: null, extractExit: null, archivedAt: null, archiveExit: null };
}

/**
 * Parses pipeline-state.json. Blank text is an empty state. Anything else that
 * is not a well-formed version-1 state throws, so the file is never silently reset.
 */
export function parsePipelineState(text: string | null): PipelineState {
  if (text === null || text.trim().length === 0) return emptyPipelineState();
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error("pipeline-state.json must hold a JSON object.");
  const root = parsed as { version?: unknown; processed?: unknown };
  if (root.version !== 1) throw new Error("pipeline-state.json has an unsupported version.");
  if (typeof root.processed !== "object" || root.processed === null || Array.isArray(root.processed)) {
    throw new Error("pipeline-state.json has no processed map.");
  }
  const processed: Record<string, ProvinceState> = {};
  for (const [code, value] of Object.entries(root.processed as Record<string, unknown>)) {
    processed[code] = parseProvinceState(code, value);
  }
  return { version: 1, processed };
}

function parseProvinceState(code: string, value: unknown): ProvinceState {
  const v = value as Partial<ProvinceState> | null;
  const nullableString = (x: unknown) => x === null || typeof x === "string";
  const nullableExit = (x: unknown) => x === null || (typeof x === "number" && Number.isInteger(x));
  if (
    typeof v !== "object" ||
    v === null ||
    (v.status !== "pending" && v.status !== "done" && v.status !== "stuck") ||
    typeof v.attempts !== "number" ||
    !Number.isInteger(v.attempts) ||
    v.attempts < 0 ||
    !nullableString(v.extractedAt) ||
    !nullableExit(v.extractExit) ||
    !nullableString(v.archivedAt) ||
    !nullableExit(v.archiveExit)
  ) {
    throw new Error(`pipeline-state.json entry for province ${code} is malformed.`);
  }
  return {
    status: v.status,
    attempts: v.attempts,
    extractedAt: v.extractedAt ?? null,
    extractExit: v.extractExit ?? null,
    archivedAt: v.archivedAt ?? null,
    archiveExit: v.archiveExit ?? null
  };
}

export function provinceStateOf(state: PipelineState, code: string): ProvinceState {
  return state.processed[code] ?? freshProvinceState();
}

/**
 * The done provinces that still need work, in the order they finished. A
 * province is finished once archived (`done`) and given up on once `stuck`.
 */
export function pendingProvinces(doneCodes: readonly string[], state: PipelineState): string[] {
  return doneCodes.filter((code) => provinceStateOf(state, code).status === "pending");
}

/** The first pending province, or null when there is nothing to do. */
export function nextProvince(doneCodes: readonly string[], state: PipelineState): string | null {
  return pendingProvinces(doneCodes, state)[0] ?? null;
}

function withProvince(state: PipelineState, code: string, next: ProvinceState): PipelineState {
  return { version: 1, processed: { ...state.processed, [code]: next } };
}

/** Records an extract attempt. A non-zero exit counts; the MAX_ATTEMPTS-th failure marks the province stuck. */
export function recordExtract(state: PipelineState, code: string, exit: number, at: string): PipelineState {
  const prev = provinceStateOf(state, code);
  const attempts = exit === 0 ? prev.attempts : prev.attempts + 1;
  return withProvince(state, code, {
    ...prev,
    status: exit !== 0 && attempts >= MAX_ATTEMPTS ? "stuck" : "pending",
    attempts,
    extractedAt: at,
    extractExit: exit
  });
}

/** Records an archive attempt. Exit 0 finishes the province; a failure counts like an extract failure. */
export function recordArchive(state: PipelineState, code: string, exit: number, at: string): PipelineState {
  const prev = provinceStateOf(state, code);
  const attempts = exit === 0 ? prev.attempts : prev.attempts + 1;
  let status: ProvinceStatus = "pending";
  if (exit === 0) status = "done";
  else if (attempts >= MAX_ATTEMPTS) status = "stuck";
  return withProvince(state, code, { ...prev, status, attempts, archivedAt: at, archiveExit: exit });
}

export function extractStepArgv(code: string): string[] {
  return [process.execPath, EXTRACT_SCRIPT, "--from-state", "--province", code];
}

export function archiveStepArgv(): string[] {
  return [process.execPath, ARCHIVE_SCRIPT, "--commit", "--include-unextracted"];
}

/** One log line per step: time, step, province (or "-"), exit code, and the last useful line of output. */
export function formatLogLine(at: string, step: string, code: string, result: StepResult): string {
  const source = result.code === 0 ? result.stdout : result.stderr || result.stdout;
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const tail = lines.length > 0 ? lines[lines.length - 1]!.slice(0, 300) : "";
  return `${at} ${step} ${code} exit=${result.code}${tail ? ` ${tail}` : ""}`;
}

// ---------------------------------------------------------------------------
// One pass, with injected effects
// ---------------------------------------------------------------------------

export type PassContext = {
  doneCodes: readonly string[];
  initialState: PipelineState;
  saveState: (state: PipelineState) => Promise<void>;
  runStep: StepRunner;
  log: (line: string) => Promise<void>;
  now: () => string;
  stopRequested: () => boolean;
};

/**
 * Works through the pending provinces once, in order. Each province gets one
 * extract attempt and, when that exits 0, one archive attempt. A stop request is
 * checked before every step; a step interrupted by it is not recorded, so the
 * province is simply pending again on the next start.
 */
export async function runProvincePass(ctx: PassContext): Promise<PipelineState> {
  let state = ctx.initialState;
  for (const code of pendingProvinces(ctx.doneCodes, state)) {
    if (ctx.stopRequested()) break;
    const extract = await ctx.runStep(extractStepArgv(code));
    if (ctx.stopRequested()) break;
    state = recordExtract(state, code, extract.code, ctx.now());
    await ctx.saveState(state);
    await ctx.log(formatLogLine(ctx.now(), "extract", code, extract));
    if (extract.code !== 0) continue;

    const archive = await ctx.runStep(archiveStepArgv());
    if (ctx.stopRequested()) break;
    state = recordArchive(state, code, archive.code, ctx.now());
    await ctx.saveState(state);
    await ctx.log(formatLogLine(ctx.now(), "archive", code, archive));
  }
  return state;
}

// ---------------------------------------------------------------------------
// Impure edges: files, child processes, signals
// ---------------------------------------------------------------------------

let activeStep: ReturnType<typeof Bun.spawn> | null = null;

/** Runs one step as an argv array, keeping a handle so a signal can stop it. */
export async function runStepProcess(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<StepResult> {
  const proc = Bun.spawn([...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  activeStep = proc;
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } finally {
    activeStep = null;
  }
}

function killActiveStep(): void {
  activeStep?.kill();
}

async function readOptional(filePath: string): Promise<string | null> {
  return existsSync(filePath) ? readFile(filePath, "utf8") : null;
}

async function loadState(statePath: string): Promise<PipelineState> {
  return parsePipelineState(await readOptional(statePath));
}

async function saveState(statePath: string, state: PipelineState): Promise<void> {
  const tmp = `${statePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, statePath);
}

function sleep(ms: number, onWake: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    onWake(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const USAGE = "usage: pipeline.ts [--once]";

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const unknown = argv.filter((arg) => arg !== "--once");
  if (unknown.length > 0) {
    console.error(`unknown argument "${unknown[0]}". ${USAGE}`);
    return 2;
  }
  const once = argv.includes("--once");

  const remoteCheck = normaliseRemoteRoot(env.BPS_ARCHIVE_REMOTE);
  if (!remoteCheck.ok) {
    console.error(remoteCheck.reason);
    return 2;
  }

  const cacheDir = env.BPS_CACHE_DIR && env.BPS_CACHE_DIR.trim().length > 0
    ? path.resolve(env.BPS_CACHE_DIR)
    : path.join(homedir(), ".cache", "awcms-bps-population");
  await mkdir(cacheDir, { recursive: true });
  const progressPath = path.join(cacheDir, PROGRESS_LOG_NAME);
  const statePath = path.join(cacheDir, PIPELINE_STATE_NAME);
  const logPath = path.join(cacheDir, PIPELINE_LOG_NAME);
  const childEnv = { ...env, BPS_CACHE_DIR: cacheDir };

  let stopRequested = false;
  let wake: (() => void) | null = null;
  const onSignal = () => {
    stopRequested = true;
    killActiveStep();
    wake?.();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const now = () => new Date().toISOString();
  const log = (line: string) => appendFile(logPath, `${line}\n`, "utf8");
  const runStep: StepRunner = (argv) => runStepProcess(argv, childEnv, REPO_ROOT);

  console.log(`[pipeline] cache: ${cacheDir}`);
  console.log(`[pipeline] remote: ${remoteCheck.remote}`);
  try {
    if (!stopRequested) {
      const archive = await runStep(archiveStepArgv());
      await log(formatLogLine(now(), "archive-start", "-", archive));
      console.log(`[pipeline] start archive pass exit=${archive.code}`);
    }
    while (!stopRequested) {
      const state = await loadState(statePath);
      const doneCodes = parseProgressProvinces((await readOptional(progressPath)) ?? "");
      await runProvincePass({
        doneCodes,
        initialState: state,
        saveState: (next) => saveState(statePath, next),
        runStep,
        log,
        now,
        stopRequested: () => stopRequested
      });
      if (once || stopRequested) break;
      await sleep(PASS_INTERVAL_MS, (w) => {
        wake = w;
      });
      wake = null;
    }
  } catch (error) {
    console.error(`[pipeline] stopped: ${(error as Error).message}`);
    return 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  console.log(stopRequested ? "[pipeline] stopped on signal" : "[pipeline] done");
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
