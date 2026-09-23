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
 * carries over and what does not), plus one bounded-staleness question this
 * gate needs that the model does not, plus two that exist only at a
 * federated root:
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
 *   6. **The graph still describes the tree, within a bound** (issue #186)
 *      — `manifest.json`'s recorded `ast_hash` per file, re-hashed against
 *      the current working tree, may not show more than
 *      {@link MAX_STALE_FILES} files changed/added/removed since the graph
 *      was last built. See "Why content, not git history" below and
 *      `packages/gerbang/lib/graf-checks.mjs`'s `diffManifestStaleness` for
 *      the mechanism.
 *   7. `graphify-out/combined/` (the on-demand federated graph) is never
 *      tracked — issue #11 is explicit that it is generated, gitignored,
 *      and not approved for commit.
 *   8. `apps/cms/graphify-out/` still tracks exactly the four files
 *      `ahliweb/awcms`'s own gate expects — the standing proof that this
 *      repo's own `knowledge:graph:combine` / `knowledge:obsidian:export`
 *      have never written into the subtree.
 *
 * `cost.json`'s token totals are NOTED, never failed on: issue #11 requires
 * semantic/LLM extraction to be explicit, not forbidden. A nonzero total
 * means someone deliberately opted in (`knowledge/README.md` documents how);
 * this gate's job for THAT number is visibility, the same stance
 * `graph-artifacts-check.ts` takes on staleness generally (reported, never
 * fatal — see that file's own docblock). Rule 6 above is the one place this
 * gate now departs from that stance, and deliberately: nothing else in this
 * repo would ever notice the graph had gone stale otherwise (see below).
 *
 * ## Why content, not git history
 *
 * The obvious way to measure staleness is `git rev-list --count
 * <built_at_commit>..HEAD` — and this gate already prints that as an
 * informational `freshness:` note (below), unconditionally, because it costs
 * nothing to say. It cannot be the FAILING check, though: `check-cms` and
 * the `Check` matrix both run on GitHub-hosted runners against a checkout
 * whose depth is not guaranteed, and a shallow checkout makes
 * `built_at_commit..HEAD` unreadable (`gitRun` returns `null`) — not wrong,
 * just silent, which is worse than either red or green for a gate whose job
 * is to be trusted when it says nothing is wrong. Rule 6 instead re-derives
 * the same MD5 `graphify` itself already computed and recorded
 * (`graphify-out/manifest.json`'s `ast_hash` — verified against the
 * installed `graphify` 0.9.35's own `detect.py`, see
 * `graf-checks.mjs`'s `md5Hex` docblock), which needs nothing but the
 * working tree that is already checked out.
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
import {
  checkCombinedGraphUntracked,
  checkCommunityLabels,
  checkExclusionsHeld,
  checkGraphifyIgnoreExcludesSubtree,
  checkNoSubtreeNodes,
  checkReportAgreesWithGraph,
  checkStaleness,
  checkSubtreeArtifactsUnchanged,
  checkTrackedArtifacts,
  diffManifestStaleness,
  graphCounts,
  md5Hex,
  parseGraphifyIgnore
} from "./lib/graf-checks.mjs";
import { createReporter } from "./lib/reporter.mjs";

const ROOT = process.argv[2] ?? ".";
const OUTPUT_DIR = "graphify-out";

/**
 * At most this many files may show up changed/added/removed (content MD5
 * vs. `graphify-out/manifest.json`'s recorded `ast_hash`, over the in-scope
 * candidate set — see `diffManifestStaleness`) before the graph is treated
 * as stale enough to fail the gate, not merely note it.
 *
 * A starting assumption, the same way `audit-rilis.mjs`'s own `MAX_WAITING`
 * and `MAX_AGE_DAYS` were: this repo has one measured data point so far, the
 * incident issue #186 itself exists to catch. v0.10.0's storefront redesign
 * (epic #166–#171) landed against the graph this gate's own fixture,
 * `graphify-out/manifest.json`, was last built from, and re-hashing that
 * manifest against the tree afterwards found 65 files changed and 9 added —
 * 74 total, entirely storefront and root-owned work, zero of it noticed by
 * any gate until this one. 40 sits below that real incident (so the same
 * change would have failed this gate, which is the point) and above the
 * handful of files an ordinary single-issue PR touches, so a normal PR does
 * not trip it. Revisit once a few more releases give this a measured rate,
 * the same way `audit-rilis.mjs`'s own docblock records having done.
 */
const MAX_STALE_FILES = 40;

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
const ignorePath = path.join(ROOT, ".graphifyignore");

// Parsed once, up front, so both the graph-consuming checks below and the
// staleness check (which needs no graph.json at all) share one reading of
// .graphifyignore rather than two.
const ignoreExists = existsSync(ignorePath);
const ignore = ignoreExists ? parseGraphifyIgnore(readFileSync(ignorePath, "utf8")) : null;

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

  if (!ignoreExists) {
    reporter.violation(
      "subtree-excluded",
      ".graphifyignore",
      "does not exist — without it, the next root rebuild would duplicate-extract apps/cms/"
    );
  } else {
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

// -----------------------------------------------------------------------
// Bounded content staleness (issue #186) — independent of graph.json/
// GRAPH_REPORT.md above: only manifest.json and the current working tree
// are needed, so this still runs (and can still fail) even when one of the
// checks above already found the graph itself broken.
// -----------------------------------------------------------------------

const manifestPath = path.join(outputDir, "manifest.json");

if (!existsSync(manifestPath)) {
  reporter.note(`staleness: ${OUTPUT_DIR}/manifest.json absent — cannot check content staleness`);
} else {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const trackedRepoOutput = gitRun(ROOT, "ls-files");

    if (trackedRepoOutput === null) {
      reporter.note("staleness: SKIPPED — not a git repository, `git ls-files` unavailable");
    } else {
      const trackedRepo = gitLines(trackedRepoOutput);
      const ignorePrefixes = ignore?.prefixes ?? [];
      const diff = diffManifestStaleness(manifest, trackedRepo, ignorePrefixes, (filePath) => {
        try {
          return md5Hex(readFileSync(path.join(ROOT, filePath)));
        } catch {
          return null;
        }
      });

      for (const v of checkStaleness(diff, MAX_STALE_FILES)) reporter.violation(v.rule, v.file, v.message);

      const total = diff.changed.length + diff.added.length + diff.removed.length;
      reporter.note(
        `staleness: ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed ` +
          `— ${total} total (bound ${MAX_STALE_FILES})` +
          (total > MAX_STALE_FILES ? "" : "; `bun run knowledge:graph:update` regenerates when it is time")
      );
    }
  } catch (error) {
    reporter.violation("artifact", `${OUTPUT_DIR}/manifest.json`, `is not readable as JSON: ${error.message}`);
  }
}

reporter.finish();
