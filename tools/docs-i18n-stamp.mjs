#!/usr/bin/env bun
/**
 * docs-i18n-stamp.mjs — puts the translation bookkeeping where the
 * translation gate expects to find it.
 *
 * For every `<name>.id.md` mirror that has a `<name>.md` source, this:
 *
 *  1. writes the language-switcher banner on BOTH files, naming English as
 *     the source — a banner that lies about which file is authoritative
 *     sends the next editor to change the wrong one;
 *  2. records `<!-- i18n-source-hash: sha256:... -->` in the MIRROR, hashing
 *     the English source;
 *  3. REMOVES any marker left in the English source. A marker on the source
 *     side is not inert — it looks like bookkeeping and records nothing.
 *
 * Idempotent: running it twice changes nothing. It does NOT translate; it
 * only moves the bookkeeping, which is why `--check` can be trusted to say
 * whether a tree is already correct.
 *
 * Usage:
 *   bun run docs:i18n:stamp            # rewrite banners + markers in place
 *   bun run docs:i18n:stamp --check    # report what would change, exit 1 if any
 */
import { writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  MARKER_REGEX,
  computeSourceHash,
  deriveSourcePath,
  isMirrorInScope
} from "../packages/gerbang/lib/docs-i18n-checks.mjs";
import { readFileIfPresent } from "../packages/gerbang/lib/files.mjs";
import { gitLines, gitRun } from "../packages/gerbang/lib/git.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CHECK_ONLY = process.argv.includes("--check");

/** A line is a language banner when it opens with either flag. */
const BANNER_REGEX = /^(?:🇬🇧|🇮🇩).*$/u;

/**
 * A leading YAML frontmatter block, which must stay the FIRST bytes of the
 * file. Prepending a banner above it would not fail loudly — a would-be
 * frontmatter reader would just stop treating it as frontmatter — so the
 * banner always goes AFTER any such block, not before the file.
 */
const FRONTMATTER_REGEX = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/;

/**
 * @param {string} content
 * @returns {{ frontmatter: string, body: string }}
 */
function splitFrontmatter(content) {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) return { frontmatter: "", body: content };
  const block = match[0];
  return { frontmatter: block, body: content.slice(block.length) };
}

/**
 * Apply `transform` to the body only, leaving any frontmatter block
 * untouched and still first.
 *
 * @param {string} content
 * @param {(body: string) => string} transform
 * @returns {string}
 */
function inBody(content, transform) {
  const { frontmatter, body } = splitFrontmatter(content);
  if (!frontmatter) return transform(body);
  return `${frontmatter}\n${transform(body.replace(/^\s*\n/, ""))}`;
}

/**
 * @param {string} mirrorPath
 * @returns {string}
 */
function englishBanner(mirrorPath) {
  return `🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](${basename(mirrorPath)})`;
}

/**
 * @param {string} sourcePath
 * @returns {string}
 */
function indonesianBanner(sourcePath) {
  return `🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](${basename(sourcePath)})`;
}

/**
 * Replace a leading banner line, or insert one. Everything after the banner
 * is preserved byte for byte — this tool must never be a reason to
 * re-review prose.
 *
 * @param {string} content
 * @param {string} banner
 * @returns {string}
 */
function withBanner(content, banner) {
  const lines = content.split("\n");
  if (lines.length > 0 && BANNER_REGEX.test(lines[0] ?? "")) {
    lines[0] = banner;
    return lines.join("\n");
  }
  return `${banner}\n\n${content}`;
}

/**
 * @param {string} content
 * @returns {string}
 */
function withoutMarker(content) {
  return content
    .split("\n")
    .filter((/** @type {string} */ line) => !MARKER_REGEX.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Marker goes immediately after the banner, before the first heading.
 *
 * @param {string} content
 * @param {string} hash
 * @returns {string}
 */
function withMarker(content, hash) {
  const stripped = withoutMarker(content);
  const lines = stripped.split("\n");
  const marker = `<!-- i18n-source-hash: ${hash} -->`;

  if (lines.length > 0 && BANNER_REGEX.test(lines[0] ?? "")) {
    const rest = lines.slice(1).join("\n").replace(/^\n+/, "");
    return `${lines[0]}\n\n${marker}\n\n${rest}`;
  }
  return `${marker}\n\n${stripped}`;
}

/**
 * @returns {string[]} `.id.md` mirrors this repo's stamper is responsible
 *   for — filtered through `isMirrorInScope`, the same predicate the
 *   translation gate (`check-docs-translation.mjs`) uses, for the same
 *   reason: without it this would enumerate every `.id.md` in the working
 *   tree, including the hundreds belonging to `apps/cms` (`ahliweb/awcms`,
 *   imported via `git subtree`). `apps/cms`'s own mirrors are upstream's to
 *   stamp, not this tool's.
 */
function listMirrors() {
  // Untracked mirrors included: a pair created in this change must be
  // stamped now, not after someone commits it.
  const output = gitRun(
    ROOT,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "*.id.md"
  );

  // Outside a git repo this stamper has no way to enumerate mirrors. It
  // says so and stops, rather than dying with a `node:child_process` stack
  // that names neither the script nor the cause.
  if (output === null) {
    console.log("docs:i18n:stamp SKIPPED — not a git repo, `git ls-files` cannot run.");
    process.exit(0);
  }

  return gitLines(output).filter(isMirrorInScope);
}

/** @type {string[]} */
const changed = [];

for (const mirrorPath of listMirrors()) {
  const sourcePath = deriveSourcePath(mirrorPath);
  if (!sourcePath) continue;

  const sourceFull = join(ROOT, sourcePath);

  const originalSource = readFileIfPresent(sourceFull);
  if (originalSource === null) continue;

  const nextSource = inBody(originalSource, (body) =>
    withBanner(withoutMarker(body), englishBanner(mirrorPath))
  );

  const mirrorFull = join(ROOT, mirrorPath);
  const originalMirror = readFileIfPresent(mirrorFull);
  if (originalMirror === null) continue;

  const nextMirror = inBody(originalMirror, (body) =>
    withMarker(
      withBanner(body, indonesianBanner(sourcePath)),
      // Hash the source AS IT WILL BE WRITTEN, not as it was read — otherwise
      // the banner rewrite above changes the file after we hashed it, and the
      // gate fails on a tree this tool just produced.
      computeSourceHash(nextSource)
    )
  );

  if (nextSource !== originalSource) {
    changed.push(sourcePath);
    if (!CHECK_ONLY) writeFileSync(sourceFull, nextSource);
  }
  if (nextMirror !== originalMirror) {
    changed.push(mirrorPath);
    if (!CHECK_ONLY) writeFileSync(mirrorFull, nextMirror);
  }
}

if (CHECK_ONLY) {
  if (changed.length > 0) {
    console.error(`docs:i18n:stamp --check FAILED — ${changed.length} file(s) need stamping:`);
    for (const file of changed) console.error(`  - ${file}`);
    process.exit(1);
  }
  console.log("docs:i18n:stamp --check OK — banners and markers are in place.");
} else {
  console.log(
    changed.length === 0
      ? "docs:i18n:stamp — nothing to do."
      : `docs:i18n:stamp — updated ${changed.length} file(s).`
  );
}
