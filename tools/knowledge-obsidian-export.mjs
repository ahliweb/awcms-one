#!/usr/bin/env bun
/**
 * knowledge-obsidian-export.mjs — `bun run knowledge:obsidian:export`.
 *
 * Exports THIS workspace's root graph (`graphify-out/graph.json` — never the
 * combined federated graph; see "Why the root graph, not the combined one"
 * below) as an Obsidian vault, validates every file it produced, and
 * syncs only what passes onto `knowledge/generated/graphify/`.
 *
 * ## The three-stage boundary (issue #11, Scope §4)
 *
 *   1. **Stage.** `graphify export obsidian --dir graphify-out/obsidian-staging`
 *      writes into a gitignored, ephemeral directory — never directly into
 *      `knowledge/`. This is the line that protects against an upstream
 *      exporter regression: even if a future `graphify` version writes
 *      somewhere it should not, it is still writing into a throwaway
 *      directory this script controls, not into tracked content.
 *   2. **Validate.** Every entry graphify wrote is walked, classified, and
 *      path-contained by `packages/gerbang/lib/obsidian-safety.mjs`. A
 *      REJECT from any entry — a symlink, an unexpected extension, a path
 *      that resolves outside staging, a filename colliding with something
 *      already in `knowledge/curated/` — aborts the ENTIRE sync. Nothing
 *      partial is ever written: a sync that copied 300 good notes and
 *      silently dropped one bad one is worse than a sync that copied
 *      nothing and said why.
 *   3. **Sync.** Only entries classified `sync` (an allowlist, not a
 *      denylist) are copied into `knowledge/generated/graphify/`, which is
 *      cleared of its own previous `.md`/`.canvas` output first — so a note
 *      for a node that no longer exists does not linger and mislead. Every
 *      other file already in that directory (there should be none) is left
 *      alone.
 *
 * ## Why the root graph, not the combined one
 *
 * `graphify export obsidian` writes one note per NODE. Running it against
 * `graphify-out/combined/graph.json` (root + `apps/cms`'s ~12700 nodes)
 * would re-materialise almost all of `apps/cms`'s own graph as committed
 * markdown at the root — exactly the duplication issue #11's Objective
 * forbids ("do not build and commit a second copy of the entire apps/cms
 * graph at the monorepo root"), just in note form instead of JSON. The
 * federated graph stays what issue #11 calls it: "an analysis view, not a
 * new authority" — queried live (`graphify query` / `path` / `explain
 * --graph graphify-out/combined/graph.json`), never exported to a tracked
 * vault by this script. A developer who wants a personal, full federated
 * Obsidian vault can run `graphify export obsidian --dir ~/wherever
 * --graph graphify-out/combined/graph.json` themselves — that is a local,
 * gitignored, personal artefact this workflow does not manage.
 *
 * `knowledge/curated/` is never written by this script, only READ once, to
 * build the collision-check set — see `checkCuratedCollision`.
 *
 * Needs the real `graphify` binary on `PATH` (not installed in CI). Not part
 * of `bun test`; the validation logic it calls into IS, against fixtures,
 * with no `graphify` and no real staging tree involved.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import {
  checkCuratedCollision,
  classifyEntry,
  resolveWithin
} from "../packages/gerbang/lib/obsidian-safety.mjs";

// KNOWLEDGE_GRAPH_ROOT overrides the repo root this script operates on — for
// tests only (tests/knowledge-no-subtree-write.test.mjs runs this file for
// real against a disposable fixture tree, never against this repo's own
// apps/cms/ or knowledge/). Unset in every real invocation.
const ROOT = process.env.KNOWLEDGE_GRAPH_ROOT ?? resolve(import.meta.dirname, "..");
const STAGING = join(ROOT, "graphify-out/obsidian-staging");
const GENERATED = join(ROOT, "knowledge/generated/graphify");
const CURATED = join(ROOT, "knowledge/curated");

/** Extensions this script is allowed to DELETE from `GENERATED` before a re-sync — its own previous output, nothing else. */
const ALLOWED_TO_CLEAR = new Set([".md", ".canvas"]);

function fail(reasons) {
  console.error("knowledge:obsidian:export FAILED — nothing synced:");
  for (const reason of reasons) console.error(`  - ${reason}`);
  process.exit(1);
}

if (!existsSync(join(ROOT, "graphify-out/graph.json"))) {
  fail(["graphify-out/graph.json does not exist — run `bun run knowledge:graph:update` first."]);
}

rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });

console.log("Exporting the root graph to a staging vault...");
const proc = Bun.spawnSync(["graphify", "export", "obsidian", "--dir", STAGING], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit"
});

if (proc.exitCode !== 0) {
  fail([`\`graphify export obsidian\` exited ${proc.exitCode}`]);
}

const sepToPosix = process.platform === "win32" ? "\\" : "/";

/** @returns {{ relativePath: string, isSymlink: boolean }[]} every entry under `dir`, POSIX-relative to it */
function walk(dir) {
  /** @type {{ relativePath: string, isSymlink: boolean }[]} */
  const entries = [];

  function recurse(current) {
    for (const name of readdirSync(current)) {
      const absolute = join(current, name);
      const stat = lstatSync(absolute);
      const relativePath = relative(STAGING, absolute).split(sepToPosix).join("/");

      if (stat.isSymbolicLink()) {
        entries.push({ relativePath, isSymlink: true });
        continue;
      }
      if (stat.isDirectory()) {
        recurse(absolute);
        continue;
      }
      entries.push({ relativePath, isSymlink: false });
    }
  }

  recurse(dir);
  return entries;
}

const curatedBasenames = existsSync(CURATED)
  ? new Set(readdirSync(CURATED).filter((name) => name.endsWith(".md")))
  : new Set();

const entries = walk(STAGING);
const rejections = [];
const syncable = [];
let skipped = 0;

for (const { relativePath, isSymlink } of entries) {
  const contained = resolveWithin(STAGING, relativePath);
  if (!contained.ok) {
    rejections.push(contained.reason);
    continue;
  }

  const verdict = classifyEntry(relativePath, isSymlink);
  if (verdict.action === "reject") {
    rejections.push(`${relativePath} ${verdict.reason}`);
    continue;
  }
  if (verdict.action === "skip") {
    skipped += 1;
    continue;
  }

  // verdict.action === "sync"
  const basename = relativePath.split("/").pop();
  const collision = checkCuratedCollision(basename, curatedBasenames);
  if (!collision.ok) {
    rejections.push(collision.reason);
    continue;
  }

  const destination = resolveWithin(GENERATED, basename);
  if (!destination.ok) {
    rejections.push(destination.reason);
    continue;
  }

  syncable.push({ source: join(STAGING, relativePath), destination: destination.absolute, basename });
}

if (rejections.length > 0) {
  fail(rejections);
}

mkdirSync(GENERATED, { recursive: true });

// Clear only our own previous output — allowlisted extensions, this
// directory only, never recursive into knowledge/ or knowledge/curated/.
if (existsSync(GENERATED)) {
  for (const name of readdirSync(GENERATED)) {
    if (ALLOWED_TO_CLEAR.has(extname(name))) {
      rmSync(join(GENERATED, name), { force: true });
    }
  }
}

for (const { source, destination } of syncable) {
  copyFileSync(source, destination);
}

console.log(
  `knowledge:obsidian:export OK — ${syncable.length} file(s) synced to knowledge/generated/graphify/ ` +
    `(${skipped} housekeeping entr(y/ies) skipped, ${curatedBasenames.size} curated file(s) checked for collisions).`
);
