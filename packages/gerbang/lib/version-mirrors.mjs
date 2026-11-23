/**
 * version-mirrors.mjs — copies of the product version that live outside the
 * root `package.json`, and the release step that keeps them equal to it.
 *
 * ## Why a mirror exists
 *
 * An image built from a subfolder alone (the `apps/cms` image) cannot read the
 * repository-root `package.json`. A version shown inside such an application
 * therefore needs its own copy of the number, and a hand-maintained copy
 * drifts: the release bumps the root and the constant keeps the old value.
 *
 * ## The contract
 *
 * A mirror is `{ "file": "<repo-relative path>", "pattern": "<regex source>" }`.
 * The pattern has EXACTLY ONE capture group, and the text that group captures
 * is the version. A release replaces just that group, so the surrounding
 * source is untouched. Declared in `tools/version-mirrors.json`; the template
 * ships an empty list and a derived product fills it.
 *
 * ## Why it fails loudly
 *
 * A mirror whose file is missing, whose pattern matches nothing or matches
 * more than once, or whose captured text is not a version, is an error and
 * never a skip: a skipped mirror is a mirror that silently drifts again,
 * which is the defect this module exists to remove. `planMirrors` collects
 * every problem and computes every new file content in memory BEFORE the
 * caller writes anything, so a release that cannot rewrite one mirror leaves
 * the tree untouched.
 *
 * This module is side-effect free: importing it runs and prints nothing.
 */
import fs from "node:fs";
import path from "node:path";

import { parseVersion } from "./semver.mjs";

/** Repo-relative location of the declaration, read by `tools/rilis.mjs`. */
export const MIRRORS_CONFIG_PATH = "tools/version-mirrors.json";

/**
 * Validates the parsed config and returns its mirror list.
 * @param {unknown} config
 * @returns {{ file: string, pattern: string }[]}
 */
export function parseMirrorConfig(config) {
  if (config === null || typeof config !== "object" || !Array.isArray(config.mirrors)) {
    throw new Error(`${MIRRORS_CONFIG_PATH}: expected an object with a "mirrors" array.`);
  }
  const problems = [];
  const seen = new Set();
  config.mirrors.forEach((m, i) => {
    const where = `${MIRRORS_CONFIG_PATH}: mirrors[${i}]`;
    if (m === null || typeof m !== "object" || typeof m.file !== "string" || typeof m.pattern !== "string") {
      problems.push(`${where} must be { "file": string, "pattern": string }.`);
      return;
    }
    if (m.file === "" || path.isAbsolute(m.file) || m.file.split(/[\\/]/).includes("..")) {
      problems.push(`${where}.file must be a repository-relative path without "..": ${JSON.stringify(m.file)}.`);
    }
    if (seen.has(m.file)) problems.push(`${where}.file is declared twice: ${m.file}.`);
    seen.add(m.file);
    try {
      // `|` with an empty alternative always matches, exposing the group count.
      const groups = new RegExp(`${m.pattern}|`).exec("").length - 1;
      if (groups !== 1) problems.push(`${where}.pattern must have exactly one capture group, found ${groups}.`);
    } catch (e) {
      problems.push(`${where}.pattern is not a valid regular expression: ${e.message}`);
    }
  });
  if (problems.length) throw new Error(problems.join("\n"));
  return config.mirrors;
}

/** Reads and validates the config under `root`; a missing file is an error. */
export function loadMirrors(root) {
  const file = path.join(root, MIRRORS_CONFIG_PATH);
  if (!fs.existsSync(file)) throw new Error(`${MIRRORS_CONFIG_PATH} does not exist.`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${MIRRORS_CONFIG_PATH} is not valid JSON: ${e.message}`);
  }
  return parseMirrorConfig(parsed);
}

/** Locates the single capture group of the single match, or explains why not. */
function locate(text, mirror) {
  const re = new RegExp(mirror.pattern, "dg");
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return { error: `pattern ${JSON.stringify(mirror.pattern)} matches nothing` };
  if (matches.length > 1) {
    return { error: `pattern ${JSON.stringify(mirror.pattern)} matches ${matches.length} times, expected exactly once` };
  }
  const span = matches[0].indices[1];
  if (!span) return { error: `pattern ${JSON.stringify(mirror.pattern)} matched but its capture group did not participate` };
  return { start: span[0], end: span[1], current: text.slice(span[0], span[1]) };
}

/**
 * Computes, in memory, what each mirror would become at `version`. Throws one
 * error listing every mirror that cannot be rewritten; writes nothing.
 * @returns {{ file: string, before: string, after: string, from: string }[]}
 */
export function planMirrors(root, mirrors, version) {
  parseVersion(version);
  const plan = [];
  const problems = [];
  for (const mirror of mirrors) {
    const abs = path.join(root, mirror.file);
    if (!fs.existsSync(abs)) {
      problems.push(`${mirror.file}: file does not exist`);
      continue;
    }
    const before = fs.readFileSync(abs, "utf8");
    const hit = locate(before, mirror);
    if (hit.error) {
      problems.push(`${mirror.file}: ${hit.error}`);
      continue;
    }
    try {
      parseVersion(hit.current);
    } catch {
      problems.push(`${mirror.file}: the captured text ${JSON.stringify(hit.current)} is not an X.Y.Z version`);
      continue;
    }
    plan.push({
      file: mirror.file,
      before,
      after: before.slice(0, hit.start) + version + before.slice(hit.end),
      from: hit.current
    });
  }
  if (problems.length) {
    throw new Error(
      `${problems.length} version mirror(s) cannot be rewritten to ${version}:\n` +
        problems.map((p) => `  ${p}`).join("\n")
    );
  }
  return plan;
}

/** Writes a plan produced by `planMirrors`. */
export function applyMirrorPlan(root, plan) {
  for (const { file, after } of plan) fs.writeFileSync(path.join(root, file), after);
}

/**
 * The guarantee behind the root test: every mirror currently equals `version`.
 * Returns human-readable problems, empty when all agree.
 */
export function findMirrorMismatches(root, mirrors, version) {
  const problems = [];
  for (const mirror of mirrors) {
    const abs = path.join(root, mirror.file);
    if (!fs.existsSync(abs)) {
      problems.push(`${mirror.file}: file does not exist`);
      continue;
    }
    const hit = locate(fs.readFileSync(abs, "utf8"), mirror);
    if (hit.error) problems.push(`${mirror.file}: ${hit.error}`);
    else if (hit.current !== version) {
      problems.push(`${mirror.file}: mirrors ${hit.current} but package.json is ${version}`);
    }
  }
  return problems;
}
