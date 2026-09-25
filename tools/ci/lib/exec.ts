/**
 * exec.ts — the one way local-ci runners spawn a subprocess that is not
 * git (which goes through `packages/gerbang/lib/git.mjs` instead).
 *
 * Every call here takes an argv array, never a shell string — the same
 * discipline `tests/standar-skrip.test.mjs` enforces for git specifically,
 * applied uniformly so a command's own output (a branch name, a package
 * name) can never be read as shell syntax.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./redact.ts";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Append the redacted combined output to this file as it completes. */
  logFile?: string;
}

/**
 * Run a command (argv array) to completion, capturing its output.
 *
 * @param {string[]} argv - `argv[0]` is the executable, never a shell string
 * @param {RunOptions} [options]
 * @returns {Promise<RunResult>}
 */
export async function run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env as Record<string, string> | undefined,
    stdout: "pipe",
    stderr: "pipe"
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);

  if (options.logFile) {
    mkdirSync(dirname(options.logFile), { recursive: true });
    const header = `$ ${argv.join(" ")}\n`;
    const body = redact(`${stdout}\n${stderr}\n`);
    await Bun.write(options.logFile, header + body);
  }

  return { exitCode, stdout, stderr };
}

/** Convenience: throw with the (redacted) tail of stderr when a command that must succeed does not. */
export async function runOrThrow(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const result = await run(argv, options);
  if (result.exitCode !== 0) {
    const tail = redact(result.stderr.slice(-4000) || result.stdout.slice(-4000));
    throw new Error(`${argv.join(" ")} failed (exit ${result.exitCode}):\n${tail}`);
  }
  return result;
}
