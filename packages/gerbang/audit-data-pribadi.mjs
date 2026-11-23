#!/usr/bin/env bun
/**
 * audit-data-pribadi.mjs — the gate over personal data in the git tree.
 *
 * ## The question this gate exists to ask
 *
 * Fixtures, snapshots, logs and pasted issue text are where a real
 * identifier ends up by accident, and without a mechanical check it is found
 * only by a reviewer who happens to look. This gate scans every git-tracked
 * file for five generic categories (see `lib/data-pribadi-config.mjs`):
 * national-identity-number-shaped numbers, mobile numbers, e-mail addresses
 * outside placeholder domains, cloud-drive links carrying a file id, and
 * tracked spreadsheet/CSV/archive/log/snapshot files.
 *
 * ## Rules it follows
 *
 *   - **Findings never print the value.** Output is `path:line` under a
 *     `[category]` heading; copying a leaked identifier into CI logs would
 *     be a second leak.
 *   - **False positives live in an allow-list**, one entry with a reason
 *     each (`data-pribadi-allowlist.json`, next to this file). An entry that
 *     covers nothing fails the gate, so the list cannot rot.
 *   - **The embedded upstream subtree is skipped**, except for paths a
 *     derived product declares as its own in `OWNED_SUBTREE_PATHS`.
 *   - **`--history` is an opt-in diagnostic**, never part of CI: it scans the
 *     lines added by past commits and prints `commit path [category]`, and
 *     always exits 0, because history cannot be fixed by an edit.
 *
 * Adapted in shape from `audit-rilis.mjs`; the checks are in
 * `lib/data-pribadi.mjs`, the data in `lib/data-pribadi-config.mjs`.
 *
 * Run: `bun run audit:data-pribadi` (add `--history` for the diagnostic, or
 * `--root <dir>` to scan another git work tree).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as config from "./lib/data-pribadi-config.mjs";
import {
  applyAllowList,
  isDataFile,
  isInScope,
  scanDiff,
  scanText,
  validateAllowList
} from "./lib/data-pribadi.mjs";
import { gitLines, gitRun } from "./lib/git.mjs";
import { createReporter } from "./lib/reporter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = "packages/gerbang/data-pribadi-allowlist.json";

/**
 * `--root <dir>` points the gate at another git work tree (the tests use it
 * to scan a fixture repository); the default is this repository.
 */
const rootFlag = process.argv.indexOf("--root");
const ROOT = rootFlag >= 0 ? resolve(process.argv[rootFlag + 1] ?? ".") : resolve(HERE, "..", "..");

const reporter = createReporter("audit:data-pribadi");
const historyMode = process.argv.includes("--history");

/** True when the first 8 KiB holds a NUL byte, i.e. the file is not text. */
function looksBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

const listing = gitRun(ROOT, "ls-files", "-z");
if (listing === null) {
  reporter.note("scan: SKIPPED — not a git repository, `git ls-files` unavailable");
  reporter.finish();
}

if (historyMode) {
  const log = gitRun(
    ROOT,
    "log",
    "--all",
    "-p",
    "--no-color",
    "--unified=0",
    "--format=commit %H",
    "--",
    ".",
    ":(exclude)apps/cms"
  );
  if (log === null) {
    reporter.note("history: SKIPPED — `git log` unavailable");
  } else {
    const historyHits = scanDiff(log, config);
    reporter.note(`history: ${historyHits.length} hit(s) in added lines (diagnostic only; values never printed)`);
    for (const { commit, path, category } of historyHits) reporter.note(`  ${commit} ${path} [${category}]`);
  }
  // Diagnostic: always green. Notes print whatever the outcome.
  reporter.finish();
}

const tracked = listing.split("\0").filter(Boolean);
const inScope = tracked.filter((path) => isInScope(path, config));

/** @type {import("./lib/data-pribadi.mjs").Finding[]} */
const hits = [];
let scanned = 0;
let skippedBinary = 0;
let skippedLarge = 0;

for (const path of inScope) {
  if (isDataFile(path, config)) hits.push({ path, line: 0, category: "tracked-data-file" });

  const absolute = join(ROOT, path);
  if (!existsSync(absolute)) continue; // tracked but deleted in the working tree
  const stat = statSync(absolute);
  if (!stat.isFile()) continue; // a symlink to a directory, a submodule
  if (stat.size > config.MAX_SCAN_BYTES) {
    skippedLarge += 1;
    continue;
  }
  const buffer = readFileSync(absolute);
  if (looksBinary(buffer)) {
    skippedBinary += 1;
    continue;
  }
  scanned += 1;
  for (const { line, category } of scanText(buffer.toString("utf8"), config)) {
    hits.push({ path, line, category });
  }
}

reporter.note(
  `${tracked.length} tracked file(s), ${inScope.length} in scope ` +
    `(${tracked.length - inScope.length} under the skipped subtree), ${scanned} text file(s) scanned, ` +
    `${skippedBinary} binary and ${skippedLarge} oversized skipped`
);

/** @type {import("./lib/data-pribadi.mjs").AllowEntry[]} */
let entries = [];
if (existsSync(join(ROOT, ALLOWLIST_PATH))) {
  try {
    entries = JSON.parse(readFileSync(join(ROOT, ALLOWLIST_PATH), "utf8")).entries ?? [];
  } catch {
    reporter.violation("allow-list", ALLOWLIST_PATH, "is not valid JSON");
  }
} else {
  reporter.note(`allow-list: ${ALLOWLIST_PATH} does not exist — no entries applied`);
}

const problems = validateAllowList(entries, config);
for (const { index, message } of problems) {
  reporter.violation(
    "allow-list",
    ALLOWLIST_PATH,
    index < 0 ? message : `entry #${index + 1}: ${message}`
  );
}

if (problems.length === 0) {
  const { remaining, unused } = applyAllowList(hits, entries);
  reporter.note(`allow-list: ${entries.length} entr(ies), ${hits.length - remaining.length} finding(s) covered`);
  for (const index of unused) {
    reporter.violation(
      "allow-list-unused",
      ALLOWLIST_PATH,
      `entry #${index + 1} (${entries[index].path}, ${entries[index].category}) covers nothing — remove it`
    );
  }
  for (const { path, line, category } of remaining) {
    reporter.violation(category, line > 0 ? `${path}:${line}` : path, `possible ${category} (value not shown)`);
  }
} else {
  reporter.note("findings: not evaluated — fix the allow-list first");
}

reporter.finish();
