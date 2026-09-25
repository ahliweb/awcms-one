/**
 * worktree.ts — a disposable `git worktree` checked out at an exact SHA,
 * for `bun run ci` / `bun run ci:pr` to run legs inside.
 *
 * Never mutate the developer's own checkout: `template:init` rewrites files
 * in place (AGENTS.md), and several legs run real installs/builds. A
 * disposable worktree gives every run its own working tree, sharing the
 * repo's object store (so it is cheap to create) but never touching the
 * caller's index or working files.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRunOrThrow } from "../../../packages/gerbang/lib/git.mjs";

export interface DisposableWorktree {
  path: string;
  sha: string;
  /** Remove the worktree (and its directory) unless `keep` was requested. */
  cleanup: () => void;
}

/**
 * Create a disposable worktree of `repoRoot` at `sha`, in a fresh temp
 * directory. `keep: true` skips cleanup (the `--keep` flag), leaving the
 * directory for the operator to inspect.
 *
 * @param {string} repoRoot - a real git checkout (the caller's own, never mutated)
 * @param {string} sha - the exact commit to check out
 * @param {{ keep?: boolean; label?: string }} [options]
 * @returns {DisposableWorktree}
 */
export function createDisposableWorktree(
  repoRoot: string,
  sha: string,
  options: { keep?: boolean; label?: string } = {}
): DisposableWorktree {
  const dir = mkdtempSync(join(tmpdir(), `awcms-one-ci-${options.label ?? "run"}-`));
  // A worktree cannot be created directly INTO an existing empty directory
  // with git < some versions in all cases, but mkdtemp's directory is empty
  // and git worktree add accepts an existing empty target — this is the
  // same approach apps/cms's own tooling has no equivalent of, written fresh
  // here.
  gitRunOrThrow(repoRoot, "worktree", "add", "--detach", dir, sha);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (options.keep) return;
    try {
      gitRunOrThrow(repoRoot, "worktree", "remove", "--force", dir);
    } catch {
      // The worktree metadata may already be gone (e.g. the directory was
      // removed by hand) — fall back to a plain directory removal so
      // cleanup never throws over something already cleaned up.
      rmSync(dir, { recursive: true, force: true });
    }
  };

  return { path: dir, sha, cleanup };
}
