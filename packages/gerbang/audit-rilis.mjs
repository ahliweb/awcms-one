#!/usr/bin/env bun
/**
 * audit-rilis.mjs — the gate over the changesets that are still WAITING.
 *
 * ## The question this gate exists to ask
 *
 * `.changesets/` declares its own `bump`, so the SIZE of a release is
 * derived from its contents rather than typed at the command line (see
 * `lib/changeset.mjs`). That leaves exactly one thing to human memory:
 * **when**. A backlog that grows unwatched is a version number that stops
 * meaning anything to whoever depends on it — including a security fix with
 * no tagged release to pull.
 *
 * This gate is adapted from `ahliweb/media-lenterakalteng`'s
 * `packages/gerbang/audit-rilis.mjs`, which was written after that repo let
 * exactly this happen: thirty changesets sat waiting twenty days behind a
 * tag, nine of them reader-visible features and two of them security
 * fixes, while every gate in the repo stayed green — because none of them
 * read `.changesets/` for anything but dead links. This repo has no
 * comparable incident of its own yet; the gate is included from the start
 * so it never gets the chance to.
 *
 * ## What this gate checks
 *
 * Three things, all of them from file names and none of them needing a
 * build, a network, or `apps/cms`:
 *
 *   1. **A changeset can be aged at all.** Its name must begin `YYYY-MM-DD-`
 *      with a real calendar date. A file this gate cannot date is a file
 *      that never ages, and it would sit in the backlog invisible to the
 *      one check built to notice it.
 *   2. **The backlog has a ceiling** ({@link MAX_WAITING}).
 *   3. **The backlog has a deadline.** The oldest waiting changeset may be
 *      at most {@link MAX_AGE_DAYS} days old.
 *
 * ## Why the bounds below are starting assumptions, not measured ones
 *
 * `media-lenterakalteng` derived its bound from its own measured rate
 * (thirty changesets in twenty days). This repo started with no release
 * history to measure from, so {@link MAX_WAITING} and {@link MAX_AGE_DAYS}
 * were conservative round numbers (10 files, 14 days). Two increments later
 * there is a rate: v0.3.0 folded ten changesets from nine PRs merged inside
 * one week, and increment 3 (epic #46) lands one changeset per atomic PR —
 * fourteen children plus follow-ups — before its own release, so a bound of
 * 10 reddened every PR in the second half of the increment with nothing for
 * the contributor to do about it. {@link MAX_WAITING} is therefore 20: the
 * measured size of one increment's release plus headroom, still low enough
 * that a backlog nobody is releasing gets noticed. {@link MAX_AGE_DAYS}
 * stays at 14 — it is the age bound, not the count, that catches an
 * unwatched backlog, and an increment has never taken longer than that.
 *
 * ## Why the age bound is allowed to redden a run nobody caused
 *
 * This red asks the contributor who sees it for **nothing** — it is cleared
 * by a maintainer running one release — and this repo's `main` carries no
 * required checks yet, so a red run informs without blocking anyone's
 * merge. What it costs is a red mark; what it buys is that a backlog cannot
 * be a silence.
 *
 * ## Why the releaser does NOT run this
 *
 * `bun run release` folds every waiting changeset and deletes it — it is the
 * act that clears this backlog. Running the gate inside the releaser would
 * refuse the one operation that fixes what the gate is complaining about,
 * on every release large enough to matter.
 *
 * Run: `bun run audit:rilis`.
 */
import { existsSync, readdirSync } from "node:fs";

import { isChangesetFile } from "./lib/changeset.mjs";
import { createReporter } from "./lib/reporter.mjs";

const DIRECTORY = ".changesets";

/**
 * At most this many changesets may wait for a release. See "Why the bounds
 * below are starting assumptions" above.
 */
const MAX_WAITING = 20;

/**
 * The oldest waiting changeset may be at most this many days old. See "Why
 * the bounds below are starting assumptions" above.
 */
const MAX_AGE_DAYS = 14;

/**
 * How far ahead of this machine's own date a changeset may be dated.
 *
 * Not zero. An author names a changeset in their own timezone and CI runs in
 * UTC; for several hours after midnight in a timezone ahead of UTC, a
 * changeset written "today" is dated "tomorrow" as far as a UTC clock is
 * concerned. One day of slack covers every timezone on earth (none is more
 * than a day ahead of UTC) while still catching what this check exists to
 * catch: a changeset dated a month out, whose negative age would keep it
 * below every deadline forever.
 */
const MAX_FUTURE_DAYS = 1;

/** `YYYY-MM-DD-` at the head of a changeset's name. */
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})-/;

const reporter = createReporter("audit:rilis");

/**
 * Today as `YYYY-MM-DD`, LOCAL — the same clock `tools/rilis.mjs` stamps the
 * changelog with, so a release cut late at night is not one day older here
 * than it is there.
 *
 * `RELEASE_TODAY` overrides it. A gate whose verdict depends on the wall
 * clock cannot be tested against a fixture without one, and a test that
 * computes its fixture dates from the same clock as the gate proves only
 * that subtraction works.
 */
function today() {
  const override = (process.env.RELEASE_TODAY ?? "").trim();
  if (override) return override;
  return new Date().toLocaleDateString("sv-SE");
}

/**
 * Whole days between two `YYYY-MM-DD` dates.
 *
 * Both are read at UTC midnight, so the answer never moves by an hour of
 * daylight saving in a zone neither date was written in.
 *
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
function daysBetween(from, to) {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * The date a changeset's name declares, or `null` when the name declares
 * none that a calendar would accept.
 *
 * `Date.parse` is not asked directly: it answers for `2026-02-31` by
 * rolling into March, and a date that rolls is a date the author did not
 * write. Round-tripping the parsed value back to its own string rejects
 * exactly that.
 *
 * @param {string} name - a bare file name inside `.changesets/`
 * @returns {string | null}
 */
function declaredDate(name) {
  const match = name.match(DATE_PREFIX);
  if (!match) return null;

  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

if (!existsSync(DIRECTORY)) {
  // A tree may legitimately have removed this directory along with the
  // release machinery. Saying so is the difference between a gate that
  // found nothing and a gate that read nothing.
  reporter.note(`${DIRECTORY}/ does not exist — no release backlog to check.`);
  reporter.finish();
}

const pending = readdirSync(DIRECTORY).filter(isChangesetFile).sort();

/** @type {{ file: string, date: string }[]} */
const dated = [];

for (const file of pending) {
  const date = declaredDate(file);

  if (!date) {
    reporter.violation(
      "naming",
      `${DIRECTORY}/${file}`,
      "name is not prefixed with a valid `YYYY-MM-DD-` date — a changeset " +
        "this gate cannot date never ages, so it sits in the backlog " +
        "invisible to the one check built to see it (see .changesets/README.md)"
    );
    continue;
  }

  dated.push({ file, date });
}

const todayIso = today();

// Checked before the age bound, and not merged into it: a file dated ahead
// of today has a NEGATIVE age, so it can never cross a deadline — it would
// be the one way to park a changeset in the backlog permanently, and it
// would look like a typo while doing it. MAX_FUTURE_DAYS of slack keeps a
// timezone difference from being read as that.
for (const { file, date } of dated) {
  if (daysBetween(date, todayIso) < -MAX_FUTURE_DAYS) {
    reporter.violation(
      "date",
      `${DIRECTORY}/${file}`,
      `dated ${date}, more than ${MAX_FUTURE_DAYS} day(s) ahead of today ` +
        `(${todayIso}) — a changeset dated in the future has a negative ` +
        "age, so it would never cross any age bound"
    );
  }
}

if (dated.length > MAX_WAITING) {
  reporter.violation(
    "count",
    `${DIRECTORY}/`,
    `${dated.length} changeset(s) waiting, bound is ${MAX_WAITING} — cut a ` +
      "release with `bun run release --apply`"
  );
}

const oldest = dated.reduce(
  (oldestSoFar, candidate) =>
    oldestSoFar === null || candidate.date < oldestSoFar.date ? candidate : oldestSoFar,
  /** @type {{ file: string, date: string } | null} */ (null)
);

if (oldest) {
  const ageDays = daysBetween(oldest.date, todayIso);

  if (ageDays > MAX_AGE_DAYS) {
    reporter.violation(
      "age",
      `${DIRECTORY}/${oldest.file}`,
      `waiting ${ageDays} day(s) since ${oldest.date}, bound is ` +
        `${MAX_AGE_DAYS} — a tree built from this repo has no tagged ` +
        "version to pull a fix from"
    );
  }

  reporter.note(
    `${dated.length} changeset(s) waiting (bound ${MAX_WAITING}); oldest ` +
      `${oldest.file} — ${ageDays} day(s) (bound ${MAX_AGE_DAYS}).`
  );
} else {
  reporter.note(
    `No changesets waiting. Bounds in force: ${MAX_WAITING} file(s), ` +
      `${MAX_AGE_DAYS} day(s).`
  );
}

reporter.finish();
