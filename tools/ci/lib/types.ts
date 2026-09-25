/** Shared types for a leg's execution — what a runner returns to the CLI, which then reports it as a commit status. */

export interface LegOutcome {
  context: string;
  ok: boolean;
  /** Short, <=140-char summary — what a commit status's `description` becomes. */
  summary: string;
  /** Wall-clock milliseconds this leg took. */
  durationMs: number;
  /** Where this leg's logs/evidence were written, for a human to open. */
  evidenceDir?: string;
}

export interface LegContext {
  /** The disposable worktree's absolute path — every leg runs with this as its effective repo root. */
  worktreeRoot: string;
  /** Where to write this leg's own logs/evidence. */
  evidenceDir: string;
}
