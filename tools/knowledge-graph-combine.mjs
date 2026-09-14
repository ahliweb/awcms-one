#!/usr/bin/env bun
/**
 * knowledge-graph-combine.mjs — `bun run knowledge:graph:combine`.
 *
 * Merges this workspace's own root graph (`graphify-out/graph.json`) with
 * `apps/cms`'s own, ALREADY-BUILT graph (`apps/cms/graphify-out/graph.json`,
 * subtree-owned, read-only here) into one federated, cross-workspace view —
 * via the real `graphify merge-graphs` command, not a re-extraction of
 * either tree. This is the tool half of issue #11's central rule: never
 * build a second copy of `apps/cms`'s graph at the root; combine the two
 * that already exist instead.
 *
 * ## Fails closed
 *
 * `graphify merge-graphs` itself already refuses a missing file, unparsable
 * JSON, or a JSON object with no `nodes` key (verified directly against the
 * real toolchain — see `packages/gerbang/lib/graph-combine.mjs`'s own
 * docblock). What it does NOT refuse is a well-formed but EMPTY component
 * graph, which would merge in silently as if that workspace contributed
 * nothing. This script adds the checks graphify itself is missing, both
 * before invoking it (non-empty `nodes`, matching `directed` flags) and
 * after (the combined node count is never less than either input alone, and
 * never more than their sum) — see that module for the full reasoning. Any
 * failure, at any stage, means NOTHING is left behind under
 * `graphify-out/combined/`: a half-written or wrong combined graph is worse
 * than none, because a later `graphify query` against it would answer
 * confidently from bad data.
 *
 * ## Where the output goes, and why it is never committed
 *
 * `graphify-out/combined/graph.json` — gitignored (root `.gitignore`).
 * Issue #11's Objective is explicit that the federated graph is "an
 * analysis view, not a new authority": it exists to answer cross-workspace
 * questions on demand (`graphify query` / `path` / `explain --graph
 * graphify-out/combined/graph.json`), never to be read by anything this
 * repo ships. `bun run audit:graf` asserts nothing under
 * `graphify-out/combined/` is ever tracked.
 *
 * ## What this script never does
 *
 * It never writes anywhere under `apps/cms/` — every write path is passed
 * through `packages/gerbang/lib/subtree-guard.mjs`'s
 * `assertNotUnderSubtree` before use, even though the paths below are
 * hardcoded and could not resolve there today. That guard is what
 * `tests/knowledge-no-subtree-write.test.mjs` exercises directly, and what
 * keeps this true if this file is ever refactored to take a configurable
 * output path.
 *
 * Needs the real `graphify` binary on `PATH` (a local Python tool, not
 * installed in CI — see `.github/workflows/ci.yml`'s own comments on this
 * point). Not part of `bun test`; the validation logic it calls into
 * (`packages/gerbang/lib/graph-combine.mjs`) IS, against fixtures, with no
 * `graphify` involved.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { assertNotUnderSubtree } from "../packages/gerbang/lib/subtree-guard.mjs";
import { readFileIfPresent } from "../packages/gerbang/lib/files.mjs";
import {
  checkMergeInputsCompatible,
  checkMergedResult,
  validateGraphFile
} from "../packages/gerbang/lib/graph-combine.mjs";

// KNOWLEDGE_GRAPH_ROOT overrides the repo root this script operates on — for
// tests only (tests/knowledge-no-subtree-write.test.mjs runs this file for
// real against a disposable fixture tree, never against this repo's own
// apps/cms/). Unset in every real invocation, where it resolves to the
// actual repo root as before.
const ROOT = process.env.KNOWLEDGE_GRAPH_ROOT ?? resolve(import.meta.dirname, "..");
const ROOT_GRAPH = join(ROOT, "graphify-out/graph.json");
const CMS_GRAPH = join(ROOT, "apps/cms/graphify-out/graph.json");
const OUT_DIR = join(ROOT, "graphify-out/combined");
const OUT_GRAPH = join(OUT_DIR, "graph.json");

function fail(message) {
  console.error(`knowledge:graph:combine FAILED — ${message}`);
  if (existsSync(OUT_GRAPH)) rmSync(OUT_GRAPH, { force: true });
  process.exit(1);
}

const rootResult = validateGraphFile("root graphify-out/graph.json", readFileIfPresent(ROOT_GRAPH));
if (!rootResult.ok) {
  fail(`${rootResult.error} — run \`bun run knowledge:graph:update\` first.`);
}

const cmsResult = validateGraphFile("apps/cms/graphify-out/graph.json", readFileIfPresent(CMS_GRAPH));
if (!cmsResult.ok) {
  fail(`${cmsResult.error} — this is subtree-owned; it should have arrived via \`git subtree pull\`.`);
}

const incompatible = checkMergeInputsCompatible(rootResult.graph, cmsResult.graph);
if (incompatible.length > 0) {
  fail(incompatible.join("; "));
}

console.log(
  `Merging root (${rootResult.graph.nodes.length} nodes) with apps/cms (${cmsResult.graph.nodes.length} nodes)...`
);

mkdirSync(assertNotUnderSubtree(OUT_DIR, ROOT, "mkdir"), { recursive: true });

const outPath = assertNotUnderSubtree(OUT_GRAPH, ROOT, "write the combined graph to");
const proc = Bun.spawnSync(
  ["graphify", "merge-graphs", ROOT_GRAPH, CMS_GRAPH, "--out", outPath],
  { cwd: ROOT, stdout: "inherit", stderr: "inherit" }
);

if (proc.exitCode !== 0) {
  fail(`\`graphify merge-graphs\` exited ${proc.exitCode}`);
}

const mergedResult = validateGraphFile("combined graphify-out/combined/graph.json", readFileIfPresent(outPath));
if (!mergedResult.ok) {
  fail(mergedResult.error);
}

const shapeProblems = checkMergedResult(rootResult.graph, cmsResult.graph, mergedResult.graph);
if (shapeProblems.length > 0) {
  fail(shapeProblems.join("; "));
}

console.log(
  `knowledge:graph:combine OK — combined graph: ${mergedResult.graph.nodes.length} nodes ` +
    `(root ${rootResult.graph.nodes.length} + apps/cms ${cmsResult.graph.nodes.length}), ` +
    `written to graphify-out/combined/graph.json (gitignored, not committed).`
);
