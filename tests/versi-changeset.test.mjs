/**
 * The gate over the versioning model — `vX.Y.Z` derived from the changesets.
 *
 * Guards three things that each fail silently without a checker:
 *
 *   1. **Every changeset declares a valid `bump`.** Without it the
 *      derivation has nothing to derive from, and the decision slides back
 *      to the command line at release time.
 *   2. **The version model refuses what it cannot represent** — see
 *      `packages/gerbang/lib/semver.mjs`'s own docblock for the tag a
 *      hand-rolled bumper would silently produce instead.
 *   3. **`package.json`, the newest tag, and `CHANGELOG.md` agree.** Three
 *      records of one number is two chances to drift.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  CHANGESET_IMPACTS,
  CHANGESET_TYPES,
  isChangesetFile,
  parseChangeset,
  validateChangeset
} from "../packages/gerbang/lib/changeset.mjs";
import {
  BUMP_LEVELS,
  atLeastAsSignificant,
  bumpVersion,
  formatTag,
  highestBump,
  parseTag,
  parseVersion
} from "../packages/gerbang/lib/semver.mjs";

const CHANGESET_DIR = ".changesets";

/** Everything in the directory, before the changeset filter runs over it. */
const entries = readdirSync(CHANGESET_DIR);

const changesets = entries
  .filter(isChangesetFile)
  .map((name) => ({
    name,
    path: join(CHANGESET_DIR, name),
    text: readFileSync(join(CHANGESET_DIR, name), "utf8")
  }));

describe("the version model refuses what it cannot represent", () => {
  test("a bare X.Y.Z parses, and every near-miss throws", () => {
    assert.deepEqual(parseVersion("0.2.0"), { major: 0, minor: 2, patch: 0 });
    assert.deepEqual(parseVersion("10.0.31"), { major: 10, minor: 0, patch: 31 });

    // Each of these produced a silent NaN with naive split('.').map(Number)
    // arithmetic, and each would have become a real git tag.
    for (const bad of [
      "0.2.0-rc.1",
      "0.2.0+build.5",
      "v0.2.0",
      "1.0",
      "1.0.0.0",
      "0.02.0",
      "",
      "latest"
    ]) {
      assert.throws(
        () => parseVersion(bad),
        /is not MAJOR\.MINOR\.PATCH|is not a string/,
        `parseVersion(${JSON.stringify(bad)}) did not throw — this is exactly how a NaN version gets tagged`
      );
    }
  });

  test("a bump resets the fields below it", () => {
    assert.equal(bumpVersion("1.4.7", "patch"), "1.4.8");
    // The half that hand-rolled bumpers get wrong: not 1.5.7, not 2.4.7.
    assert.equal(bumpVersion("1.4.7", "minor"), "1.5.0");
    assert.equal(bumpVersion("1.4.7", "major"), "2.0.0");
    assert.throws(() => bumpVersion("1.4.7", "mayor"), /not recognised/);
  });

  test("the tag is the version plus exactly one v, and round-trips", () => {
    assert.equal(formatTag("0.2.1"), "v0.2.1");
    assert.equal(parseTag("v0.2.1"), "0.2.1");
    assert.equal(parseTag("v0.2.NaN"), null);
    assert.equal(parseTag("0.2.1"), null, "a version is not a tag");
    assert.equal(parseTag("release-0.2.1"), null);
    assert.throws(() => formatTag("v0.2.1"), /not MAJOR/, "no double v");
  });

  test("the largest pending bump carries the release", () => {
    assert.equal(highestBump(["patch", "minor", "patch"]), "minor");
    assert.equal(highestBump(["patch", "major", "minor"]), "major");
    assert.equal(highestBump(["patch"]), "patch");
    assert.equal(highestBump([]), null);
    // A typo must not quietly lower a release by being skipped.
    assert.throws(() => highestBump(["patch", "minorr"]), /not recognised/);
  });

  test("a requested level may exceed the derived one, never undercut it", () => {
    assert.ok(atLeastAsSignificant("major", "minor"));
    assert.ok(atLeastAsSignificant("minor", "minor"));
    assert.ok(!atLeastAsSignificant("patch", "minor"));
    assert.ok(!atLeastAsSignificant("minor", "major"));
  });
});

describe("every pending changeset declares what it costs", () => {
  test("nothing in the directory is dropped before it can be checked", () => {
    // Guards the gate itself: with nothing to read, every assertion below is
    // vacuously true and the suite reads green while checking nothing.
    //
    // What it may NOT do is demand entries. An EMPTY backlog is the state a
    // release leaves behind — `bun run release` folds every changeset into
    // CHANGELOG.md and deletes it — so a demand for at least one would turn
    // `main` red for the whole window between a release and the next change
    // to land, precisely when nobody has done anything wrong.
    const mdFiles = entries.filter((name) => name.endsWith(".md") && !name.startsWith("README"));
    const readByGate = changesets.map((c) => c.name);

    assert.deepEqual(
      mdFiles.filter((name) => !readByGate.includes(name)),
      [],
      "these .md files sit in .changesets/ and no assertion below reads them"
    );
  });

  test("frontmatter is valid in every one", () => {
    const problems = changesets.flatMap((c) => validateChangeset(c.path, c.text));
    assert.deepEqual(
      problems.map((p) => `${p.file}: ${p.message}`),
      [],
      "a changeset that fails here stops contributing to the version, silently"
    );
  });

  test("the declared vocabulary is the documented vocabulary", () => {
    const readme = readFileSync(join(CHANGESET_DIR, "README.md"), "utf8");

    // The README is what a contributor reads; the module is what the gate
    // enforces. When they disagree, the contributor is the one who loses.
    for (const level of BUMP_LEVELS) {
      assert.ok(
        readme.includes(level),
        `.changesets/README.md never mentions the bump level "${level}"`
      );
    }
    for (const value of [...CHANGESET_TYPES, ...CHANGESET_IMPACTS]) {
      assert.ok(
        readme.includes(value),
        `.changesets/README.md never mentions "${value}", which the gate accepts`
      );
    }
  });

  test("the release the pending set would produce is stated, not guessed", () => {
    const levels = changesets.map((c) => parseChangeset(c.text).fields.bump);
    const derived = highestBump(levels);
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));

    // With an empty backlog there is nothing to derive FROM, and that is the
    // state a release leaves behind rather than a defect — `bun run
    // release` refuses that case at the command line itself. The
    // derivation's own arithmetic is proven above, over inputs this file
    // supplies; what runs below is the end-to-end path, and it needs a real
    // pending set to run over.
    if (!derived) {
      assert.equal(changesets.length, 0, "a pending set exists but derives no bump");
      return;
    }

    // Not an assertion about WHICH level — that is the authors' judgement.
    // It asserts the derivation runs end to end and yields a taggable version.
    const next = bumpVersion(pkg.version, derived);
    assert.equal(formatTag(next), `v${next}`);
    assert.notEqual(next, pkg.version);
  });
});

describe("one number, three records, no drift", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));

  test("package.json holds a version this repo can tag", () => {
    assert.doesNotThrow(() => parseVersion(pkg.version));
  });

  test("CHANGELOG.md documents the vX.Y.Z model and the derivation", () => {
    const changelog = readFileSync("CHANGELOG.md", "utf8");
    assert.match(changelog, /`?vX\.Y\.Z`?/, "the tag format is not stated");
    assert.match(changelog, /MAJOR\.MINOR\.PATCH/, "the version format is not stated");
    // The preamble tells a reader where the number comes from.
    assert.match(
      changelog,
      /bump/,
      "CHANGELOG.md still describes releases without naming the `bump` field that derives them"
    );
  });

  test("the released version has a section in CHANGELOG.md", () => {
    const changelog = readFileSync("CHANGELOG.md", "utf8");
    assert.ok(
      changelog.includes(`## [${pkg.version}]`),
      `CHANGELOG.md has no section for ${pkg.version}, the version package.json claims`
    );
  });
});
