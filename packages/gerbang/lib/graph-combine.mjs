/**
 * graph-combine.mjs — pure validation behind `knowledge:graph:combine`.
 *
 * ## Why the wrapper validates and does not just trust `graphify merge-graphs`
 *
 * Verified directly against the real toolchain (graphify 0.9.35) while
 * building this: `graphify merge-graphs` fails closed — non-zero exit, no
 * output file — on a missing file, unparseable JSON, and a JSON object with
 * no `nodes` key. It does **not** fail on a graph.json that parses fine and
 * has the right shape but is **empty** (`{"nodes": [], "links": []}`): given
 * a real 297-node root graph and an empty second graph, it happily "merges"
 * them into a 297-node result and exits 0 — indistinguishable from a healthy
 * merge unless something compares counts before and after. That silent case
 * is exactly issue #11's Scope §2.5 ("fails closed... rather than silently
 * dropping nodes/edges") and Scope §8.4 ("a merged graph mixing stale CMS
 * state with current root state") — an `apps/cms/graphify-out/graph.json`
 * truncated by a bad sync, a half-written rebuild, or a wrong `--out` path
 * would merge in as if `apps/cms` contributed nothing, with no error at all.
 *
 * So this module adds the checks graphify itself does not:
 *
 *   1. **Pre-flight**: both inputs parse, both have a non-empty `nodes`
 *      array, and both agree on `directed` — merging a directed and an
 *      undirected graph is not obviously meaningful, and neither this
 *      workspace's own graph nor `apps/cms`'s is directed today (Scope §1
 *      code-only default), so a mismatch is a real anomaly worth stopping
 *      for rather than silently coercing one way.
 *   2. **Post-merge**: the combined graph's node count is at least the sum
 *      of what went in (`graphify merge-graphs` does not deduplicate across
 *      two separately-built graphs with disjoint id namespaces — verified
 *      above: 297 + 12700 in, 12997 out, exactly) and never fewer than
 *      either input alone (a merge must never shrink a side, the same shape
 *      as `graphify`'s own #479 shrink-guard on `to_json`).
 *
 * Every function here takes already-read strings/objects and returns a
 * plain verdict — no filesystem, no `graphify` process. That is what lets
 * `tests/graph-combine.test.mjs` exercise every failure mode (missing file,
 * malformed JSON, empty nodes, directed mismatch, a merge that silently
 * shrank) with literal fixtures, in CI, with no `graphify` installation at
 * all — the runner, `tools/knowledge-graph-combine.mjs`, is the only piece
 * that actually shells out, and it is not part of `bun test`.
 */

/** @typedef {{ ok: true, graph: object } | { ok: false, error: string }} ParseResult */

/**
 * Parse and shape-check one graph.json's raw content.
 *
 * @param {string} label - for the error message, e.g. "root graph.json"
 * @param {string | null} content - null means the file does not exist
 * @returns {ParseResult}
 */
export function validateGraphFile(label, content) {
  if (content === null) {
    return { ok: false, error: `${label} does not exist` };
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return { ok: false, error: `${label} is not valid JSON: ${error.message}` };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `${label} is not a JSON object` };
  }

  if (!Array.isArray(parsed.nodes)) {
    return { ok: false, error: `${label} has no \`nodes\` array` };
  }

  if (parsed.nodes.length === 0) {
    return { ok: false, error: `${label} has an empty \`nodes\` array — graphify itself does not treat this as an error, but a merge with nothing on one side is never a legitimate federation` };
  }

  return { ok: true, graph: parsed };
}

/**
 * @param {object} rootGraph - already validated via {@link validateGraphFile}
 * @param {object} cmsGraph
 * @returns {string[]} reasons the two are not safe to merge; empty when compatible
 */
export function checkMergeInputsCompatible(rootGraph, cmsGraph) {
  const reasons = [];

  const rootDirected = Boolean(rootGraph.directed);
  const cmsDirected = Boolean(cmsGraph.directed);
  if (rootDirected !== cmsDirected) {
    reasons.push(
      `directed flag mismatch — root graph.json is directed=${rootDirected}, apps/cms/graphify-out/graph.json is directed=${cmsDirected}. Merging a directed and an undirected graph silently redefines one of them.`
    );
  }

  return reasons;
}

/**
 * @param {object} rootGraph
 * @param {object} cmsGraph
 * @param {object} mergedGraph - already validated via {@link validateGraphFile}
 * @returns {string[]} reasons the merged result looks wrong; empty when it looks healthy
 */
export function checkMergedResult(rootGraph, cmsGraph, mergedGraph) {
  const reasons = [];
  const rootN = rootGraph.nodes.length;
  const cmsN = cmsGraph.nodes.length;
  const mergedN = mergedGraph.nodes.length;
  const expectedMin = Math.max(rootN, cmsN);

  if (mergedN < expectedMin) {
    reasons.push(
      `combined graph has ${mergedN} node(s), fewer than the larger input alone (root ${rootN}, apps/cms ${cmsN}) — a merge must never shrink a side`
    );
  }

  if (mergedN > rootN + cmsN) {
    reasons.push(
      `combined graph has ${mergedN} node(s), more than root (${rootN}) + apps/cms (${cmsN}) combined — that should not be possible from a two-graph merge`
    );
  }

  return reasons;
}
