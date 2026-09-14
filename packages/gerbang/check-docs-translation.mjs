#!/usr/bin/env bun
/**
 * check-docs-translation.mjs — documentation translation gates.
 *
 * ENGLISH at the bare path is the source; Indonesian at `<name>.id.md` is the
 * mirror, and the mirror records the hash of the English it was translated
 * from. The mechanism is adopted whole from `ahliweb/media-lenterakalteng`
 * (itself adapting `ahliweb/awcms`'s own scheme); what differs here is the
 * scope (see `isInScope` in `lib/docs-i18n-checks.mjs`) and the ledger below.
 *
 * Two questions, kept separate on purpose (see `lib/docs-i18n-checks.mjs`):
 * whether an existing mirror is CURRENT, and which documents have NO mirror
 * yet.
 *
 * Pure logic lives in `packages/gerbang/lib/docs-i18n-checks.mjs`; this file
 * does I/O and exit codes. Run: `bun run audit:translation`.
 */
import { join, resolve } from "node:path";
import {
  checkMirrorCoverage,
  checkTranslationPair,
  deriveSourcePath,
  isInScope,
  isMirrorInScope
} from "./lib/docs-i18n-checks.mjs";
import { readFileIfPresent } from "./lib/files.mjs";
import { gitLines, gitRun } from "./lib/git.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

/** @typedef {import("./lib/docs-i18n-checks.mjs").Problem} Problem */

/**
 * Documents still awaiting their Indonesian mirror.
 *
 * **This list may only SHRINK.** Removing an entry is how progress is
 * recorded; the gate rejects an entry whose mirror now exists, so the
 * ledger cannot overstate the debt and quietly stop being believed. Nothing
 * new may be added: a document written in this repo is written in English
 * and mirrored in the same change.
 *
 * It starts empty — every governance document this repository ships lands
 * with its Indonesian mirror already in place.
 */
export const DOCS_AWAITING_MIRROR = [];

/**
 * Every tracked-or-new markdown path, from git.
 *
 * `--others --exclude-standard` so a document added in THIS change is
 * judged before it is committed. Plain `git ls-files` sees only tracked
 * files, so a brand-new document would pass unexamined and fail for
 * whoever ran the gate next.
 *
 * @param {string} pattern
 * @returns {string[]}
 */
function gitList(pattern) {
  const output = gitRun(
    ROOT,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    pattern
  );

  // Not a git repo (a tarball, `git archive`, a vendored copy). This gate
  // cannot be answered there, and a gate that dies with a
  // `node:child_process` stack naming neither itself nor the cause costs
  // whoever hits it real time.
  if (output === null) {
    console.log("audit:translation SKIPPED — not a git repo, `git ls-files` cannot run.");
    process.exit(0);
  }

  return gitLines(output);
}

/** @returns {string[]} English documents in scope. */
function listSources() {
  return gitList("*.md").filter(isInScope);
}

/**
 * @returns {string[]} `.id.md` mirrors present on disk, IN SCOPE.
 *
 * Untracked mirrors included, for the same reason as `listSources`: a pair
 * created in this change must be judged now.
 *
 * `.filter(isMirrorInScope)` matters here specifically, not only in
 * principle: without it this function returns every `.id.md` in the
 * working tree, including the hundreds that belong to `apps/cms`
 * (`ahliweb/awcms`, imported via `git subtree`) — its own mirrors, in its
 * own convention, that this repo does not own and cannot fix from here.
 */
function listMirrors() {
  return gitList("*.id.md").filter(isMirrorInScope);
}

/** @returns {Problem[]} */
export function runChecks() {
  /** @type {Problem[]} */
  const problems = [];
  const mirrors = listMirrors();

  for (const mirrorPath of mirrors) {
    const sourcePath = deriveSourcePath(mirrorPath);
    if (!sourcePath) continue;

    const mirrorContent = readFileIfPresent(join(ROOT, mirrorPath));
    if (mirrorContent === null) continue;

    problems.push(
      ...checkTranslationPair(
        sourcePath,
        readFileIfPresent(join(ROOT, sourcePath)),
        mirrorPath,
        mirrorContent
      )
    );
  }

  problems.push(
    ...checkMirrorCoverage(listSources(), new Set(mirrors), DOCS_AWAITING_MIRROR)
  );

  return problems;
}

if (import.meta.main) {
  const problems = runChecks();

  if (problems.length > 0) {
    console.error(`audit:translation FAILED — ${problems.length} finding(s):`);
    for (const p of problems) console.error(`  - ${p.file}: ${p.message}`);
    process.exit(1);
  }

  const mirrored = listMirrors().length;
  console.log(
    `audit:translation OK — ${mirrored} mirror(s) current against their ` +
      `English source; ${DOCS_AWAITING_MIRROR.length} document(s) on the ` +
      `shrink-only translation ledger.`
  );
}
