/**
 * state-dir.ts — where local CI keeps its own state: locks, per-(repo, PR,
 * SHA, CI-definition) results, evidence (logs, SARIF, Playwright reports),
 * and the watcher's records.
 *
 * Never under the repo (ADR-0021 D6): a disposable worktree is deleted after
 * a run, and the developer's own checkout should carry nothing local CI
 * wrote. `${XDG_STATE_HOME:-~/.local/state}/awcms-one-ci/` follows the XDG
 * Base Directory spec's own definition of "state data that should persist
 * between application invocations, but is not important enough for the user
 * to back it up" — exactly what a CI evidence/result cache is.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** The root directory all local-ci state lives under. */
export function stateRoot(env: Record<string, string | undefined> = process.env): string {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".local", "state");
  return join(base, "awcms-one-ci");
}

/** Subdirectory for the cross-run lock file (`bun run ci:watch`'s O_EXCL/flock guard). */
export function lockFilePath(env?: Record<string, string | undefined>): string {
  return join(stateRoot(env), "watch.lock");
}

/** Subdirectory for a given run's evidence (logs, SARIF, Playwright reports, screenshots). */
export function evidenceDir(runId: string, env?: Record<string, string | undefined>): string {
  return join(stateRoot(env), "evidence", runId);
}

/** Subdirectory holding recorded results, keyed by {@link resultKey}. */
export function resultsDir(env?: Record<string, string | undefined>): string {
  return join(stateRoot(env), "results");
}

/**
 * The key identifying one (repo, PR, head SHA, CI-definition version)
 * combination — `bun run ci:watch`'s own de-duplication key, and the file
 * name a recorded result is written under.
 *
 * Including the CI-definition hash means a change to `tools/ci/**` itself
 * (a new leg, a fixed bug in a leg) invalidates every previously recorded
 * result for the same commit, so the watcher re-runs it instead of trusting
 * a result produced under different logic.
 */
export function resultKey(params: {
  owner: string;
  repo: string;
  pr: number;
  sha: string;
  ciDefinitionVersion: string;
}): string {
  const { owner, repo, pr, sha, ciDefinitionVersion } = params;
  return `${owner}__${repo}__${pr}__${sha}__${ciDefinitionVersion}`;
}
