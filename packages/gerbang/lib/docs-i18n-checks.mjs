/**
 * docs-i18n-checks.mjs — pure logic for the documentation translation gates.
 *
 * ## Direction
 *
 * ENGLISH at the bare path `<name>.md` is the **authoritative source**,
 * written and edited by hand. Indonesian at `<name>.id.md` is the
 * **mirror**. The mirror carries `<!-- i18n-source-hash: sha256:<hex> -->`
 * recording the hash of the English source it was translated from; when the
 * English source changes and the mirror is not re-translated, the recorded
 * hash stops matching and the gate fails naming the stale file.
 *
 * This convention — including the choice to put the marker on the mirror
 * rather than on the source — is adopted whole from
 * `ahliweb/media-lenterakalteng` (its own `packages/gerbang/lib/docs-i18n-checks.mjs`,
 * itself adapted from `ahliweb/awcms`'s original scheme). The placement is
 * the decision rather than a detail: a marker on the source side goes stale
 * on every source edit, which makes the copy a reader or an agent opens by
 * default — the bare, unsuffixed path — the copy allowed to drift.
 * `apps/cms` (this repo's own embedded copy of `ahliweb/awcms`) carries the
 * same banner-and-marker convention on its own documents; this module does
 * not govern them (see `isMirrorInScope` below).
 *
 * ## Two questions, deliberately separate
 *
 * `checkTranslationPair` answers **"is this mirror current?"** — a
 * consistency question about a pair that already exists.
 *
 * `checkMirrorCoverage` answers **"which documents have no mirror at all?"**
 * — a coverage question. Fusing them would produce a gate that reads green
 * while most of the corpus is untranslated, because a document with no
 * mirror has no pair to be stale.
 *
 * Neither function translates anything. There is no translation API call
 * anywhere in this repo's gates: they DETECT drift, and translation is done
 * by hand in the same change that caused it.
 */

import { createHash } from "node:crypto";

/** @typedef {{ file: string, message: string }} Problem */

export const MARKER_REGEX =
  /<!--\s*i18n-source-hash:\s*(sha256:[0-9a-f]{64})\s*-->/;

/**
 * Is this path a document mirrored by the policy?
 *
 * Kept as a pure predicate rather than inlined into the git call so it can
 * be tested directly — a written scope rule is worth exactly as much as its
 * own checker, same as any other rule in this repo. Scope that is wrong in
 * one direction lets a document skip the policy silently; wrong in the
 * other, it demands a mirror for a file nobody reads as documentation.
 *
 * In scope: `docs/**`, `.changesets/README.md`, and the SHOUTING root
 * documents (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`, …) — including
 * `AGENTS.md` itself, this repo's working contract and the first document
 * an agent loads.
 *
 * Out of scope, each for its own reason:
 *
 *   - `CHANGELOG.md` — an append-only record of what was said at the time it
 *     was said. Re-translating history on every release would rewrite the
 *     record.
 *   - `.changesets/*.md` other than its README — ephemeral by construction:
 *     `bun run release` folds them into `CHANGELOG.md` and deletes them, so
 *     a mirror would outlive its source by exactly one release.
 *   - `apps/cms/**` — `ahliweb/awcms`, embedded via `git subtree` with its
 *     own translation convention and its own gates. Not this repo's tree to
 *     govern; a `git subtree pull` that carries a stale mirror there is
 *     upstream's to fix, not a finding here.
 *
 * @param {string} path - repo-relative path
 * @returns {boolean}
 */
export function isInScope(path) {
  if (!path.endsWith(".md")) return false;
  if (path.endsWith(".id.md")) return false;
  if (path === "CHANGELOG.md") return false;
  if (path.startsWith("apps/cms/")) return false;
  if (path.startsWith(".changesets/") && path !== ".changesets/README.md") {
    return false;
  }

  return (
    path.startsWith("docs/") ||
    path === ".changesets/README.md" ||
    /^[A-Z][A-Z_]*\.md$/.test(path)
  );
}

/**
 * Hash of the ENGLISH source content. The mirror records this value.
 *
 * @param {string} sourceContent
 * @returns {string} `sha256:<hex>`
 */
export function computeSourceHash(sourceContent) {
  return `sha256:${createHash("sha256").update(sourceContent).digest("hex")}`;
}

/**
 * @param {string} mirrorContent
 * @returns {string | null}
 */
export function extractRecordedHash(mirrorContent) {
  const match = mirrorContent.match(MARKER_REGEX);
  return match ? (match[1] ?? null) : null;
}

/**
 * `docs/x.md` → `docs/x.id.md`.
 *
 * @param {string} sourcePath
 * @returns {string | null} null when `sourcePath` is not a bare `.md` source.
 */
export function deriveMirrorPath(sourcePath) {
  if (!sourcePath.endsWith(".md")) return null;
  if (sourcePath.endsWith(".id.md")) return null;
  return `${sourcePath.slice(0, -".md".length)}.id.md`;
}

/**
 * `docs/x.id.md` → `docs/x.md`.
 *
 * @param {string} mirrorPath
 * @returns {string | null} null when `mirrorPath` is not a `.id.md` mirror.
 */
export function deriveSourcePath(mirrorPath) {
  if (!mirrorPath.endsWith(".id.md")) return null;
  return `${mirrorPath.slice(0, -".id.md".length)}.md`;
}

/**
 * Is this `.id.md` path a mirror THIS repo's translation gate answers for?
 *
 * `isInScope` above answers the question for a SOURCE path and deliberately
 * returns `false` for anything ending `.id.md` — a mirror is never itself a
 * "document mirrored by the policy", it is the mirror. Answering the mirror
 * side of the same question by derived source
 * (`isInScope(deriveSourcePath(m))`) rather than re-stating the scope rules
 * a second time matters concretely: `ahliweb/media-lenterakalteng` found its
 * two call sites (the coverage pass and the staleness/orphan pass) had
 * drifted apart — one filtered through `isInScope`, the other did not — and
 * the unfiltered pass walked every `.id.md` in the working tree, including
 * hundreds belonging to its own embedded `apps/cms`. It was silently correct
 * only because upstream's mirrors happened to be current the day it was
 * checked. Both call sites in this repo share this one predicate instead.
 *
 * @param {string} mirrorPath
 * @returns {boolean}
 */
export function isMirrorInScope(mirrorPath) {
  const sourcePath = deriveSourcePath(mirrorPath);
  return sourcePath !== null && isInScope(sourcePath);
}

/**
 * Is this mirror current with its English source?
 *
 * @param {string} sourcePath
 * @param {string | null} sourceContent - null when the English source is absent.
 * @param {string} mirrorPath
 * @param {string} mirrorContent
 * @returns {Problem[]}
 */
export function checkTranslationPair(
  sourcePath,
  sourceContent,
  mirrorPath,
  mirrorContent
) {
  /** @type {Problem[]} */
  const problems = [];

  // An orphan mirror is reported against the MIRROR, not against the missing
  // source: the file that exists is the one a reader can open and act on.
  if (sourceContent === null) {
    problems.push({
      file: mirrorPath,
      message: `Indonesian mirror with no English source (${sourcePath} does not exist). English is the source language — either restore the source or delete the orphan mirror.`
    });
    return problems;
  }

  const recorded = extractRecordedHash(mirrorContent);
  if (!recorded) {
    problems.push({
      file: mirrorPath,
      message: `no <!-- i18n-source-hash: sha256:... --> marker — add it, recording the hash of ${sourcePath}, after translating.`
    });
    return problems;
  }

  const current = computeSourceHash(sourceContent);
  if (recorded !== current) {
    problems.push({
      file: mirrorPath,
      message: `stale mirror — ${sourcePath} changed since this was translated (marker ${recorded}, source is now ${current}). Re-translate, then update the marker.`
    });
  }

  return problems;
}

/**
 * Which English documents are missing their Indonesian mirror?
 *
 * `awaitingMirror` is a **shrink-only ledger**: a document may sit on it
 * while its translation is outstanding, and removing an entry is how
 * progress is recorded. A document NOT on the ledger and without a mirror is
 * a violation, and so is a ledger entry for a document that now HAS one — a
 * ledger that overstates the debt is a ledger nobody believes.
 *
 * This repo starts the ledger empty: every governance document lands with
 * its mirror in the same change, so there is no outstanding debt to record
 * on day one. See `check-docs-translation.mjs`'s `DOCS_AWAITING_MIRROR`.
 *
 * @param {string[]} sourcePaths - tracked English documents in scope.
 * @param {Set<string>} existingMirrors - `.id.md` paths present on disk.
 * @param {readonly string[]} awaitingMirror - the shrink-only ledger.
 * @returns {Problem[]}
 */
export function checkMirrorCoverage(
  sourcePaths,
  existingMirrors,
  awaitingMirror
) {
  /** @type {Problem[]} */
  const problems = [];
  const ledger = new Set(awaitingMirror);
  const inScope = new Set(sourcePaths);

  for (const sourcePath of sourcePaths) {
    const mirrorPath = deriveMirrorPath(sourcePath);
    if (mirrorPath === null) continue;
    if (existingMirrors.has(mirrorPath)) continue;
    if (ledger.has(sourcePath)) continue;

    problems.push({
      file: sourcePath,
      message: `no Indonesian mirror (${mirrorPath}) and not on the awaiting-translation ledger. Every document in scope is mirrored — translate it, or add it to the ledger.`
    });
  }

  for (const entry of awaitingMirror) {
    const mirrorPath = deriveMirrorPath(entry);

    if (!inScope.has(entry)) {
      problems.push({
        file: entry,
        message: `on the awaiting-translation ledger but not a tracked document in scope — remove the entry.`
      });
      continue;
    }

    if (mirrorPath !== null && existingMirrors.has(mirrorPath)) {
      problems.push({
        file: entry,
        message: `on the awaiting-translation ledger but ${mirrorPath} now exists — remove the entry, the ledger may only shrink.`
      });
    }
  }

  return problems;
}
