#!/usr/bin/env bun
/**
 * knowledge-graph-update.mjs — `bun run knowledge:graph:update`.
 *
 * Rebuilds this workspace's OWN root Graphify graph — never `apps/cms`'s,
 * which already owns its own graph and its own gate (`bun run check:cms`).
 * Two real `graphify` calls, both verified directly against the installed
 * toolchain (0.9.35) while building this workflow:
 *
 *   1. `graphify extract . --code-only` — structural AST extraction only.
 *      No LLM call, no provider API key read, for any file, ever: the flag
 *      itself "index[es] code (local AST, no API key) and skip[s] doc/
 *      paper/image files". This is issue #11's explicit default — semantic
 *      extraction must be OFF by default and opted into by hand, never run
 *      by this repo's own scripts. See `knowledge/README.md`'s "Extraction
 *      mode" section for the full provider/network/token accounting.
 *   2. `graphify cluster-only .` — re-clusters and names communities.
 *      Verified: with no `GEMINI_API_KEY`/`GOOGLE_API_KEY`/other backend
 *      configured, this makes no network call either — it reuses any
 *      saved, human-chosen labels whose community membership is unchanged
 *      (`graphify-out/.graphify_labels.json` + its `.sig` sidecar) and
 *      falls back to deterministic, free hub-based naming
 *      (`label_communities_by_hub`) for anything new. A hub name is not an
 *      acceptable final label — `bun run audit:graf` rejects one — so a
 *      run that introduces a genuinely new community needs a human to
 *      rename it by hand afterwards, same discipline `apps/cms`'s own
 *      graph documents.
 *
 * Then records the run (`0`/`0` tokens, always, under `--code-only`) in
 * `graphify-out/cost.json`, in the same shape the interactive graphify
 * skill's own manifest step uses, so a future semantic run's nonzero totals
 * are visible against a history that was honestly zero before it.
 *
 * Needs the real `graphify` binary on `PATH` (a local Python tool, not
 * installed in CI). Not part of `bun test`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const COST_PATH = join(ROOT, "graphify-out/cost.json");

// graphify's Leiden clustering is seeded, but its input node order comes
// from Python set/dict iteration, which follows per-process string-hash
// randomization. Without a fixed PYTHONHASHSEED every run re-partitions a
// handful of communities differently, `.graphify_labels.json.sig` no longer
// matches them, and their hand-chosen names fall back to hub filenames —
// which `bun run audit:graf` then rejects. Pinning the seed makes a rebuild
// of an unchanged tree reproduce the same partition, so names stick.
const GRAPHIFY_ENV = { ...process.env, PYTHONHASHSEED: "0" };

function run(args) {
  console.log(`$ graphify ${args.join(" ")}`);
  const proc = Bun.spawnSync(["graphify", ...args], { cwd: ROOT, env: GRAPHIFY_ENV, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`knowledge:graph:update FAILED — \`graphify ${args.join(" ")}\` exited ${proc.exitCode}`);
    process.exit(1);
  }
}

run(["extract", ".", "--code-only"]);
run(["cluster-only", "."]);

/** @type {{ runs: object[], total_input_tokens: number, total_output_tokens: number }} */
const cost = existsSync(COST_PATH)
  ? JSON.parse(readFileSync(COST_PATH, "utf8"))
  : { runs: [], total_input_tokens: 0, total_output_tokens: 0 };

// Always 0/0: --code-only performs no semantic extraction, so there is
// nothing else this run could honestly report. A future semantic-extraction
// path (issue #11's opt-in, human-run case) is a DIFFERENT command, never
// this one, and would carry its own real token accounting.
cost.runs.push({ date: new Date().toISOString(), input_tokens: 0, output_tokens: 0, mode: "code-only" });
cost.total_input_tokens = (cost.total_input_tokens ?? 0) + 0;
cost.total_output_tokens = (cost.total_output_tokens ?? 0) + 0;

writeFileSync(COST_PATH, `${JSON.stringify(cost, null, 2)}\n`);

console.log(
  `knowledge:graph:update OK — graphify-out/graph.json rebuilt (code-only, 0 tokens). ` +
    `Review graphify-out/GRAPH_REPORT.md for any community still named by its hub filename — ` +
    "bun run audit:graf rejects one; give it a chosen name and re-run `graphify cluster-only .` " +
    "(see knowledge/README.md)."
);
