#!/usr/bin/env bun
/**
 * Bumps the version, folds the waiting changesets into CHANGELOG.md, and
 * tags a release `vX.Y.Z`.
 *
 * Writing release notes is the task most easily postponed until it is
 * forgotten. This script moves the mechanical part (compute the version,
 * merge the files, cut the tag) to the machine — and, by reading `bump`
 * from each changeset (see `packages/gerbang/lib/changeset.mjs`), it moves
 * one more thing: **the size of the release**. What is left for a human is
 * judging one change while writing it — not judging ten at once, months
 * later, from a list of file names.
 *
 * Usage:
 *   bun run release                  # preview only; level derived from changesets
 *   bun run release --apply          # write package.json + CHANGELOG.md
 *   bun run release --apply --commit # also commit and tag
 *   bun run release minor --apply    # raise ABOVE what the changesets demand
 *
 * The level named on the command line is optional, and may only be LARGER
 * than what the changesets demand. A smaller one is refused: that would
 * publish a change that breaks something behind a number promising it does
 * not.
 *
 * Without --apply the script only reports. Without --commit the files are
 * written but the commit and tag are left to a human; the exact commands
 * are printed.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { gitRunInherit, gitRunOrThrow } from "../packages/gerbang/lib/git.mjs";
import {
  changesetBody,
  isChangesetFile,
  parseChangeset,
  validateChangeset
} from "../packages/gerbang/lib/changeset.mjs";
import {
  BUMP_LEVELS,
  atLeastAsSignificant,
  bumpVersion,
  formatTag,
  highestBump
} from "../packages/gerbang/lib/semver.mjs";

/**
 * Every git call goes through `packages/gerbang/lib/git.mjs`, which spawns
 * an argv array instead of a shell — a security boundary, not a style
 * preference. See that module's own docblock for the injection this avoids:
 * a hostile git tag name spliced into a shell command string can execute on
 * the machine of whoever runs this script.
 *
 * The remaining `execSync` calls below run CONSTANT command strings with
 * nothing interpolated into them; they are left as they are because the
 * shell is doing no work there that an argv array would do differently.
 */

const args = process.argv.slice(2);
const requestedLevel = args.find((a) => BUMP_LEVELS.includes(a));
const apply = args.includes("--apply");
const commit = args.includes("--commit");

const git = (...gitArgs) => gitRunOrThrow(".", ...gitArgs).trim();

// -- Prerequisites -----------------------------------------------------------
// "There is something to release" does not mean the working tree is dirty.
// Work already committed cleanly on a branch is the recommended flow;
// checking only for dirtiness would refuse exactly that case. What matters
// is whether anything is not yet covered by the last tag.
if (commit) {
  const dirty = git("status", "--porcelain") !== "";
  const lastTag = git("tag", "--list", "v*", "--sort=-v:refname").split("\n")[0];
  const newCommits = lastTag
    ? git("rev-list", "--count", `${lastTag}..HEAD`) !== "0"
    : true;
  if (!dirty && !newCommits) {
    console.error(`Nothing to release: working tree is clean and there are no commits since ${lastTag}.`);
    process.exit(1);
  }
}

// -- Waiting changesets --------------------------------------------------------
// Read BEFORE the version is computed, because they are what decides it.
// `isChangesetFile` rejects every `README*`, not just `README.md` exactly —
// a filter comparing one literal name would count `README.id.md` as a
// waiting changeset, and this release would fold its content into
// CHANGELOG.md and then delete it.
const pending = fs.existsSync(".changesets")
  ? fs.readdirSync(".changesets").filter(isChangesetFile).sort()
  : [];

/** Each changeset is read once; its content is used for both the bump and the fold. */
const changesetContent = new Map(
  pending.map((f) => [f, fs.readFileSync(`.changesets/${f}`, "utf8")])
);

// Frontmatter is validated here too, not only in `bun test`. That gate
// catches a malformed changeset at PR time; this one catches one written
// AFTER the gate last ran — at exactly the moment it would otherwise
// miscompute the version.
const invalid = pending.flatMap((f) =>
  validateChangeset(`.changesets/${f}`, changesetContent.get(f))
);

if (invalid.length) {
  console.error(`${invalid.length} changeset(s) invalid — a version cannot be derived from them:\n`);
  for (const { file, message } of invalid) console.error(`  ${file}: ${message}`);
  console.error("\nFix the frontmatter, then run this again.");
  process.exit(1);
}

const requestedBumps = pending.map((f) => parseChangeset(changesetContent.get(f)).fields.bump);
const derivedLevel = highestBump(requestedBumps);

// With no changesets there is nothing to derive, so the level must be
// stated — and a release with not one changeset behind it is a release
// nobody will be able to read the reason for later, so that is said loudly.
if (!derivedLevel && !requestedLevel) {
  console.error("No changesets are waiting, so a release level cannot be derived.\n");
  console.error("  Write the changeset (recommended), or name the level explicitly:");
  console.error(`  bun run release ${BUMP_LEVELS.join(" | ")} --apply\n`);
  process.exit(1);
}

// A level named by a human may be LARGER than what the changesets ask for —
// a releaser may know something not yet written down. What is refused is a
// SMALLER one: that publishes a change that breaks something behind a
// number promising it does not.
if (requestedLevel && derivedLevel && !atLeastAsSignificant(requestedLevel, derivedLevel)) {
  const demanding = pending.filter(
    (f) => parseChangeset(changesetContent.get(f)).fields.bump === derivedLevel
  );
  console.error(`Requested "${requestedLevel}", but changesets demand "${derivedLevel}":\n`);
  for (const f of demanding) console.error(`  .changesets/${f}`);
  console.error(
    `\nLower the changesets' bump if it is genuinely excessive, or release as ` +
      `"${derivedLevel}" or larger.`
  );
  process.exit(1);
}

const level = requestedLevel ?? derivedLevel;

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const next = bumpVersion(pkg.version, level);
const tag = formatTag(next);

if (git("tag", "-l", tag)) {
  console.error(`Tag ${tag} already exists.`);
  process.exit(1);
}

const origin = requestedLevel
  ? derivedLevel && requestedLevel !== derivedLevel
    ? `requested, above the "${derivedLevel}" the changesets demand`
    : "requested"
  : "derived from changesets";
console.log(`${pkg.version} -> ${next}  (tag ${tag}, ${level} — ${origin})`);
console.log(pending.length ? `Changesets waiting: ${pending.join(", ")}` : "No changesets waiting.");

if (!apply) {
  console.log("\nPreview only. Add --apply to write files.");
  process.exit(0);
}

// -- Verify before writing anything -------------------------------------------
// This repo has no build step at the root yet — apps/storefront (issue #5)
// is what will eventually pull real content and need one here. Until then,
// what a release can actually prove is that the workspace's own gates and
// tests are green; running a build that does not exist yet is not a step
// this script can skip past quietly, because there is nothing to skip.
console.log("Running bun run audit:dokumen ...");
execSync("bun run audit:dokumen", { stdio: "inherit" });

// NOT audit:rilis: folding the waiting changesets below is exactly the
// operation that clears that gate's backlog. Running it here would refuse
// the one action that fixes what it is complaining about, on every release
// large enough to matter.

console.log("Running bun test ...");
execSync("bun test", { stdio: "inherit" });

// `bun audit` (dependency vulnerabilities) and this repo's own
// `audit:dokumen`/`audit:rilis`/`audit:translation` gates are unrelated,
// and their names are kept distinct on purpose.
console.log("Running bun audit ...");
execSync("bun audit --audit-level=low", { stdio: "inherit" });

// -- Fold changesets into CHANGELOG.md ----------------------------------------
// Local date, not UTC: cutting a release late at night would otherwise be
// recorded a day early or late depending on the releaser's timezone.
const today = new Date().toLocaleDateString("sv-SE");
const body = pending
  .map((f) =>
    changesetBody(changesetContent.get(f))
      // Changeset headings are demoted two levels so they nest neatly under
      // the version heading: a changeset's title becomes `###`, its
      // subsections `####`.
      .replace(/^(#{1,4}) /gm, (_, hashes) => `${"#".repeat(hashes.length + 2)} `)
      // Relative links are written from the point of view of `.changesets/`,
      // but CHANGELOG.md lives at the repo root. Copying them as-is would
      // leave every link off by one level — and it would only be noticed in
      // CI, because the audit gate runs BEFORE changesets are folded.
      .replace(/\]\((?!https?:|mailto:|#)([^)]+)\)/g, (_, target) => {
        const [targetPath, anchor] = target.split("#");
        const rootPath = path.posix.normalize(path.posix.join(".changesets", targetPath));
        return `](${rootPath}${anchor ? `#${anchor}` : ""})`;
      })
      .trim()
  )
  .join("\n\n");

const changelog = fs.existsSync("CHANGELOG.md") ? fs.readFileSync("CHANGELOG.md", "utf8") : "";
if (changelog.includes(`\n## [${next}]`)) {
  console.error(`CHANGELOG.md already has a section for ${next}. Clean it up before releasing.`);
  process.exit(1);
}
// Before the first release there is no version heading at all. `indexOf`
// answers -1 for that state, and `slice(0, -1)` would silently chop the
// last character of the preamble instead of inserting after it.
const marker = "\n## [";
const found = changelog.indexOf(marker);
const at = found === -1 ? changelog.length : found;
const entry = `\n## [${next}] — ${today}\n\n${body || "_No changesets; see git history._"}\n`;
fs.writeFileSync("CHANGELOG.md", changelog.slice(0, at) + entry + changelog.slice(at));

for (const f of pending) fs.unlinkSync(`.changesets/${f}`);

pkg.version = next;
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

// No lockfile field to touch here: `package-lock.json` used to store the
// project version in two places, and both drifted silently whenever only
// package.json was bumped. `bun.lock` records no version at all (only
// workspace names and dependency ranges), so that entire class of defect
// disappeared with the move to Bun — see `packages/gerbang/lib/lockfile.mjs`.

console.log(`\nCHANGELOG.md and package.json updated to ${next}.`);

// -- Commit and tag ------------------------------------------------------------
if (!commit) {
  console.log("\nNext steps:");
  console.log("  git add -A");
  console.log(`  git commit -m "release: ${tag}"`);
  console.log(`  git tag -a ${tag} -m "${tag}"`);
  console.log(`  git push && git push origin ${tag}`);
  process.exit(0);
}

gitRunInherit(".", "add", "-A");
gitRunInherit(".", "commit", "-m", `release: ${tag}`);
gitRunInherit(".", "tag", "-a", tag, "-m", tag);
console.log(`\n${tag} created. Push with: git push && git push origin ${tag}`);
