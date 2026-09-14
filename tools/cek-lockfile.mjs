#!/usr/bin/env bun
/**
 * Proves `bun.lock` actually belongs to this repo's `package.json` — for the
 * root AND for every workspace member, not only the root.
 *
 * ## Why this gate exists
 *
 * A lockfile copied wholesale from a different project — or one that has
 * simply drifted from `package.json` because a dependency was hand-edited
 * without reinstalling — installs whatever it says, silently. `bun install
 * --frozen-lockfile` is stricter than that in general, but it answers a
 * narrower question than this gate does:
 *
 *   1. It runs **after** dependencies would already be fetched over the
 *      network; this gate runs before, and needs neither. Its failure reads
 *      "the lockfile has drifted", not an install failure whose cause has to
 *      be guessed.
 *   2. It does not check **identity** — that `bun.lock`'s own workspace
 *      names actually belong to this project. A lockfile copied from
 *      another repo, with a `name` field that never matches, would still
 *      satisfy a plain frozen install as long as its dependency ranges
 *      happen to resolve.
 *   3. It states the rule as readable code, not as the implicit behaviour of
 *      a CLI flag that can change between Bun releases.
 *
 * This mechanism is adapted from `ahliweb/media-lenterakalteng`'s
 * `tools/cek-lockfile.mjs` (itself written after that repo found a copied
 * lockfile installing packages nobody had declared, silently, because `npm
 * ci` at the time rejected a lockfile with too FEW entries but accepted one
 * with too MANY). Bun's stricter `--frozen-lockfile` removes part of that
 * specific risk; this gate is kept anyway for the three reasons above.
 *
 * ## What is checked, per package.json (root and every workspace member)
 *
 * The package name and the WHOLE dependency block must match the
 * corresponding `bun.lock` entry exactly. Pure file reads — no network, no
 * `node_modules` — so it is safe to run before `bun install`.
 *
 * The workspace list is NOT hand-written here: it is read from `workspaces`
 * in the root `package.json` (glob patterns like `apps/*`), and every
 * directory that actually has a `package.json` is checked. A new package
 * under `apps/` or `packages/` is therefore checked automatically, with no
 * new line in this file.
 *
 * ## What is deliberately NOT checked
 *
 * The content of the tree outside a workspace entry (transitive resolution
 * ranges). `bun.lock` does not record a project VERSION at all (unlike
 * `package-lock.json`, which used to store it in two places), so bumping a
 * release version cannot drift the lockfile — one class of defect that
 * disappeared entirely with the move to Bun.
 *
 * Regenerating the lockfile: `rm -rf node_modules bun.lock && bun install`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTrailingCommas } from "../packages/gerbang/lib/lockfile.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} fileName */
function readJsonc(fileName) {
  const path = join(repoRoot, fileName);
  try {
    return JSON.parse(stripTrailingCommas(readFileSync(path, "utf8")));
  } catch (error) {
    console.error(`Could not read ${fileName}: ${error.message}`);
    process.exit(1);
  }
}

const rootPkg = readJsonc("package.json");
const lock = readJsonc("bun.lock");

const problems = [];

if (lock.lockfileVersion === undefined) {
  problems.push("bun.lock does not declare lockfileVersion — probably not a Bun lockfile.");
}

/**
 * REAL workspace directories that have a `package.json`, found from the
 * one-level glob patterns in the root `workspaces` (e.g. `apps/*`,
 * `packages/*`) — not a hand-written list, so a new package is checked
 * without a new line here.
 *
 * @returns {{ path: string, pkg: object }[]} POSIX-relative paths (e.g.
 *   `apps/storefront`) paired with their parsed `package.json`.
 */
function findWorkspaces() {
  const result = [];

  for (const pattern of rootPkg.workspaces ?? []) {
    const match = /^([^*]+)\*$/.exec(pattern);
    if (!match) {
      problems.push(
        `workspace pattern "${pattern}" in package.json is not shaped "<dir>/*" — extend findWorkspaces() in tools/cek-lockfile.mjs`
      );
      continue;
    }

    const parentRelative = match[1].replace(/\/$/, "");
    const parentAbsolute = join(repoRoot, parentRelative);
    if (!existsSync(parentAbsolute)) continue;

    for (const entry of readdirSync(parentAbsolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const relativePath = `${parentRelative}/${entry.name}`;
      const pkgPath = join(repoRoot, relativePath, "package.json");
      if (!existsSync(pkgPath)) continue;

      result.push({ path: relativePath, pkg: readJsonc(join(relativePath, "package.json")) });
    }
  }

  return result;
}

const foundWorkspaces = findWorkspaces();

/** The workspace root (`""`) plus every real workspace, each with its lock path. */
const ALL_PACKAGES = [{ path: "", pkg: rootPkg }, ...foundWorkspaces];

const DEPENDENCY_BLOCKS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];

for (const { path, pkg } of ALL_PACKAGES) {
  const label = path === "" ? "root" : path;
  const lockEntry = lock.workspaces?.[path];

  if (!lockEntry) {
    problems.push(
      `bun.lock has no workspace entry for "${path}" (workspaces[${JSON.stringify(path)}]). Regenerate the lockfile.`
    );
    continue;
  }

  if (lockEntry.name !== pkg.name) {
    problems.push(
      `${label}: lockfile entry name = ${JSON.stringify(lockEntry.name)}, package.json name = ${JSON.stringify(pkg.name)}. This lockfile belongs to a different project.`
    );
  }

  for (const block of DEPENDENCY_BLOCKS) {
    const inManifest = pkg[block] ?? {};
    const inLock = lockEntry[block] ?? {};

    for (const [name, range] of Object.entries(inManifest)) {
      if (!(name in inLock)) {
        problems.push(`${label} ${block}: "${name}" is in package.json but not in bun.lock.`);
      } else if (inLock[name] !== range) {
        problems.push(
          `${label} ${block}: "${name}" is requested as ${range} in package.json, but bun.lock records ${inLock[name]}.`
        );
      }
    }

    for (const name of Object.keys(inLock)) {
      if (!(name in inManifest)) {
        problems.push(
          `${label} ${block}: "${name}" is in bun.lock but NOT declared in package.json — it still installs on every install.`
        );
      }
    }
  }
}

/**
 * The other direction: a `bun.lock` entry that matches no `package.json`
 * actually found in this working tree — e.g. a lockfile left behind after a
 * package was removed or moved without regenerating.
 */
const foundPaths = new Set(ALL_PACKAGES.map(({ path }) => path));
for (const lockPath of Object.keys(lock.workspaces ?? {})) {
  if (!foundPaths.has(lockPath)) {
    problems.push(
      `bun.lock has a workspace entry for "${lockPath}" but no such package.json exists in this working tree. Regenerate the lockfile.`
    );
  }
}

if (problems.length > 0) {
  console.error("bun.lock is out of sync with package.json:\n");
  for (const line of problems) {
    console.error(`  - ${line}`);
  }
  console.error("\nFix with a full regeneration:");
  console.error("\n  rm -rf node_modules bun.lock && bun install\n");
  process.exit(1);
}

console.log(
  `bun.lock is in sync with package.json — root + ${foundWorkspaces.length} workspace(s) (${foundWorkspaces
    .map(({ path }) => path)
    .join(", ")}).`
);
