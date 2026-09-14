/**
 * The proof issue #11 explicitly demands: this repo's own knowledge-graph
 * automation never writes into `apps/cms/`.
 *
 * Runs the REAL `tools/knowledge-graph-combine.mjs` and
 * `tools/knowledge-obsidian-export.mjs` end to end — not a mock of their
 * logic — against a disposable fixture tree (never this repo's own
 * `apps/cms/`), with a fake `graphify` binary standing in for the real one
 * so this runs in CI with no Python toolchain installed. Both tools accept
 * `KNOWLEDGE_GRAPH_ROOT` as a root override for exactly this purpose (see
 * each tool's own top-of-file comment).
 *
 * The proof itself: every file under the fixture's `apps/cms/` is hashed
 * before running either tool, and re-hashed after. `apps/cms/` must be
 * byte-for-byte identical — not "no new files", which a partial write could
 * still satisfy, but a full content comparison of every file that was
 * already there.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const COMBINE_SCRIPT = join(REPO_ROOT, "tools/knowledge-graph-combine.mjs");
const EXPORT_SCRIPT = join(REPO_ROOT, "tools/knowledge-obsidian-export.mjs");

/** @type {string[]} */
const cleanup = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
});

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A tiny, valid graph.json — enough to pass validateGraphFile and merge. */
function fakeGraph(nodeCount, sourcePrefix) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    label: `thing${i}()`,
    community: 0,
    community_name: "Fixture Community",
    source_file: `${sourcePrefix}/thing${i}.ts`
  }));
  return JSON.stringify({ built_at_commit: "0".repeat(40), directed: false, nodes, links: [] });
}

/**
 * A fake `graphify` binary implementing just enough of `merge-graphs` and
 * `export obsidian` for these two tools to run for real.
 */
function fakeGraphifyBin(dir) {
  const binPath = join(dir, "graphify");
  const script = `#!/usr/bin/env bash
set -euo pipefail
cmd="$1"; shift
if [ "$cmd" = "merge-graphs" ]; then
  g1="$1"; g2="$2"; shift 2
  out=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--out" ]; then out="$2"; shift 2; else shift; fi
  done
  mkdir -p "$(dirname "$out")"
  # Trivial "merge": concatenate g1's + g2's nodes exactly — the same shape
  # the REAL graphify merge-graphs produces (verified directly: 297 root +
  # 12700 apps/cms in, 12997 out, no dedup). Proves both inputs were read,
  # without needing a real graph merge implementation in bash. Uses bun
  # (already required to run these tools at all) rather than python3, so
  # this fixture has no extra interpreter dependency in CI.
  bun -e '
    const [g1Path, g2Path, outPath] = process.argv.slice(1);
    const fs = require("node:fs");
    const g1 = JSON.parse(fs.readFileSync(g1Path, "utf8"));
    const g2 = JSON.parse(fs.readFileSync(g2Path, "utf8"));
    const merged = { ...g1, nodes: [...g1.nodes, ...g2.nodes] };
    fs.writeFileSync(outPath, JSON.stringify(merged));
  ' "$g1" "$g2" "$out"
  exit 0
elif [ "$cmd" = "export" ] && [ "$1" = "obsidian" ]; then
  shift
  dir=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--dir" ]; then dir="$2"; shift 2; else shift; fi
  done
  mkdir -p "$dir/.obsidian"
  printf -- '---\\nsource_file: "src/thing0.ts"\\ntype: "code"\\ncommunity: "Fixture Community"\\n---\\n\\n# thing0()\\n' > "$dir/thing0().md"
  printf -- '---\\nsource_file: ""\\ntype: ""\\ncommunity: "Fixture Community"\\n---\\n\\n# Fixture Community\\n' > "$dir/_COMMUNITY_Fixture Community.md"
  printf '{}' > "$dir/graph.canvas"
  printf '{}' > "$dir/.obsidian/graph.json"
  printf '{"files":[]}' > "$dir/.graphify_obsidian_manifest.json"
  exit 0
else
  echo "fake graphify: unsupported command: $cmd $*" >&2
  exit 1
fi
`;
  write(binPath, script);
  chmodSync(binPath, 0o755);
  return dir;
}

/** @returns {Map<string, string>} relative path -> sha256 of every regular file under `dir` */
function hashTree(dir) {
  /** @type {Map<string, string>} */
  const hashes = new Map();
  if (!existsSync(dir)) return hashes;

  function recurse(current) {
    for (const name of readdirSync(current)) {
      const absolute = join(current, name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        recurse(absolute);
      } else if (stat.isFile()) {
        const rel = relative(dir, absolute);
        hashes.set(rel, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
      }
    }
  }

  recurse(dir);
  return hashes;
}

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-no-subtree-write-"));
  cleanup.push(root);

  write(join(root, "graphify-out/graph.json"), fakeGraph(2, "src"));
  write(join(root, "apps/cms/graphify-out/graph.json"), fakeGraph(3, "apps/cms/src"));
  write(join(root, "apps/cms/graphify-out/GRAPH_REPORT.md"), "# fixture\n");
  write(join(root, "apps/cms/graphify-out/manifest.json"), "{}");
  write(join(root, "apps/cms/graphify-out/cost.json"), "{}");
  write(join(root, "apps/cms/AGENTS.md"), "# fixture apps/cms AGENTS.md\n");
  write(join(root, "apps/cms/src/thing0.ts"), "export const thing0 = 0;\n");
  write(join(root, "knowledge/curated/ownership-boundaries.md"), "# fixture curated file\n");

  return root;
}

async function runTool(scriptPath, fixtureRoot, fakeBinDir) {
  const child = Bun.spawn(["bun", scriptPath], {
    cwd: fixtureRoot,
    env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, KNOWLEDGE_GRAPH_ROOT: fixtureRoot },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, output: out + err };
}

describe("knowledge-graph-combine.mjs never writes into apps/cms/", () => {
  test("apps/cms/ is byte-for-byte unchanged after a real combine run", async () => {
    const fixtureRoot = buildFixture();
    const fakeBinDir = mkdtempSync(join(tmpdir(), "fake-graphify-"));
    cleanup.push(fakeBinDir);
    fakeGraphifyBin(fakeBinDir);

    const before = hashTree(join(fixtureRoot, "apps/cms"));
    const { code, output } = await runTool(COMBINE_SCRIPT, fixtureRoot, fakeBinDir);
    const after = hashTree(join(fixtureRoot, "apps/cms"));

    expect(code).toBe(0);
    expect(output).toContain("knowledge:graph:combine OK");
    expect([...after.entries()]).toEqual([...before.entries()]);

    // The tool DID do real work — proves the "nothing changed" result above
    // is not merely because nothing ran.
    expect(existsSync(join(fixtureRoot, "graphify-out/combined/graph.json"))).toBe(true);
    const combined = JSON.parse(readFileSync(join(fixtureRoot, "graphify-out/combined/graph.json"), "utf8"));
    expect(combined.nodes.length).toBe(5); // 2 root + 3 apps/cms — proves both were actually read and merged
  });
});

describe("knowledge-obsidian-export.mjs never writes into apps/cms/", () => {
  test("apps/cms/ is byte-for-byte unchanged after a real export run", async () => {
    const fixtureRoot = buildFixture();
    const fakeBinDir = mkdtempSync(join(tmpdir(), "fake-graphify-"));
    cleanup.push(fakeBinDir);
    fakeGraphifyBin(fakeBinDir);

    const before = hashTree(join(fixtureRoot, "apps/cms"));
    const { code, output } = await runTool(EXPORT_SCRIPT, fixtureRoot, fakeBinDir);
    const after = hashTree(join(fixtureRoot, "apps/cms"));

    expect(code).toBe(0);
    expect(output).toContain("knowledge:obsidian:export OK");
    expect([...after.entries()]).toEqual([...before.entries()]);

    // Real work happened: the synced note landed, housekeeping did not, and
    // the curated fixture file was left alone (no collision here).
    expect(existsSync(join(fixtureRoot, "knowledge/generated/graphify/thing0().md"))).toBe(true);
    expect(existsSync(join(fixtureRoot, "knowledge/generated/graphify/.obsidian"))).toBe(false);
    expect(readFileSync(join(fixtureRoot, "knowledge/curated/ownership-boundaries.md"), "utf8")).toBe(
      "# fixture curated file\n"
    );
  });

  test("a curated-filename collision aborts the whole sync — nothing is written", async () => {
    const fixtureRoot = buildFixture();
    // Force a collision: the fake exporter always writes "thing0().md".
    write(join(fixtureRoot, "knowledge/curated/thing0().md"), "# do not overwrite me\n");

    const fakeBinDir = mkdtempSync(join(tmpdir(), "fake-graphify-"));
    cleanup.push(fakeBinDir);
    fakeGraphifyBin(fakeBinDir);

    const { code, output } = await runTool(EXPORT_SCRIPT, fixtureRoot, fakeBinDir);

    expect(code).toBe(1);
    expect(output).toContain("collides");
    expect(existsSync(join(fixtureRoot, "knowledge/generated/graphify/thing0().md"))).toBe(false);
    expect(readFileSync(join(fixtureRoot, "knowledge/curated/thing0().md"), "utf8")).toBe("# do not overwrite me\n");
  });
});
