#!/usr/bin/env bun
/**
 * rilis-catatan.mjs — prints one version's `CHANGELOG.md` section to
 * stdout, with neither its own heading nor anything else the file did not
 * write for that version.
 *
 * Built for `.github/workflows/release.yml` (issue #181): a tag push (or a
 * `workflow_dispatch` backfill) runs this script and redirects its stdout to
 * the file `gh release create --notes-file` / `gh release edit --notes-file`
 * reads, so whatever this prints becomes the GitHub Release body verbatim.
 * Nothing here may write anything but the section body to STDOUT — every
 * diagnostic goes to stderr instead, which is also where a human running
 * this by hand looks first.
 *
 * The actual parsing — finding a version's section, refusing a CHANGELOG.md
 * heading that has drifted from the one shape this relies on — is pure logic
 * in `packages/gerbang/lib/changelog.mjs`, unit-tested directly in
 * `tests/rilis-catatan.test.mjs`. This file is the thin CLI shell around it:
 * read the file, call the function, print or fail.
 *
 * Usage:
 *   bun tools/rilis-catatan.mjs v0.10.0
 *   bun tools/rilis-catatan.mjs 0.10.0                     # the `v` is optional
 *   bun tools/rilis-catatan.mjs 0.10.0 --file CHANGELOG.md # default shown; rarely needed
 *
 * Exits 1, with a message on stderr, when no version is given, the file does
 * not exist, the version has no section, or the version argument itself does
 * not parse as `X.Y.Z`.
 */
import { changelogSection } from "../packages/gerbang/lib/changelog.mjs";
import { readFileIfPresent } from "../packages/gerbang/lib/files.mjs";

/**
 * @param {string[]} argv
 * @returns {{ file: string, version: string | undefined }}
 */
function parseArgs(argv) {
  let file = "CHANGELOG.md";
  let version;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") {
      i++;
      file = argv[i];
    } else if (version === undefined) {
      version = argv[i];
    }
  }

  return { file, version };
}

const { file, version } = parseArgs(process.argv.slice(2));

if (!version || !file) {
  console.error("Usage: bun tools/rilis-catatan.mjs <version> [--file CHANGELOG.md]");
  console.error("  e.g.: bun tools/rilis-catatan.mjs v0.10.0");
  process.exit(1);
}

const text = readFileIfPresent(file);
if (text === null) {
  console.error(`${file} does not exist.`);
  process.exit(1);
}

try {
  console.log(changelogSection(text, version));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
