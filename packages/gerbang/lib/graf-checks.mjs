/**
 * graf-checks.mjs — pure logic behind `audit:graf`, the root knowledge-graph gate.
 *
 * ## Where this comes from
 *
 * `apps/cms/scripts/graph-artifacts-check.ts` is `ahliweb/awcms`'s own gate
 * over ITS `graphify-out/`, and it is the model this module is deliberately
 * built to resemble: the same five questions ("only the tracked artefacts
 * are tracked", "the report agrees with the graph", "every community has a
 * chosen name", "what is excluded stays excluded", "the docs match the
 * artefact"), the same reasoning for each, and the same non-goals (staleness
 * and name QUALITY are reported, never fatal — see that file's own docblock
 * for why). This module does not import that one — `apps/cms` is upstream's
 * tree (AGENTS.md, "What is, and is not, this repo's to edit") and this
 * workspace's own gates stay `.mjs`, matching `packages/gerbang`'s own
 * house style, not `apps/cms`'s TypeScript.
 *
 * A third question has no equivalent in the model either, and exists for a
 * different reason than federation: **bounded content staleness**
 * (`diffManifestStaleness` / `checkStaleness`, issue #186). CI has no
 * `graphify` on `PATH` and cannot regenerate the graph itself, so the only
 * thing a gate CAN do is notice the graph has drifted and say so past a
 * documented bound — see those functions' own docblocks for the mechanism
 * (a plain MD5 of file bytes, the same one `graphify`'s own incremental
 * update already computes and records in `manifest.json`) and
 * `audit-graf.mjs`'s `MAX_STALE_FILES` for the bound itself.
 *
 * Two more questions have no equivalent in the model, because they exist
 * only at the ROOT of a federated workspace:
 *
 *   - **No duplicate extraction.** `checkNoSubtreeNodes` — the root graph
 *     must hold no node whose `source_file` sits under `apps/cms/`. This is
 *     the federation's central promise (issue #11's Objective): a root
 *     rebuild run without `.graphifyignore`, or from the wrong directory,
 *     silently re-admits the subtree's own ~12700 nodes into a second,
 *     competing graph.
 *   - **The subtree stays untouched.** `checkSubtreeArtifactsUnchanged` —
 *     `apps/cms/graphify-out/` must track exactly the four files
 *     `ahliweb/awcms`'s own gate expects, forever. If this repo's OWN
 *     combine/export tooling ever wrote into that directory by mistake, this
 *     is the standing check that would catch it on every future run, not
 *     just in the PR that introduced the bug.
 *
 * A fourth addition, `checkCombinedGraphUntracked`, enforces the issue's
 * other hard rule: the federated graph is generated, gitignored, and never
 * committed unless someone deliberately changes that — so nothing under
 * `graphify-out/combined/` may ever appear in `git ls-files`.
 *
 * Every function here is pure — no filesystem, no git, no process exit — so
 * `tests/audit-graf.test.mjs` can drive each one directly with a literal
 * object instead of writing a fixture tree to disk for every case. The
 * runner in `audit-graf.mjs` does the I/O and turns these into a report.
 */
import { createHash } from "node:crypto";

/** @typedef {{ rule: string, file: string, message: string }} Violation */

/**
 * The graphify artefacts this repo tracks at the ROOT, and only these —
 * identical to `apps/cms`'s own list (`graph-artifacts-check.ts`,
 * `TRACKED_ARTIFACTS`), because the shape of the decision is the same:
 * shared output is named without a leading dot, while cache, dot-files,
 * dated copies, and `graph.html` each have their own reason to stay out of
 * history (see the root `.gitignore`'s own graphify section).
 */
export const TRACKED_ARTIFACTS = new Set([
  "GRAPH_REPORT.md",
  "cost.json",
  "graph.json",
  "manifest.json"
]);

/** @typedef {{ id?: string, community?: number|null, community_name?: string|null, source_file?: string }} GraphNode */
/** @typedef {{ nodes: GraphNode[], links?: unknown[], built_at_commit?: string, directed?: boolean }} Graph */
/** @typedef {{ nodes: number, edges: number, communities: number }} GraphCounts */

/** Suffixes that give a community label away as a filename, not a chosen name. */
const FILE_SUFFIX =
  /\.(ts|tsx|js|mjs|cjs|jsx|astro|json|jsonc|md|mdx|ya?ml|toml|css|scss|html|py|sh|sql|lock)$/i;

/** The counts actually present in a parsed `graph.json`. */
export function graphCounts(graph) {
  return {
    nodes: graph.nodes.length,
    edges: (graph.links ?? []).length,
    communities: new Set(
      graph.nodes
        .map((node) => node.community)
        .filter((community) => community !== undefined && community !== null)
    ).size
  };
}

// ---------------------------------------------------------------------------
// 1. Only the tracked artefacts are tracked (root `graphify-out/`)
// ---------------------------------------------------------------------------

/**
 * @param {readonly string[]} trackedPaths - `git ls-files -- graphify-out`, split
 * @returns {Violation[]}
 */
export function checkTrackedArtifacts(trackedPaths) {
  if (trackedPaths.length === 0) return [];

  const violations = [];
  const prefix = "graphify-out/";

  for (const trackedPath of trackedPaths) {
    if (!trackedPath.startsWith(prefix)) continue;
    const rest = trackedPath.slice(prefix.length);

    // Anything under graphify-out/combined/ is the federated graph, judged
    // by checkCombinedGraphUntracked below with its own message — folding it
    // in here would report the same file twice under two different rules.
    if (rest.startsWith("combined/")) continue;

    if (TRACKED_ARTIFACTS.has(rest)) continue;

    const reason = rest.startsWith("cache/")
      ? "cache is machine-specific and never enters history"
      : rest.startsWith(".")
        ? "a dot-file is a build intermediate or a path marker, never shared output"
        : /^\d{4}-\d{2}-\d{2}\//.test(rest)
          ? "a dated copy is a full duplicate of the live artefact beside it"
          : rest === "graph.html"
            ? "graph.html stops being emitted above the viz node limit and then rots silently"
            : "not one of the tracked root artefacts";

    violations.push({
      rule: "tracked",
      file: trackedPath,
      message: `tracked even though ${reason}`
    });
  }

  for (const name of TRACKED_ARTIFACTS) {
    if (!trackedPaths.includes(`${prefix}${name}`)) {
      violations.push({ rule: "tracked", file: `${prefix}${name}`, message: "shared artefact is not tracked" });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// 2. The federated graph is never accidentally committed
// ---------------------------------------------------------------------------

/**
 * `graphify-out/combined/` holds the on-demand federated graph
 * (`knowledge:graph:combine`'s output). Issue #11's Objective and Scope §7
 * are explicit: this graph is "generated outside the subtree, into a
 * gitignored path... never committed unless explicitly approved" — and it
 * is not approved. A tracked file here means either the `.gitignore` rule
 * was removed, or someone ran `git add -f`.
 *
 * @param {readonly string[]} trackedPaths
 * @returns {Violation[]}
 */
export function checkCombinedGraphUntracked(trackedPaths) {
  const offenders = trackedPaths.filter((p) => p.startsWith("graphify-out/combined/"));

  return offenders.map((file) => ({
    rule: "combined-untracked",
    file,
    message:
      "the federated graph (graphify-out/combined/) is tracked. It is a generated, on-demand analysis view over root + apps/cms, not a new authority (issue #11) — remove it from history and confirm .gitignore still excludes graphify-out/combined/."
  }));
}

// ---------------------------------------------------------------------------
// 3. The report and the graph come from the same run
// ---------------------------------------------------------------------------

/** @param {string} report */
export function reportedCounts(report) {
  const match = report.match(/^- (\d+) nodes · (\d+) edges · (\d+) communities/m);
  if (!match) return null;
  return { nodes: Number(match[1]), edges: Number(match[2]), communities: Number(match[3]) };
}

/**
 * @param {Graph} graph
 * @param {string} report
 * @returns {Violation[]}
 */
export function checkReportAgreesWithGraph(graph, report) {
  const claimed = reportedCounts(report);

  if (!claimed) {
    return [
      {
        rule: "report-agrees",
        file: "graphify-out/GRAPH_REPORT.md",
        message:
          "has no Summary line `- N nodes · N edges · N communities`, so it cannot be compared with graph.json"
      }
    ];
  }

  const actual = graphCounts(graph);

  return ["nodes", "edges", "communities"]
    .filter((field) => claimed[field] !== actual[field])
    .map((field) => ({
      rule: "report-agrees",
      file: "graphify-out/GRAPH_REPORT.md",
      message: `claims ${claimed[field]} ${field}, graph.json holds ${actual[field]}`
    }));
}

// ---------------------------------------------------------------------------
// 4. Every community has a name somebody chose
// ---------------------------------------------------------------------------

/** @param {string} report */
export function reportedCommunityNames(report) {
  const names = new Map();
  for (const line of report.split("\n")) {
    const match = line.match(/^### Community (\d+) - "(.*)"\s*$/);
    if (match) names.set(Number(match[1]), match[2]);
  }
  return names;
}

/**
 * @param {Graph} graph
 * @param {string} report
 * @returns {Violation[]}
 */
export function checkCommunityLabels(graph, report) {
  const graphNames = new Map();

  for (const node of graph.nodes) {
    const community = node.community;
    if (community === undefined || community === null) continue;
    if (!graphNames.has(community)) graphNames.set(community, node.community_name);
  }

  if (graphNames.size === 0) return [];

  const violations = [];
  const reportNames = reportedCommunityNames(report);
  const usedBy = new Map();
  const graphFile = "graphify-out/graph.json";

  for (const [community, name] of [...graphNames].sort((a, b) => a[0] - b[0])) {
    if (name === undefined || name === null || name === "") {
      violations.push({ rule: "label", file: graphFile, message: `community ${community} has no community_name` });
      continue;
    }

    if (name === `Community ${community}`) {
      violations.push({
        rule: "label",
        file: graphFile,
        message: `community ${community} is still the placeholder "${name}"`
      });
    } else if (FILE_SUFFIX.test(name)) {
      violations.push({
        rule: "label",
        file: graphFile,
        message: `community ${community} is named "${name}" — that is a filename (hub-naming fallback), not a chosen name`
      });
    }

    usedBy.set(name, [...(usedBy.get(name) ?? []), community]);

    const inReport = reportNames.get(community);
    if (inReport !== undefined && inReport !== name) {
      violations.push({
        rule: "label",
        file: "graphify-out/GRAPH_REPORT.md",
        message: `community ${community} is "${inReport}" in the report but "${name}" in graph.json`
      });
    }
  }

  for (const [name, communities] of usedBy) {
    if (communities.length > 1) {
      violations.push({
        rule: "label",
        file: graphFile,
        message: `the name "${name}" is used by ${communities.length} communities at once (${communities.join(", ")})`
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// 5. What is excluded stays excluded — AND apps/cms specifically is
// ---------------------------------------------------------------------------

/** @typedef {{ prefixes: string[], unenforced: string[] }} ParsedIgnore */

/** @param {string} contents */
export function parseGraphifyIgnore(contents) {
  const prefixes = [];
  const unenforced = [];

  for (const line of contents.split("\n")) {
    const pattern = line.trim();
    if (!pattern || pattern.startsWith("#")) continue;

    if (pattern.startsWith("!") || /[*?[\]]/.test(pattern)) {
      unenforced.push(pattern);
      continue;
    }

    prefixes.push(pattern.replace(/^\/+/, "").replace(/\/+$/, ""));
  }

  return { prefixes, unenforced };
}

/**
 * `.graphifyignore` must still name `apps/cms` as an excluded prefix. This is
 * the one line the whole federation model depends on — the moment it is
 * removed or weakened to a glob (which `checkExclusionsHeld` cannot enforce,
 * by design), the next `knowledge:graph:update` re-admits ~12700 nodes with
 * nobody's rebuild noticing until this gate is asked.
 *
 * @param {ParsedIgnore} ignore
 * @returns {Violation[]}
 */
export function checkGraphifyIgnoreExcludesSubtree(ignore) {
  if (ignore.prefixes.includes("apps/cms")) return [];

  if (ignore.unenforced.some((p) => p.includes("apps/cms"))) {
    return [
      {
        rule: "subtree-excluded",
        file: ".graphifyignore",
        message:
          "excludes apps/cms only via a glob pattern, which this gate cannot verify graphify actually honours — use a plain `apps/cms/` entry"
      }
    ];
  }

  return [
    {
      rule: "subtree-excluded",
      file: ".graphifyignore",
      message:
        "does not exclude apps/cms — the next root rebuild would duplicate-extract the subtree's own ~12700-node graph"
    }
  ];
}

/**
 * @param {Graph} graph
 * @param {ParsedIgnore} ignore
 * @returns {Violation[]}
 */
export function checkExclusionsHeld(graph, ignore) {
  const offenders = new Map();

  for (const node of graph.nodes) {
    const source = node.source_file;
    if (typeof source !== "string" || source === "") continue;

    for (const prefix of ignore.prefixes) {
      if (source === prefix || source.startsWith(`${prefix}/`)) {
        const seen = offenders.get(prefix);
        if (seen) {
          seen.nodes += 1;
          seen.files.add(source);
        } else {
          offenders.set(prefix, { nodes: 1, files: new Set([source]), example: source });
        }
        break;
      }
    }
  }

  return [...offenders].map(([prefix, { nodes, files, example }]) => ({
    rule: "exclusion",
    file: "graphify-out/graph.json",
    message: `${nodes} node(s) from ${files.size} file(s) under the exclusion \`${prefix}\` (e.g. ${example}) — was the graph rebuilt without .graphifyignore?`
  }));
}

/**
 * The federation's central promise, checked directly rather than only via
 * `.graphifyignore` string-matching above: no node's `source_file` may begin
 * `apps/cms/`, regardless of what excluded it (or failed to). This is what
 * `checkExclusionsHeld` would ALSO catch if `.graphifyignore` names the
 * prefix `apps/cms` — this function exists so the invariant holds even if a
 * future edit rewrites that file into a shape `checkExclusionsHeld` cannot
 * parse (a glob, a rename), which is exactly the silent-duplication failure
 * mode issue #11 names first.
 *
 * @param {Graph} graph
 * @returns {Violation[]}
 */
export function checkNoSubtreeNodes(graph) {
  const offenders = graph.nodes.filter(
    (node) => typeof node.source_file === "string" && node.source_file.startsWith("apps/cms/")
  );

  if (offenders.length === 0) return [];

  const files = new Set(offenders.map((n) => n.source_file));

  return [
    {
      rule: "no-duplicate-extraction",
      file: "graphify-out/graph.json",
      message:
        `${offenders.length} node(s) from ${files.size} file(s) under apps/cms/ (e.g. ${offenders[0].source_file}) — ` +
        "the root graph must never contain the subtree's own nodes; rebuild from the repo root with .graphifyignore in place"
    }
  ];
}

// ---------------------------------------------------------------------------
// 6. Bounded content staleness — does the graph still describe the tree?
// ---------------------------------------------------------------------------

/** @typedef {{ changed: string[], added: string[], removed: string[] }} StalenessDiff */

/**
 * `graphify extract`'s own incremental-update state
 * (`graphify/detect.py::save_manifest`) records one `ast_hash` per file it
 * indexed. That hash is `_md5_file()` — `hashlib.md5(usedforsecurity=False)`
 * streamed over the RAW FILE BYTES, nothing else (no normalisation, no path
 * salt) — verified directly against the installed `graphify` 0.9.35 by
 * reading `detect.py` and by hand-checking `md5sum` of a tracked file
 * against its own recorded `ast_hash` (they matched). It is therefore
 * reproducible in plain Node/Bun with `node:crypto`, with no `graphify`
 * install, no Python, and no network — exactly what a CI gate needs, since
 * `graphify` itself is not on the CI runner's `PATH` (`knowledge/README.md`).
 *
 * @param {string | Buffer} contents - raw file bytes
 * @returns {string}
 */
export function md5Hex(contents) {
  return createHash("md5").update(contents).digest("hex");
}

/**
 * The file-extension vocabulary a manifest already contains, lower-cased.
 *
 * Used to decide which currently-tracked files are candidates for "added
 * since the graph was last built" (below) — learned from the manifest
 * itself rather than reimplementing `graphify`'s own file-type/noise-dir/
 * secret-file classification (`detect.py::classify_file`,
 * `_is_graphable_source`, `_is_sensitive`, …), which is large, versioned
 * independently of this repo, and not this gate's to keep in sync. A file
 * whose extension `graphify` has never indexed here (because this workspace
 * uses no such extension, or because `graphify` would drop it) is simply
 * never a staleness candidate — an under-approximation on the "added" side
 * that trades perfect parity with `graphify`'s own scan for a rule this
 * module can state, test, and keep correct on its own.
 *
 * @param {Record<string, unknown>} manifest - parsed `manifest.json`
 * @returns {Set<string>}
 */
export function manifestExtensions(manifest) {
  const extensions = new Set();
  for (const filePath of Object.keys(manifest)) {
    const dot = filePath.lastIndexOf(".");
    const slash = filePath.lastIndexOf("/");
    if (dot > slash) extensions.add(filePath.slice(dot + 1).toLowerCase());
  }
  return extensions;
}

/**
 * Path prefixes that are never in scope for the staleness check, regardless
 * of `.graphifyignore`: `apps/cms/` for the same reason every other check in
 * this module treats it specially (it is a different, subtree-owned graph
 * with its own staleness question), and the two artefact directories this
 * workflow itself writes into — a rebuild changing its own output, or an
 * Obsidian export changing `knowledge/generated/graphify/`, must never count
 * as the SOURCE drifting away from the graph that describes it.
 */
const ALWAYS_OUT_OF_SCOPE_PREFIXES = ["apps/cms/", "graphify-out/", "knowledge/generated/"];

/**
 * Every currently git-tracked path this gate considers a staleness
 * candidate: not under {@link ALWAYS_OUT_OF_SCOPE_PREFIXES} or a
 * `.graphifyignore` prefix, not a translation mirror (`*.id.md` — excluded
 * from the graph itself, see `.graphifyignore`'s own comment), and carrying
 * an extension the manifest has already shown is graphable here
 * ({@link manifestExtensions}).
 *
 * @param {readonly string[]} trackedPaths - `git ls-files`, repo-wide
 * @param {Set<string>} extensions - {@link manifestExtensions} of the manifest
 * @param {readonly string[]} ignorePrefixes - `ParsedIgnore.prefixes`
 * @returns {string[]} sorted
 */
export function inScopeCandidates(trackedPaths, extensions, ignorePrefixes) {
  const prefixes = [...ALWAYS_OUT_OF_SCOPE_PREFIXES, ...ignorePrefixes.map((prefix) => `${prefix}/`)];

  return trackedPaths
    .filter((filePath) => {
      if (filePath.endsWith(".id.md")) return false;
      if (prefixes.some((prefix) => filePath === prefix.slice(0, -1) || filePath.startsWith(prefix))) return false;

      const dot = filePath.lastIndexOf(".");
      const slash = filePath.lastIndexOf("/");
      const extension = dot > slash ? filePath.slice(dot + 1).toLowerCase() : "";
      return extensions.has(extension);
    })
    .sort();
}

/**
 * Diffs `manifest.json`'s recorded hashes against the current tree.
 *
 * Pure: the only filesystem access is `currentHash`, supplied by the caller
 * (`audit-graf.mjs`'s runner), so this can be driven end-to-end with plain
 * objects and a stub callback — no fixture tree needed to prove the counting
 * logic itself.
 *
 * A manifest path that is no longer a candidate — deleted, moved out of
 * scope, no longer git-tracked, or excluded by `.graphifyignore` since the
 * graph was last built — is counted as **removed**, without a separate
 * existence check: {@link inScopeCandidates} already encodes "still tracked
 * and still in scope", so a manifest path missing from it IS the removal.
 * A candidate `currentHash` cannot read (returns `null`, e.g. a working-tree
 * deletion `git ls-files` has not caught up to) is counted as **changed**
 * rather than removed — conservative, since a deletion mid-diff is rare and
 * "changed" still crosses the same bound.
 *
 * @param {Record<string, { ast_hash?: string }>} manifest - parsed `manifest.json`
 * @param {readonly string[]} trackedPaths - `git ls-files`, repo-wide
 * @param {readonly string[]} ignorePrefixes - `ParsedIgnore.prefixes`
 * @param {(filePath: string) => string | null} currentHash - current md5 of
 *   a path relative to the repo root, or `null` when unreadable
 * @returns {StalenessDiff}
 */
export function diffManifestStaleness(manifest, trackedPaths, ignorePrefixes, currentHash) {
  const candidates = inScopeCandidates(trackedPaths, manifestExtensions(manifest), ignorePrefixes);
  const candidateSet = new Set(candidates);

  const changed = [];
  const removed = [];

  for (const filePath of Object.keys(manifest)) {
    if (!candidateSet.has(filePath)) {
      removed.push(filePath);
      continue;
    }
    const hash = currentHash(filePath);
    if (hash === null || hash !== manifest[filePath]?.ast_hash) changed.push(filePath);
  }

  const added = candidates.filter((filePath) => !(filePath in manifest));

  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

/**
 * Turns a {@link StalenessDiff} into a violation once the total crosses
 * `bound` — never AT it, the same `>` (not `>=`) convention
 * `audit-rilis.mjs`'s own count bound uses, so a diff at exactly the bound
 * is still green.
 *
 * @param {StalenessDiff} diff
 * @param {number} bound
 * @returns {Violation[]}
 */
export function checkStaleness(diff, bound) {
  const total = diff.changed.length + diff.added.length + diff.removed.length;
  if (total <= bound) return [];

  return [
    {
      rule: "staleness",
      file: "graphify-out/manifest.json",
      message:
        `${total} file(s) changed/added/removed since the graph was last built, bound is ${bound} ` +
        `(${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed) — ` +
        "run `bun run knowledge:graph:update`"
    }
  ];
}

// ---------------------------------------------------------------------------
// 7. The subtree's own graph artefacts are untouched by root automation
// ---------------------------------------------------------------------------

/**
 * `apps/cms/graphify-out/` must track exactly the four files
 * `ahliweb/awcms`'s own `graph:artifacts:check` expects (see
 * `apps/cms/scripts/graph-artifacts-check.ts`, `TRACKED_ARTIFACTS`) —
 * checked here, from the root, as the standing proof that this repo's own
 * `knowledge:graph:combine` / `knowledge:obsidian:export` never wrote into
 * that directory. An extra tracked file there (a stray `combined.json`, an
 * obsidian staging leftover) is exactly what a bug in this repo's own
 * tooling would produce, and it is this check — not a one-time PR diff —
 * that keeps catching it.
 *
 * @param {readonly string[]} subtreeTrackedPaths - `git ls-files -- apps/cms/graphify-out`, split
 * @returns {Violation[]}
 */
export function checkSubtreeArtifactsUnchanged(subtreeTrackedPaths) {
  if (subtreeTrackedPaths.length === 0) return [];

  const prefix = "apps/cms/graphify-out/";
  const violations = [];

  for (const trackedPath of subtreeTrackedPaths) {
    const rest = trackedPath.startsWith(prefix) ? trackedPath.slice(prefix.length) : trackedPath;
    if (!TRACKED_ARTIFACTS.has(rest)) {
      violations.push({
        rule: "subtree-untouched",
        file: trackedPath,
        message:
          "apps/cms/graphify-out/ now tracks a file outside ahliweb/awcms's own four (GRAPH_REPORT.md, cost.json, graph.json, manifest.json) — this repo's root tooling must never write into the subtree; if this is a legitimate upstream change, it should have arrived via `git subtree pull`, not a local edit"
      });
    }
  }

  return violations;
}
