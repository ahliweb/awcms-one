/**
 * docs-cleanup.mjs — the narrow, mechanical follow-on `template:init`'s own
 * removal step needs so its OWN trailing `audit:dokumen` gate (D5's "so a
 * derived repo's first commit is already green") does not immediately
 * redden on paths it just deleted.
 *
 * `bun run audit:dokumen`'s named-path check (`packages/gerbang/
 * audit-dokumen.mjs`) flags any backtick-quoted span in a markdown file
 * that names a path absent from the repo. This repository's own inherited
 * documentation (`docs/deployment.md`, `docs/api.md`, `docs/cms.md`,
 * `apps/storefront/README.md`, `knowledge/curated/monorepo-map.md`, and
 * others) cites `tools/seed-borneojek-mart.ts`/`tools/import-
 * seputarborneo.ts` by exact backticked path — the moment `template:init`
 * removes those files, every one of those citations goes red.
 *
 * This is deliberately NOT a BjekMart content purge (`docs/template.md`'s
 * own "What 'no BjekMart string left' actually means" section is explicit
 * that a full sweep is out of this tool's scope, and belongs to issue
 * #140's documentation pass). It is the mechanical minimum: for every path
 * this run ACTUALLY removed, strip the BACKTICKS around any exact citation
 * of it in a markdown file, so the citation becomes plain prose instead of
 * a path assertion the gate checks — `` `tools/seed-borneojek-mart.ts` ``
 * becomes `tools/seed-borneojek-mart.ts`. The sentence still reads (a
 * human still sees which file used to do this), it is simply no longer a
 * dead path claim.
 *
 * `apps/cms/**` is never scanned or written — the subtree embed's own
 * documentation is upstream's, not this tool's.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "graphify-out"]);
const SKIP_TOP_LEVEL = new Set(["apps/cms"]);

/**
 * @param {string} root
 * @returns {string[]} every `*.md` file, relative to `root`
 */
function listMarkdownFiles(root) {
  /** @type {string[]} */
  const out = [];
  /**
   * @param {string} dirAbs
   */
  function walk(dirAbs) {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dirAbs, entry.name);
      const rel = relative(root, abs);
      if (SKIP_TOP_LEVEL.has(rel)) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(abs);
      } else if (entry.name.endsWith(".md")) {
        out.push(rel);
      }
    }
  }
  walk(root);
  return out;
}

/**
 * @param {string} root
 * @param {string[]} removedPaths - paths (files or directories) `template:init` is about to remove in THIS run
 * @param {Map<string, string>} [overlay] - already-computed NEW content for
 *   a markdown file also present in this same run's flag-driven rewrites
 *   (`plan.mjs`'s `rewrites`, keyed by path) — read from HERE instead of
 *   disk when present, so this cleanup layers on top of the hero/section
 *   rewrite instead of overwriting it with a version derived from the
 *   file's PRE-rewrite content. Without this, `README.md` (which both
 *   gets its hero rewritten AND cites a removed tool path elsewhere in the
 *   same file) would have its hero rewrite silently discarded the moment
 *   this cleanup ran after it and wrote from a stale read.
 * @returns {{ path: string, before: string, after: string }[]} only entries that actually change
 */
export function planDocCitationCleanup(root, removedPaths, overlay = new Map()) {
  if (removedPaths.length === 0) return [];
  const tokens = removedPaths.flatMap((p) => [`\`${p}\``, `\`${p}/\``, `\`${p}/**\``]);

  const edits = [];
  for (const file of listMarkdownFiles(root)) {
    const before = overlay.get(file) ?? readFileSync(join(root, file), "utf8");
    let after = before;
    for (const token of tokens) {
      if (after.includes(token)) {
        // Strip only the backticks, keeping the path itself as plain prose.
        after = after.split(token).join(token.slice(1, -1));
      }
    }
    if (after !== before) edits.push({ path: file, before, after });
  }
  return edits;
}
