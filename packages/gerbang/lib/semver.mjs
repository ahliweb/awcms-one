/**
 * semver.mjs — the `X.Y.Z` version model and the `vX.Y.Z` tag that carries it.
 *
 * ## Why parsing refuses rather than guesses
 *
 * A hand-rolled version bump typically looks like:
 *
 *     const [major, minor, patch] = pkg.version.split('.').map(Number);
 *     const next = { patch: `${major}.${minor}.${patch + 1}` }[level];
 *
 * `split('.')` answers something for every string, and `Number` answers
 * `NaN` for anything that is not a bare integer. Neither ever fails. Run
 * against a version that has drifted even slightly — a prerelease suffix, a
 * stray `v` prefix, two fields instead of three — this produces a tag like
 * `v0.2.NaN`: created, and pushed. A tag named `v0.2.NaN` sorts nowhere under
 * `--sort=v:refname`, so the *next* release reads a different tag as
 * "latest" and the damage outlives the run that caused it. Parsing therefore
 * refuses rather than guesses, and this module is the only place a version
 * string is turned into numbers.
 *
 * ## What counts as a version here, and what deliberately does not
 *
 * Exactly `MAJOR.MINOR.PATCH`, three non-negative integers without leading
 * zeros. Refused, each for a reason rather than for strictness:
 *
 *   - **A `v` prefix** (`v0.2.0`). The `v` belongs to the git tag, never to
 *     `package.json`. Accepting it in both places is how the two spellings
 *     start appearing interchangeably, and then a comparison between them
 *     silently fails.
 *   - **Prerelease and build metadata** (`0.2.0-rc.1`, `0.2.0+build.5`).
 *     Semver defines their ordering, but this repo has no publishing policy
 *     for one — `bun run release` has no prerelease level and
 *     `CHANGELOG.md` has no section for one. Accepting the syntax without
 *     the policy produces a tag nothing else in the toolchain knows how to
 *     order.
 *   - **Leading zeros** (`0.02.0`). Semver forbids them, and they compare
 *     equal to the unpadded form in some tools and not in others.
 *
 * Adding prerelease support later is a policy decision with its own checker,
 * not a loosened regex here.
 */

/**
 * Bump levels, ordered from most to least significant.
 *
 * The order is the data: {@link highestBump} takes the union of what a
 * release's changesets ask for, and "most significant wins" is only
 * expressible if the list itself is ordered. A `Set` or an object would lose
 * that.
 */
export const BUMP_LEVELS = Object.freeze(["major", "minor", "patch"]);

/** Exactly three dot-separated integers, no leading zeros, nothing else. */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** `vX.Y.Z` — the tag spelling, which is the version plus exactly one `v`. */
const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * @typedef {{ major: number, minor: number, patch: number }} Version
 */

/**
 * Parse `X.Y.Z`, throwing with the offending text when it is anything else.
 *
 * @param {string} text
 * @returns {Version}
 * @throws {Error} naming what was read, so the message is actionable when it
 *   surfaces from `package.json` mid-release
 */
export function parseVersion(text) {
  if (typeof text !== "string") {
    throw new Error(`version is not a string: ${JSON.stringify(text)}`);
  }

  const match = text.match(VERSION_PATTERN);
  if (!match) {
    throw new Error(
      `version "${text}" is not MAJOR.MINOR.PATCH — a leading \`v\`, a ` +
        `prerelease suffix, build metadata, and leading zeros are all ` +
        `refused here (see packages/gerbang/lib/semver.mjs)`
    );
  }

  return { major: +match[1], minor: +match[2], patch: +match[3] };
}

/**
 * @param {Version} version
 * @returns {string} `X.Y.Z`
 */
export function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

/**
 * The version that follows `text` at `level`.
 *
 * Lower fields reset, which is the half of semver most hand-rolled bumpers
 * get wrong: a minor bump from `1.4.7` is `1.5.0`, never `1.5.7`.
 *
 * @param {string} text - the current version, `X.Y.Z`
 * @param {"major" | "minor" | "patch"} level
 * @returns {string} the next version, `X.Y.Z`
 * @throws {Error} on an unparseable version or an unknown level
 */
export function bumpVersion(text, level) {
  const { major, minor, patch } = parseVersion(text);

  switch (level) {
    case "major":
      return formatVersion({ major: major + 1, minor: 0, patch: 0 });
    case "minor":
      return formatVersion({ major, minor: minor + 1, patch: 0 });
    case "patch":
      return formatVersion({ major, minor, patch: patch + 1 });
    default:
      throw new Error(
        `release level "${level}" is not recognised — choose ${BUMP_LEVELS.join(" | ")}`
      );
  }
}

/**
 * `0.2.1` → `v0.2.1`. Parses first, so a tag is never formed from a version
 * that was never valid.
 *
 * @param {string} version
 * @returns {string}
 */
export function formatTag(version) {
  return `v${formatVersion(parseVersion(version))}`;
}

/**
 * `v0.2.1` → `0.2.1`, or `null` when the ref is not one of this repo's tags.
 *
 * Returns null rather than throwing because the caller reads `git tag
 * --list`, where an unrelated tag is an ordinary thing to encounter and not
 * an error.
 *
 * @param {string} tag
 * @returns {string | null}
 */
export function parseTag(tag) {
  const match = typeof tag === "string" ? tag.match(TAG_PATTERN) : null;
  return match ? `${+match[1]}.${+match[2]}.${+match[3]}` : null;
}

/**
 * The most significant level in `levels`, or `null` when there are none.
 *
 * This is what makes a release's size a consequence of its contents rather
 * than a judgement made at release time: one changeset asking for `minor`
 * carries the whole release to `minor`, however many `patch` entries sit
 * beside it.
 *
 * @param {readonly string[]} levels
 * @returns {"major" | "minor" | "patch" | null}
 * @throws {Error} on a level outside {@link BUMP_LEVELS} — silently ignoring
 *   one would let a typo (`minorr`) quietly lower a release
 */
export function highestBump(levels) {
  let winner = null;

  for (const level of levels) {
    const rank = BUMP_LEVELS.indexOf(level);
    if (rank === -1) {
      throw new Error(
        `level "${level}" is not recognised — choose ${BUMP_LEVELS.join(" | ")}`
      );
    }
    if (winner === null || rank < BUMP_LEVELS.indexOf(winner)) winner = level;
  }

  return winner;
}

/**
 * Is `a` at least as significant as `b`?
 *
 * Used to refuse a hand-passed level that is SMALLER than what the
 * changesets ask for. The opposite direction stays allowed: a maintainer who
 * knows a release is bigger than its changesets admit may say so, and that
 * judgement is not something a script can make for them.
 *
 * @param {"major" | "minor" | "patch"} a
 * @param {"major" | "minor" | "patch"} b
 * @returns {boolean}
 */
export function atLeastAsSignificant(a, b) {
  return BUMP_LEVELS.indexOf(a) <= BUMP_LEVELS.indexOf(b);
}
