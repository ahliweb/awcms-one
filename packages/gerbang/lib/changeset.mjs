/**
 * changeset.mjs — reading a `.changesets/*.md` entry and its frontmatter.
 *
 * ## Why `bump` is the field that matters
 *
 * This repo's changeset convention is modelled on
 * `ahliweb/media-lenterakalteng`'s `.changesets/`, which learned a real
 * lesson worth inheriting rather than re-discovering: for a while, `type`
 * and `impact` were recorded on every changeset and **nothing read them** —
 * the release script stripped the frontmatter with a regex and discarded
 * it, and the number that actually shipped was typed at the command line at
 * release time, by whoever happened to run the script, often long after the
 * change was written and not necessarily by its author. A field nobody
 * reads is a field that is wrong as often as it is right, and nobody finds
 * out.
 *
 * So here `bump` is the field the release reads from the start: the next
 * version is the **largest** `bump` among the waiting changesets (see
 * `lib/semver.mjs`'s `highestBump`). The size of a release becomes a
 * consequence of what went into it, decided by the person who understands
 * one change at a time — not reconstructed from a list of file names months
 * later.
 *
 * ## Why the frontmatter parser is CRLF-tolerant
 *
 * `.gitattributes` does not force `text=auto eol=lf`, so a checkout with
 * `core.autocrlf=true` can leave CRLF endings in a working tree even though
 * this repo writes LF. A pattern anchored on a bare `\n` then fails to match
 * the closing `---`, the frontmatter block is not stripped, and the raw
 * YAML lands in `CHANGELOG.md` — where a stray `---` after a text line
 * renders as a setext heading and nothing goes red to say so.
 */

import { BUMP_LEVELS } from "./semver.mjs";

/** @typedef {{ file: string, message: string }} Problem */

/**
 * `type` — what kind of change it was. Documented in `.changesets/README.md`.
 *
 * Kept as a closed list because an open one is not a vocabulary: the value's
 * whole purpose is to group entries, and a set of near-synonyms groups
 * nothing.
 */
export const CHANGESET_TYPES = Object.freeze([
  "content",
  "structure",
  "fix",
  "dependency",
  "docs"
]);

/** `impact` — whether a reader or operator of the running system could see it. */
export const CHANGESET_IMPACTS = Object.freeze(["public", "internal"]);

/**
 * Frontmatter is CRLF-tolerant on purpose — see this file's docblock.
 */
const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/**
 * Split a changeset into its declared fields and its prose.
 *
 * @param {string} text - the whole file
 * @returns {{ fields: Record<string, string>, body: string } | null} null when
 *   there is no frontmatter block at all
 */
export function parseChangeset(text) {
  const match = text.match(FRONTMATTER_PATTERN);
  if (!match) return null;

  /** @type {Record<string, string>} */
  const fields = {};

  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;

    const key = trimmed.slice(0, colon).trim();
    // Quotes stripped so `bump: "patch"` and `bump: patch` are the same
    // declaration — the difference is invisible to a reader and would
    // otherwise fail a comparison for a reason nobody could see.
    const value = trimmed
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "");

    if (key) fields[key] = value;
  }

  return { fields, body: text.slice(match[0].length) };
}

/**
 * Strip the frontmatter, leaving the prose that is folded into `CHANGELOG.md`.
 *
 * @param {string} text
 * @returns {string}
 */
export function changesetBody(text) {
  return text.replace(FRONTMATTER_PATTERN, "");
}

/**
 * Is this a changeset entry, as opposed to the directory's own README?
 *
 * Rejects every `README*`, not only `README.md` exactly — a filter
 * comparing against one literal name would count `README.id.md` as a
 * waiting changeset, and the next release would fold its content into
 * `CHANGELOG.md` and delete it.
 *
 * @param {string} name - a bare filename inside `.changesets/`
 * @returns {boolean}
 */
export function isChangesetFile(name) {
  return name.endsWith(".md") && !name.startsWith("README");
}

/**
 * Everything wrong with one changeset, as a list rather than a first failure.
 *
 * Reporting all of them at once is the difference between one round trip and
 * three: a contributor who forgot the frontmatter has usually also not
 * chosen a `bump`, and telling them one thing at a time wastes both.
 *
 * @param {string} name - repo-relative path, used in messages
 * @param {string} text
 * @returns {Problem[]}
 */
export function validateChangeset(name, text) {
  /** @type {Problem[]} */
  const problems = [];
  const parsed = parseChangeset(text);

  if (!parsed) {
    problems.push({
      file: name,
      message:
        "no `---` frontmatter block — a changeset must declare bump, type, " +
        "and impact (see .changesets/README.md)"
    });
    return problems;
  }

  const { fields } = parsed;

  if (!("bump" in fields)) {
    problems.push({
      file: name,
      message:
        "no `bump:` — this is what decides the size of the release, and " +
        "without it that decision falls back to the command line at " +
        "release time, months after the change was written"
    });
  } else if (!BUMP_LEVELS.includes(fields.bump)) {
    problems.push({
      file: name,
      message: `bump: "${fields.bump}" is not recognised — choose ${BUMP_LEVELS.join(" | ")}`
    });
  }

  if (!("type" in fields)) {
    problems.push({ file: name, message: "no `type:`" });
  } else if (!CHANGESET_TYPES.includes(fields.type)) {
    problems.push({
      file: name,
      message: `type: "${fields.type}" is not recognised — choose ${CHANGESET_TYPES.join(" | ")}`
    });
  }

  if (!("impact" in fields)) {
    problems.push({ file: name, message: "no `impact:`" });
  } else if (!CHANGESET_IMPACTS.includes(fields.impact)) {
    problems.push({
      file: name,
      message: `impact: "${fields.impact}" is not recognised — choose ${CHANGESET_IMPACTS.join(" | ")}`
    });
  }

  return problems;
}
