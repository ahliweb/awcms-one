/**
 * proc.mjs — the one way this tool spawns an external process.
 *
 * Every call here is `Bun.spawnSync([cmd, ...args], ...)` — an argv array,
 * never a shell string. `packages/gerbang/lib/git.mjs`'s own docblock names
 * the exact injection this avoids: a value that could contain `$(...)`, a
 * backtick, `;`, `&`, or `|` (a tag name, a digest, an image reference) must
 * never be interpolated into a string a shell then re-parses. This module
 * generalises that same shape to every command this tool runs — `docker`,
 * `cosign` (via `docker run`), `trivy` (via `docker run`), and `gh` — not
 * only `git`.
 */

/**
 * @param {string[]} argv - e.g. `["docker", "buildx", "build", ...]`
 * @param {{ cwd?: string, env?: Record<string,string> }} [opts]
 * @returns {{ ok: boolean, stdout: string, stderr: string, code: number }}
 */
export function runCapture(argv, opts = {}) {
  const result = Bun.spawnSync(argv, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    code: result.exitCode
  };
}

/**
 * As {@link runCapture}, but streams to the terminal and throws on failure —
 * for the long-running, human-watched steps (`docker buildx build`, `trivy`,
 * `cosign sign`) where swallowing output would hide the only feedback a
 * multi-minute build gives.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, env?: Record<string,string> }} [opts]
 * @returns {void}
 * @throws {Error} carrying the argv and exit code when the process fails
 */
export function runInherit(argv, opts = {}) {
  const result = Bun.spawnSync(argv, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdout: "inherit",
    stderr: "inherit"
  });
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed (exit ${result.exitCode})`);
  }
}

/**
 * As {@link runCapture}, but throws on failure — for a step whose stdout is
 * needed programmatically (e.g. `docker buildx imagetools inspect --format
 * '{{json .}}'`) and whose failure must stop the run rather than be silently
 * treated as an empty answer.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, env?: Record<string,string> }} [opts]
 * @returns {string} stdout
 * @throws {Error} carrying stderr when the process fails
 */
export function runCaptureOrThrow(argv, opts = {}) {
  const result = runCapture(argv, opts);
  if (!result.ok) {
    throw new Error(`${argv.join(" ")} failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}
