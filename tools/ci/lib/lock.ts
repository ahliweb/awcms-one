/**
 * lock.ts — the O_EXCL lock file that keeps two `bun run ci:watch` passes
 * from ever overlapping.
 *
 * `flock(1)` is not on every host this might run on (and shells out through
 * a wrapper this codebase would then have to trust); `open(..., O_EXCL)` is
 * a plain, portable, atomic "create or fail if it already exists" the
 * kernel guarantees — the same primitive `flock` itself is built on.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export interface Lock {
  release: () => void;
}

/**
 * Acquire the watch lock, or throw naming the PID already holding it.
 *
 * A stale lock (the PID it names is no longer running) is reclaimed
 * automatically — a watcher killed with SIGKILL leaves its lock file behind
 * with no chance to clean it up, and a permanently-stuck lock is worse than
 * the small risk of two watchers racing right at the reclaim instant, which
 * is guarded by O_EXCL itself.
 *
 * @param {string} path - the lock file path (see state-dir.ts's `lockFilePath`)
 * @returns {Lock}
 * @throws {Error} when a live process already holds the lock
 */
export function acquireLock(path: string): Lock {
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    const heldBy = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (Number.isFinite(heldBy) && isProcessAlive(heldBy)) {
      throw new Error(`Another ci:watch pass (pid ${heldBy}) is already running — refusing to overlap.`);
    }
    // Stale — the PID that held it is gone. Reclaim by unlinking first, then
    // creating fresh, below.
    unlinkSync(path);
  }

  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    throw new Error(`Could not acquire the watch lock at ${path}: ${(error as Error).message}`);
  }
  try {
    Bun.write(path, String(process.pid));
  } finally {
    closeSync(fd);
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        unlinkSync(path);
      } catch {
        // Already gone — nothing left to release.
      }
    }
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
