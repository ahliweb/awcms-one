#!/usr/bin/env bun
/**
 * audit-graf.mjs — the root knowledge-graph gate.
 *
 * ## Why this exists now, when it did not before
 *
 * The root README used to say plainly that `audit:graf` was not ported from
 * `ahliweb/media-lenterakalteng`, because this repo had no `graphify-out/`
 * corpus for it to guard — and a gate that always passes trivially is worse
 * than no gate (README.md's own "Gates" section explains why). Issue #11
 * creates that corpus: a root-owned graph, built `--code-only` (no LLM,
 * no network — see `knowledge/README.md`), that deliberately excludes
 * `apps/cms/**` because that subtree already owns its own graph and its own
 * gate (`apps/cms/scripts/graph-artifacts-check.ts`, run via
 * `bun run check:cms`). This gate is the root half of that same discipline.
 *
 * ## What is checked
 *
 * Five questions shared with the model this gate is adapted from
 * (`apps/cms/scripts/graph-artifacts-check.ts` — see
 * `packages/gerbang/lib/graf-checks.mjs`'s own docblock for exactly what
 * carries over and what does not), plus two that exist only at a federated
 * root:
 *
 *   1. Only the tracked root artefacts (`graph.json`, `GRAPH_REPORT.md`,
 *      `manifest.json`, `cost.json`) are tracked under `graphify-out/`.
 *   2. `GRAPH_REPORT.md`'s Summary line agrees with `graph.json`'s own counts.
 *   3. Every community has a name somebody chose — not a placeholder, not a
 *      bare filename, not shared with another community.
 *   4. `.graphifyignore` still excludes `apps/cms` by a plain, enforceable
 *      entry (not only a glob).
 *   5. What is excluded stays excluded — `checkExclusionsHeld` — AND, more
 *      directly, **no node in the tracked graph has a `source_file` under
 *      `apps/cms/`** (`checkNoSubtreeNodes`) — the federation's central
 *      promise, checked twice on purpose (see that function's own docblock).
 *   6. `graphify-out/combined/` (the on-demand federated graph) is never
 *      tracked — issue #11 is explicit that it is generated, gitignored,
 *      and not approved for commit.
 *   7. `apps/cms/graphify-out/` still tracks exactly the four files
 *      `ahliweb/awcms`'s own gate expects — the standing proof that this
 *      repo's own `knowledge:graph:combine` / `knowledge:obsidian:export`
 *      have never written into the subtree.
 *
 * `cost.json`'s token totals are NOTED, never failed on: issue #11 requires
 * semantic/LLM extraction to be explicit, not forbidden. A nonzero total
 * means someone deliberately opted in (`knowledge/README.md` documents how);
 * this gate's job is visibility, the same stance `graph-artifacts-check.ts`
 * takes on staleness (reported, never fatal — see that file's own docblock).
 *
 * ## What is deliberately NOT checked
 *
 * Documentation-counts cross-checking (the model's rule 5, "the docs match
 * the artefact") is not repeated here: `knowledge/README.md` is written to
 * describe the WORKFLOW, not to restate `graph.json`'s current node/edge
 * totals in a sentence this gate would then have to hold to those numbers
 * forever — a maintenance trap this small a corpus does not yet justify.
 * Revisit if the root graph grows large enough that a stale headline figure
 * becomes a real misreading risk (`apps/cms/docs/awcms/knowledge-graph.md`
 * is the shape that would take).
 *
 * Needs no build, no network, no `graphify` installation — it only reads
 * artefacts already in the repo (plus `git ls-files`, via
 * `packages/gerbang/lib/git.mjs`), so it runs in the CI `check` job.
 *
 * A repo with no root `graphify-out/` PASSES with a note: the graph is an
 * aid, not a requirement — same stance as the model.
 *
 * The optional first argument is the root to inspect (default `.`), which
 * is what lets `tests/audit-graf.test.mjs` run each rule over a fixture tree
 * and prove it goes RED when the defect it guards is reproduced.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { gitLines, gitRun } from "./lib/git.mjs";
import { createReporter } from "./lib/reporter.mjs";
import {
  checkCombinedGraphUntracked,
  checkCommunityLabels,
  checkExclusionsHeld,
  checkGraphifyIgnoreExcludesSubtree,
  checkNoSubtreeNodes,
  checkReportAgreesWithGraph,
  checkSubtreeArtifactsUnchanged,
  checkTrackedArtifacts,
  graphCounts,
  parseGraphifyIgnore
} from "./lib/graf-checks.mjs";

const ROOT = process.argv[2] ?? ".";
const OUTPUT_DIR = "graphify-out";

if (!existsSync(ROOT)) {
  console.error(`root "${ROOT}" is not a directory`);
  process.exit(2);
}

const reporter = createReporter("audit:graf");
const outputDir = path.join(ROOT, OUTPUT_DIR);

if (!existsSync(outputDir)) {
  reporter.note(`${OUTPUT_DIR}/ absent — no root graph artefacts to check.`);
  reporter.finish();
}

const trackedOutput = gitRun(ROOT, "ls-files", "--", OUTPUT_DIR);

if (trackedOutput === null) {
  reporter.note("tracked: SKIPPED — not a git repository, `git ls-files` unavailable");
} else {
  const trackedPaths = gitLines(trackedOutput);
  for (const v of checkTrackedArtifacts(trackedPaths)) reporter.violation(v.rule, v.file, v.message);
  for (const v of checkCombinedGraphUntracked(trackedPaths)) reporter.violation(v.rule, v.file, v.message);
  reporter.note(`tracked: ${trackedPaths.length} file(s) tracked under ${OUTPUT_DIR}/`);
}

const subtreeTrackedOutput = gitRun(ROOT, "ls-files", "--", "apps/cms/graphify-out");
if (subtreeTrackedOutput !== null) {
  const subtreeTracked = gitLines(subtreeTrackedOutput);
  for (const v of checkSubtreeArtifactsUnchanged(subtreeTracked)) {
    reporter.violation(v.rule, v.file, v.message);
  }
  reporter.note(`subtree: ${subtreeTracked.length} file(s) tracked under apps/cms/${OUTPUT_DIR}/`);
}

const graphPath = path.join(outputDir, "graph.json");
const reportPath = path.join(outputDir, "GRAPH_REPORT.md");

let graph = null;

if (!existsSync(graphPath)) {
  reporter.violation("artifact", `${OUTPUT_DIR}/graph.json`, `absent even though ${OUTPUT_DIR}/ exists`);
} else {
  try {
    const parsed = JSON.parse(readFileSync(graphPath, "utf8"));
    if (!Array.isArray(parsed.nodes)) {
      reporter.violation("artifact", `${OUTPUT_DIR}/graph.json`, "has no `nodes` array");
    } else {
      graph = parsed;
    }
  } catch (error) {
    reporter.violation("artifact", `${OUTPUT_DIR}/graph.json`, `is not readable as JSON: ${error.message}`);
  }
}

if (graph) {
  const counts = graphCounts(graph);
  reporter.note(`graph: ${counts.nodes} nodes, ${counts.edges} edges, ${counts.communities} communities`);

  for (const v of checkNoSubtreeNodes(graph)) reporter.violation(v.rule, v.file, v.message);

  if (!existsSync(reportPath)) {
    reporter.violation("artifact", `${OUTPUT_DIR}/GRAPH_REPORT.md`, "absent even though graph.json exists");
  } else {
    const report = readFileSync(reportPath, "utf8");
    for (const v of checkReportAgreesWithGraph(graph, report)) reporter.violation(v.rule, v.file, v.message);
    for (const v of checkCommunityLabels(graph, report)) reporter.violation(v.rule, v.file, v.message);
  }

  const ignorePath = path.join(ROOT, ".graphifyignore");

  if (!existsSync(ignorePath)) {
    reporter.violation(
      "subtree-excluded",
      ".graphifyignore",
      "does not exist — without it, the next root rebuild would duplicate-extract apps/cms/"
    );
  } else {
    const ignore = parseGraphifyIgnore(readFileSync(ignorePath, "utf8"));
    for (const v of checkGraphifyIgnoreExcludesSubtree(ignore)) reporter.violation(v.rule, v.file, v.message);
    for (const v of checkExclusionsHeld(graph, ignore)) reporter.violation(v.rule, v.file, v.message);
    reporter.note(
      `exclusions: ${ignore.prefixes.length} entr(ies) enforced` +
        (ignore.unenforced.length > 0
          ? `, ${ignore.unenforced.length} NOT enforced (${ignore.unenforced.join(", ")})`
          : "")
    );
  }

  const costPath = path.join(outputDir, "cost.json");
  if (existsSync(costPath)) {
    try {
      const cost = JSON.parse(readFileSync(costPath, "utf8"));
      const input = cost.total_input_tokens ?? 0;
      const output = cost.total_output_tokens ?? 0;
      reporter.note(
        `cost: ${input} input / ${output} output token(s) across ${(cost.runs ?? []).length} run(s)` +
          (input === 0 && output === 0
            ? " — code-only, no LLM used"
            : " — semantic extraction has been used at least once; confirm it was an explicit, deliberate run (knowledge/README.md)")
      );
    } catch (error) {
      reporter.violation("artifact", `${OUTPUT_DIR}/cost.json`, `is not readable as JSON: ${error.message}`);
    }
  } else {
    reporter.note(`cost: ${OUTPUT_DIR}/cost.json absent — no run has recorded token usage yet`);
  }

  const behind = gitRun(ROOT, "rev-list", "--count", `${graph.built_at_commit}..HEAD`);
  if (typeof graph.built_at_commit !== "string" || graph.built_at_commit === "") {
    reporter.note("freshness: graph.json names no built_at_commit");
  } else {
    const short = graph.built_at_commit.slice(0, 8);
    reporter.note(
      behind === null
        ? `freshness: built from ${short}, distance to HEAD unreadable`
        : Number.parseInt(behind.trim(), 10) === 0
          ? `freshness: built from ${short}, level with HEAD`
          : `freshness: built from ${short}, ${behind.trim()} commit(s) behind HEAD — consider \`bun run knowledge:graph:update\``
    );
  }
}

reporter.finish();
