/**
 * subtree-guard.mjs — the one function every knowledge-graph TOOL (not gate)
 * routes a write through before it touches disk.
 *
 * ## Why this exists as its own module
 *
 * Issue #11's absolute prohibition is that root automation must never write
 * into `apps/cms/**` — that tree is `ahliweb/awcms`, embedded via
 * `git subtree` (AGENTS.md, "The subtree embed"); a local write there is
 * exactly the kind of change a future `git subtree pull` conflicts with or
 * silently overwrites. `packages/gerbang/audit-graf.mjs` proves this
 * AFTER the fact, by reading `git ls-files` once the tools have already run.
 * This module is the guard BEFORE the fact: every path
 * `tools/knowledge-graph-combine.mjs` and `tools/knowledge-obsidian-export.mjs`
 * write to is resolved and checked here first, so a bug in either tool's own
 * path arithmetic fails loudly at the write site instead of silently
 * succeeding and waiting for the next `audit:graf` run to notice.
 *
 * Pure and side-effect free (no filesystem access of its own — string and
 * path arithmetic only), so `tests/subtree-guard.test.mjs` can drive it with
 * adversarial inputs directly, and `tests/knowledge-no-subtree-write.test.mjs`
 * can prove the real tools actually call it.
 */
import { relative, resolve } from "node:path";

/**
 * Is `candidatePath` inside `apps/cms` relative to `root`?
 *
 * Resolves both to absolute paths first so a caller cannot bypass the check
 * with `..` segments, a trailing slash, or a relative path written a
 * different way than `root` was. `relative()` returning a path that starts
 * with `..`, or an absolute path on a different drive/root entirely, means
 * `candidatePath` is NOT under `root/apps/cms` — anything else means it is.
 *
 * @param {string} candidatePath
 * @param {string} root - repo root `apps/cms` is resolved relative to
 * @returns {boolean}
 */
export function isUnderSubtree(candidatePath, root) {
  const subtree = resolve(root, "apps/cms");
  const target = resolve(root, candidatePath);
  const rel = relative(subtree, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsoluteLike(rel));
}

function isAbsoluteLike(rel) {
  // relative() never returns an absolute path on POSIX when both inputs are
  // resolved, but Windows drive-letter roots can — treat that as "not under
  // subtree" explicitly rather than let a leading "C:\" read as a relative
  // descendant.
  return /^[A-Za-z]:[\\/]/.test(rel);
}

/**
 * Throws if `candidatePath` resolves under `root/apps/cms`. Call this
 * immediately before every `writeFileSync` / `mkdirSync` / `cpSync` /
 * `rmSync` a knowledge-graph TOOL performs, with the exact path about to be
 * written.
 *
 * @param {string} candidatePath
 * @param {string} root
 * @param {string} [context] - what operation this guards, for the error message
 * @returns {string} `candidatePath`, unchanged — so this can wrap a call inline
 */
export function assertNotUnderSubtree(candidatePath, root, context = "write") {
  if (isUnderSubtree(candidatePath, root)) {
    throw new Error(
      `refusing to ${context} "${candidatePath}" — it resolves under apps/cms/, which is ahliweb/awcms embedded via git subtree. ` +
        "This repo's own tooling must never write there; a change that belongs upstream goes through ahliweb/awcms#805 and arrives via `git subtree pull` (AGENTS.md, \"The subtree embed\")."
    );
  }
  return candidatePath;
}
