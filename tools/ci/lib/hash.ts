/**
 * hash.ts — the "CI-definition version" `bun run ci:watch` uses to decide
 * whether a previously recorded result for a (repo, PR, head SHA) still
 * applies.
 *
 * A result recorded for a given commit is only valid for the LOGIC that
 * produced it. If `tools/ci/**` gains a new leg, fixes a bug in an existing
 * one, or `package.json`/`bun.lock` change what a leg installs, a result
 * recorded before that change must not be trusted as "already checked" —
 * so the key those results are stored under includes a hash of exactly
 * that surface.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * List every regular file under `dir`, recursively, sorted, as paths
 * relative to `dir`. Sorted so the hash below is stable across filesystems
 * that return `readdirSync` in a different order.
 */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile()) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/**
 * A stable sha256 over the content of every file under `tools/ci/**`, plus
 * the root `package.json` and `bun.lock` — the whole surface that decides
 * what a leg does and what it installs.
 *
 * @param {string} repoRoot - the repository root (or a disposable worktree of it)
 * @returns {string} `sha256:<hex>`
 */
export function ciDefinitionHash(repoRoot: string): string {
  const hash = createHash("sha256");
  const ciDir = join(repoRoot, "tools", "ci");
  const files = [
    ...listFilesRecursive(ciDir).map((f) => relative(repoRoot, f)),
    "package.json",
    "bun.lock"
  ].sort();

  for (const relPath of files) {
    const full = join(repoRoot, relPath);
    hash.update(relPath);
    hash.update("\0");
    hash.update(readFileSync(full));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
