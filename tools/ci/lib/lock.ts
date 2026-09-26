/**
 * lock.ts — the O_EXCL lock file that keeps two `bun run ci:watch` passes
 * from ever overlapping.
 *
 * `flock(1)` is not on every host this might run on (and shells out through
 * a wrapper this codebase would then have to trust); `open(..., O_EXCL)` is
 * a plain, portable, atomic "create or fail if it already exists" the
 * kernel guarantees — the same primitive `flock` itself is built on.
 */
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface Lock {
  release: () => void;
}

/** Creates the lock file exclusively and writes this PID through that same fd; false if it already exists. */
function tryCreate(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new Error(`Could not acquire the watch lock at ${path}: ${(error as Error).message}`);
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return true;
}

/** The PID a lock file names, or undefined when the file is gone or unreadable. */
function readHolder(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Acquire the watch lock, or throw naming the PID already holding it.
 *
 * Creation is `open(..., O_EXCL)` first, never a check-then-create. A stale
 * lock (its PID is no longer running — a watcher killed with SIGKILL cannot
 * clean up) is reclaimed by atomically renaming it aside and then checking
 * that the file actually moved names the dead PID. Two passes can find the
 * same stale lock at once; if the loser's rename catches the winner's FRESH
 * lock instead, the check fails, the winner's lock is put back with
 * `link` (which never overwrites a newer lock), and the loser refuses.
 * The systemd unit is a oneshot service, so systemd itself never starts a
 * second pass while one runs; this lock guards manual runs beside it.
 *
 * @param {string} path - the lock file path (see state-dir.ts's `lockFilePath`)
 * @returns {Lock}
 * @throws {Error} when a live process already holds the lock
 */
export function acquireLock(path: string): Lock {
  mkdirSync(dirname(path), { recursive: true });

  if (!tryCreate(path)) {
    const heldBy = readHolder(path);
    if (heldBy !== undefined && isProcessAlive(heldBy)) {
      throw new Error(`Another ci:watch pass (pid ${heldBy}) is already running — refusing to overlap.`);
    }
    const aside = `${path}.stale.${process.pid}`;
    try {
      renameSync(path, aside);
    } catch {
      throw new Error(`The watch lock at ${path} changed while reclaiming it — another pass is starting; refusing to overlap.`);
    }
    const moved = readHolder(aside);
    if (moved !== heldBy) {
      try {
        linkSync(aside, path);
      } catch {
        // A newer lock already exists; the one set aside is superseded.
      }
      unlinkSync(aside);
      throw new Error(`Another ci:watch pass (pid ${moved}) took the watch lock first — refusing to overlap.`);
    }
    unlinkSync(aside);
    if (!tryCreate(path)) {
      throw new Error(`Another ci:watch pass took the watch lock at ${path} first — refusing to overlap.`);
    }
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
