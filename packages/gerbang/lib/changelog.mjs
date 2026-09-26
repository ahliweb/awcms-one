/**
 * changelog.mjs — reading one version's section out of a CHANGELOG.md-shaped
 * document.
 *
 * ## Why an unrecognised `##` heading is refused rather than skipped
 *
 * `tools/rilis.mjs` writes every version heading in exactly one shape,
 * `## [X.Y.Z] — YYYY-MM-DD`, and nothing else in `CHANGELOG.md` is a level-2
 * heading — every subsection a folded changeset contributes is demoted to
 * `###` or deeper first (see that script's own comment on why). That makes
 * "the next `##` heading" an unambiguous end-of-section marker, but only for
 * as long as every `##` heading actually has that shape.
 *
 * A heading format that drifts — a different dash, the brackets dropped, the
 * date moved before the version — still starts with `## `, and a parser that
 * matches only on that prefix would keep splitting sections on it anyway:
 * the wrong prose ends up in the wrong version's notes, or two versions'
 * entries merge into one, and `tools/release/publish.ts` (formerly
 * `.github/workflows/release.yml`, issue #181; see issue #225/ADR-0023)
 * publishes whatever comes out as a GitHub Release with no diff for anyone
 * to notice it in. So every `## ` line is checked against the full expected
 * shape, and one that does not match throws immediately, naming the
 * offending line, instead of silently feeding a wrong split further downstream
 * — the same "refuse rather than guess" choice `semver.mjs` documents for a
 * version string.
 *
 * ## CRLF tolerance
 *
 * `.gitattributes` does not force `text=auto eol=lf` (see
 * `packages/gerbang/lib/changeset.mjs`'s own docblock for the same issue in
 * a sibling file), so a checkout with `core.autocrlf=true` can hand this
 * module a document with `\r\n` line endings. Line endings are normalised to
 * `\n` before anything is matched, so a heading is recognised the same way
 * either way, and the returned body is always LF-only.
 */

import { formatVersion, parseVersion } from "./semver.mjs";

/** `## [X.Y.Z] — <anything>` — the one shape every version heading may take. */
const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\] — .+$/;

/** Any level-2 heading at all — matched first so a non-conforming one can still be named in the error. */
const ANY_LEVEL2_HEADING = /^## .*$/gm;

/** @typedef {{ version: string, headingStart: number, bodyStart: number }} ChangelogHeading */

/**
 * @param {string} text
 * @returns {string} `text` with every `\r\n` replaced by `\n`
 */
function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Every version heading in `text`, in file order — newest first, matching
 * how `tools/rilis.mjs` prepends each release right after the top-of-file
 * preamble.
 *
 * @param {string} text - already normalised to `\n` line endings
 * @returns {ChangelogHeading[]}
 * @throws {Error} on a `## ` line that is not a well-formed version heading —
 *   see this module's own docblock for why that is refused rather than
 *   silently treated as prose
 */
export function findChangelogHeadings(text) {
  /** @type {ChangelogHeading[]} */
  const headings = [];

  for (const match of text.matchAll(ANY_LEVEL2_HEADING)) {
    const line = match[0];
    const versioned = line.match(VERSION_HEADING);
    if (!versioned) {
      throw new Error(
        `CHANGELOG.md heading ${JSON.stringify(line)} does not match the expected ` +
          '"## [X.Y.Z] — <date>" format. Its heading format may have drifted from ' +
          "what packages/gerbang/lib/changelog.mjs expects — fix the heading, or " +
          "this module, before trusting what it extracts."
      );
    }
    headings.push({
      version: versioned[1],
      headingStart: match.index,
      bodyStart: match.index + line.length
    });
  }

  return headings;
}

/**
 * `v0.10.0` or `0.10.0` → `0.10.0`. Delegates to {@link parseVersion} for the
 * actual validation, so a malformed version argument fails with the same
 * message it would anywhere else in this toolchain that reads one.
 *
 * @param {string} input
 * @returns {string}
 */
function normalizeRequestedVersion(input) {
  const stripped = typeof input === "string" && input.startsWith("v") ? input.slice(1) : input;
  return formatVersion(parseVersion(stripped));
}

/**
 * The prose for one version's entry in `changelogText` — everything between
 * its own `## [X.Y.Z] — ...` heading and the next one (or end of file, for
 * the oldest entry), without the heading itself, trimmed.
 *
 * @param {string} changelogText - the whole file, as `readFileSync` returns it
 * @param {string} version - `X.Y.Z` or `vX.Y.Z`
 * @returns {string}
 * @throws {Error} when `version` does not parse, when no section exists for
 *   it, or when a heading elsewhere in the file has drifted from the
 *   expected format (see {@link findChangelogHeadings})
 */
export function changelogSection(changelogText, version) {
  const target = normalizeRequestedVersion(version);
  const text = normalizeLineEndings(changelogText);
  const headings = findChangelogHeadings(text);

  const index = headings.findIndex((heading) => heading.version === target);
  if (index === -1) {
    const present = headings.map((heading) => heading.version);
    throw new Error(
      `CHANGELOG.md has no section for version ${target}.` +
        (present.length
          ? ` Versions present: ${present.join(", ")}.`
          : " CHANGELOG.md has no version headings at all.")
    );
  }

  const bodyStart = headings[index].bodyStart;
  const bodyEnd = index + 1 < headings.length ? headings[index + 1].headingStart : text.length;
  return text.slice(bodyStart, bodyEnd).trim();
}
