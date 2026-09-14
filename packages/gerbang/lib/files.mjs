/**
 * files.mjs — filesystem reads shared by the scripts.
 *
 * `check-docs-translation.mjs` and `docs-i18n-stamp.mjs` are the checker and
 * the stamper for the same translation policy, and both need to answer "does
 * this file exist, and if so what does it say" without treating a missing
 * file as an error. Writing that twice is exactly the kind of duplication
 * that drifts quietly: the stamper would write a tree the checker then reads
 * differently, and the disagreement would surface as "nothing to do" from
 * one and "stale mirror" from the other, with neither message naming the
 * fact that they disagree. One module removes the seam before it can open.
 *
 * It lives here rather than in `docs-i18n-checks.mjs` because that module is
 * pure logic with no I/O, and a file read is exactly the thing that boundary
 * keeps out.
 */

import { readFileSync } from "node:fs";

/**
 * Read a file, or return null when it is not there.
 *
 * Deliberately not `existsSync` + `readFileSync`: that pair is a
 * time-of-check/time-of-use race, and the failure it invites is silent — the
 * check passes, the file disappears, and the read throws in the middle of a
 * multi-file rewrite, leaving the tree half-stamped.
 *
 * Only ENOENT becomes null. A directory, a permission error or a bad symlink
 * rethrows, because each of those means something a caller must not paper
 * over by treating the document as absent.
 *
 * @param {string} path
 * @returns {string | null}
 */
export function readFileIfPresent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}
