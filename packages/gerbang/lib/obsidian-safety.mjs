/**
 * obsidian-safety.mjs — pure validation behind `knowledge:obsidian:export`'s
 * staging → validate → allowlist-sync boundary.
 *
 * ## The boundary this module exists to hold
 *
 * Issue #11, Scope §4: Obsidian is "an optional developer knowledge/
 * navigation layer, not a source of truth", and a human vault root must
 * never be `graphify export obsidian`'s direct `--obsidian-dir` target — the
 * wrapper (`tools/knowledge-obsidian-export.mjs`) is the safety boundary
 * against an upstream exporter regression, not a courtesy. Concretely:
 *
 *   1. graphify writes into a STAGING directory
 *      (`graphify-out/obsidian-staging/`, gitignored, ephemeral) — never
 *      directly into `knowledge/generated/graphify/`.
 *   2. Every entry graphify wrote is validated by this module.
 *   3. Only entries that pass are copied into
 *      `knowledge/generated/graphify/` — an ALLOWLIST, not a denylist: an
 *      entry this module does not recognise as safe is excluded, not
 *      assumed safe.
 *   4. `knowledge/curated/` is never a sync target — it is checked only for
 *      a NAME COLLISION, never written to.
 *
 * ## What each function guards against
 *
 *   - `classifyEntry` — a symlink (an escape vector: its target is not
 *     necessarily under staging, and following it at sync time could copy
 *     or overwrite anything the process can read/write), an unexpected
 *     extension (anything but `.md`/`.canvas`), or a KNOWN graphify
 *     housekeeping path (`.graphify_obsidian_manifest.json`, any
 *     `.obsidian/` segment) — the last two are excluded from sync WITHOUT
 *     being a hard failure, because graphify legitimately writes them as
 *     part of normal, trusted operation. Anything else unrecognised is a
 *     hard failure: an export that produced something this module has never
 *     seen is worth stopping to look at, not silently dropping.
 *   - `resolveWithin` — the "zip slip" guard, used twice: once while
 *     WALKING staging (an entry whose real path — after resolving any `..`
 *     segments — is not still under the staging root did not come from a
 *     well-behaved export), and once while computing each SYNC destination
 *     (a crafted or corrupted entry name must not resolve outside
 *     `knowledge/generated/graphify/`).
 *   - `checkCuratedCollision` — a generated note may never carry the same
 *     filename as a hand-written curated one; `knowledge/curated/` is
 *     checked, never overwritten.
 *
 * Pure and filesystem-free: every function takes already-gathered strings
 * (a relative path, a boolean "is this a symlink", a set of existing
 * basenames) and returns a plain verdict, so `tests/obsidian-safety.test.mjs`
 * can drive every rejection case as a literal value with no real staging
 * tree, symlink, or `graphify` installation needed.
 */
import { relative, resolve, sep } from "node:path";

export const ALLOWED_EXTENSIONS = new Set([".md", ".canvas"]);

/** Basenames graphify itself writes as export bookkeeping — skipped, not synced, never a failure. */
const KNOWN_HOUSEKEEPING_BASENAMES = new Set([".graphify_obsidian_manifest.json"]);

/**
 * @param {string} relativePath - POSIX-style, relative to the staging root
 * @returns {string}
 */
function basenameOf(relativePath) {
  const parts = relativePath.split("/");
  return parts[parts.length - 1] ?? relativePath;
}

/**
 * @param {string} basename
 * @returns {string} the extension including its dot, or "" when there is none
 */
function extensionOf(basename) {
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot);
}

/** @typedef {{ action: "sync" } | { action: "skip", reason: string } | { action: "reject", reason: string }} Verdict */

/**
 * Classify one staging entry. Called only for regular files (the caller
 * decides what "is this a symlink" means for its own filesystem — see
 * `tools/knowledge-obsidian-export.mjs`, which uses `lstatSync`).
 *
 * @param {string} relativePath - POSIX-style, relative to the staging root
 * @param {boolean} isSymlink
 * @returns {Verdict}
 */
export function classifyEntry(relativePath, isSymlink) {
  if (isSymlink) {
    return {
      action: "reject",
      reason: "is a symlink — its target may resolve outside the staging directory, and this boundary does not follow symlinks at all"
    };
  }

  const segments = relativePath.split("/");
  if (segments.includes(".obsidian")) {
    return { action: "skip", reason: "Obsidian app workspace/session state, never generated content" };
  }

  const basename = basenameOf(relativePath);
  if (KNOWN_HOUSEKEEPING_BASENAMES.has(basename)) {
    return { action: "skip", reason: "graphify's own export bookkeeping, not a note" };
  }

  const ext = extensionOf(basename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      action: "reject",
      reason: `has an unexpected extension "${ext || "(none)"}" — only ${[...ALLOWED_EXTENSIONS].join(", ")} are allowlisted for sync`
    };
  }

  return { action: "sync" };
}

/**
 * Resolve `relativePath` against `root` and confirm the result is still
 * under `root` — the traversal / symlink-escape / output-outside-staging
 * guard, usable both for "is this staging entry really inside staging" and
 * "does this sync destination really land inside the generated dir".
 *
 * @param {string} root - absolute path
 * @param {string} relativePath
 * @returns {{ ok: true, absolute: string } | { ok: false, reason: string }}
 */
export function resolveWithin(root, relativePath) {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, relativePath);
  const rel = relative(absoluteRoot, target);

  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsoluteLike(rel)) {
    return { ok: false, reason: `"${relativePath}" resolves outside ${root} — path traversal` };
  }

  return { ok: true, absolute: target };
}

function isAbsoluteLike(rel) {
  return /^[A-Za-z]:[\\/]/.test(rel);
}

/**
 * A generated note/canvas may never share a filename with a hand-written
 * curated one — `knowledge/curated/` is thin and specific (issue #11, Scope
 * §5) precisely because it is never touched by automation.
 *
 * @param {string} basename
 * @param {ReadonlySet<string>} curatedBasenames
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkCuratedCollision(basename, curatedBasenames) {
  if (curatedBasenames.has(basename)) {
    return {
      ok: false,
      reason: `"${basename}" collides with a hand-written file already in knowledge/curated/ — generated output never overwrites curated content`
    };
  }
  return { ok: true };
}
