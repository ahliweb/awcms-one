/**
 * exec.ts — the one way local-ci runners spawn a subprocess that is not
 * git (which goes through `packages/gerbang/lib/git.mjs` instead).
 *
 * Every call here takes an argv array, never a shell string — the same
 * discipline `tests/standar-skrip.test.mjs` enforces for git specifically,
 * applied uniformly so a command's own output (a branch name, a package
 * name) can never be read as shell syntax.
 *
 * A step may carry a wall-clock budget (`timeoutMs`, issue #532). Without
 * one a hung step (a container that never becomes healthy, a browser that
 * never exits) hangs the whole run forever; with one the step's whole
 * process group is terminated and the step FAILS, so the caller returns a
 * failed leg outcome and the orchestrator still posts a failure status.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./redact.ts";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the step was terminated because it outlived `RunOptions.timeoutMs`. */
  timedOut?: boolean;
  /** The budget that was exceeded, in whole seconds (set together with `timedOut`). */
  timeoutSeconds?: number;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Append the redacted combined output to this file as it completes. */
  logFile?: string;
  /**
   * Wall-clock budget in milliseconds. When it passes, the whole process
   * GROUP gets SIGTERM, then SIGKILL after `killGraceMs`, and the result
   * carries `timedOut: true`. Omitted means no limit (the old behaviour).
   */
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL. Defaults to {@link DEFAULT_KILL_GRACE_MS}. */
  killGraceMs?: number;
}

export const DEFAULT_KILL_GRACE_MS = 10_000;

/** Exit code reported for a timed-out step (the one coreutils `timeout` uses). */
export const TIMEOUT_EXIT_CODE = 124;

/** How long to keep reading the output pipes after the group was killed (a process that escaped the group could hold them open). */
const OUTPUT_DRAIN_MS = 5_000;

/** The env variable that scales every default step budget, for slow machines. */
export const TIMEOUT_SCALE_ENV = "LOCAL_CI_TIMEOUT_SCALE";

/**
 * A default budget in minutes, multiplied by `LOCAL_CI_TIMEOUT_SCALE` (a
 * positive number, default 1), returned in milliseconds. A set but invalid
 * value throws rather than silently running with no limit.
 */
export function stepBudgetMs(defaultMinutes: number, env: Record<string, string | undefined> = process.env): number {
  const raw = env[TIMEOUT_SCALE_ENV]?.trim();
  let scale = 1;
  if (raw) {
    scale = Number(raw);
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new Error(`${TIMEOUT_SCALE_ENV} must be a positive number, got "${raw}"`);
    }
  }
  return Math.round(defaultMinutes * 60_000 * scale);
}

/** One-line failure summary for a step: "<name> timed out after N s" or "<name> failed (exit N)". */
export function describeFailure(name: string, result: RunResult): string {
  if (result.timedOut) return `${name} timed out after ${result.timeoutSeconds} s`;
  return `${name} failed (exit ${result.exitCode})`;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone (ESRCH), or was never created.
  }
}

/**
 * Run a command (argv array) to completion, capturing its output.
 *
 * @param {string[]} argv - `argv[0]` is the executable, never a shell string
 * @param {RunOptions} [options]
 * @returns {Promise<RunResult>}
 */
export async function run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const hasBudget = options.timeoutMs !== undefined;
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env as Record<string, string> | undefined,
    stdout: "pipe",
    stderr: "pipe",
    // A step with a budget leads its own process group (setsid), so the
    // timeout can signal the step AND every child it started.
    detached: hasBudget
  });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const termTimer = hasBudget
    ? setTimeout(() => {
        timedOut = true;
        signalGroup(proc.pid, "SIGTERM");
        killTimer = setTimeout(() => signalGroup(proc.pid, "SIGKILL"), options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
      }, options.timeoutMs)
    : undefined;

  const outputs = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  let exitCode = await proc.exited;
  clearTimeout(termTimer);
  clearTimeout(killTimer);
  // The leader may exit on SIGTERM while a child ignores it: sweep the group
  // so no descendant outlives a timed-out step.
  if (timedOut) signalGroup(proc.pid, "SIGKILL");

  let stdout = "";
  let stderr = "";
  if (timedOut) {
    const drained = await Promise.race([
      outputs,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), OUTPUT_DRAIN_MS))
    ]);
    if (drained) [stdout, stderr] = drained;
    exitCode = TIMEOUT_EXIT_CODE;
  } else {
    [stdout, stderr] = await outputs;
  }

  const result: RunResult = { exitCode, stdout, stderr };
  if (timedOut) {
    result.timedOut = true;
    result.timeoutSeconds = Math.round((options.timeoutMs as number) / 1000);
  }

  if (options.logFile) {
    mkdirSync(dirname(options.logFile), { recursive: true });
    const header = `$ ${argv.join(" ")}\n`;
    const note = timedOut ? `[local-ci] timed out after ${result.timeoutSeconds} s; process group terminated\n` : "";
    const body = redact(`${stdout}\n${stderr}\n`);
    await Bun.write(options.logFile, header + note + body);
  }

  return result;
}

/** Convenience: throw with the (redacted) tail of stderr when a command that must succeed does not. */
export async function runOrThrow(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const result = await run(argv, options);
  if (result.exitCode !== 0) {
    const tail = redact(result.stderr.slice(-4000) || result.stdout.slice(-4000));
    const what = result.timedOut ? `timed out after ${result.timeoutSeconds} s` : `failed (exit ${result.exitCode})`;
    throw new Error(`${argv.join(" ")} ${what}:\n${tail}`);
  }
  return result;
}
