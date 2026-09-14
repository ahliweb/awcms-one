/**
 * End-to-end behaviour of `tools/knowledge-obsidian-export.mjs` not already
 * covered by `tests/knowledge-no-subtree-write.test.mjs` (which proves the
 * subtree-safety property specifically): that graphify's own housekeeping
 * output is excluded without failing the run, and that a re-sync clears a
 * stale note left over from a node that no longer exists.
 *
 * Runs the REAL tool against a disposable fixture, with the same fake
 * `graphify` binary technique as `tests/knowledge-no-subtree-write.test.mjs`
 * (see that file for why: CI has no Python toolchain to run the real one).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
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

function fakeGraph(nodeCount) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    community: 0,
    community_name: "Fixture Community",
    source_file: `src/thing${i}.ts`
  }));
  return JSON.stringify({ built_at_commit: "0".repeat(40), directed: false, nodes, links: [] });
}

/** A fake `graphify export obsidian` that writes exactly one note plus its housekeeping. */
function fakeGraphifyBin(dir) {
  const binPath = join(dir, "graphify");
  write(
    binPath,
    `#!/usr/bin/env bash
set -euo pipefail
cmd="$1"; shift
if [ "$cmd" = "export" ] && [ "$1" = "obsidian" ]; then
  shift
  dir=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--dir" ]; then dir="$2"; shift 2; else shift; fi
  done
  mkdir -p "$dir/.obsidian"
  printf -- '---\\nsource_file: "src/thing0.ts"\\ntype: "code"\\ncommunity: "Fixture Community"\\n---\\n\\n# thing0()\\n' > "$dir/thing0().md"
  printf '{}' > "$dir/graph.canvas"
  printf '{}' > "$dir/.obsidian/graph.json"
  printf '{"files":[]}' > "$dir/.graphify_obsidian_manifest.json"
  exit 0
else
  echo "fake graphify: unsupported command: $cmd $*" >&2
  exit 1
fi
`
  );
  chmodSync(binPath, 0o755);
  return dir;
}

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-obsidian-export-"));
  cleanup.push(root);
  write(join(root, "graphify-out/graph.json"), fakeGraph(1));
  return root;
}

async function runExport(fixtureRoot, fakeBinDir) {
  const child = Bun.spawn(["bun", EXPORT_SCRIPT], {
    cwd: fixtureRoot,
    env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, KNOWLEDGE_GRAPH_ROOT: fixtureRoot },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, output: out + err };
}

describe("housekeeping is excluded without failing the run", () => {
  test("the .obsidian/ directory and the export manifest are never synced", async () => {
    const fixtureRoot = buildFixture();
    const fakeBinDir = mkdtempSync(join(tmpdir(), "fake-graphify-"));
    cleanup.push(fakeBinDir);
    fakeGraphifyBin(fakeBinDir);

    const { code, output } = await runExport(fixtureRoot, fakeBinDir);

    expect(code).toBe(0);
    // thing0().md + graph.canvas synced; .obsidian/graph.json + the export
    // manifest skipped as housekeeping.
    expect(output).toContain("2 file(s) synced");
    expect(output).toContain("2 housekeeping entr");
    expect(existsSync(join(fixtureRoot, "knowledge/generated/graphify/thing0().md"))).toBe(true);
    expect(existsSync(join(fixtureRoot, "knowledge/generated/graphify/graph.canvas"))).toBe(true);
    expect(existsSync(join(fixtureRoot, "knowledge/generated/graphify/.obsidian"))).toBe(false);
    expect(existsSync(join(fixtureRoot, "knowledge/generated/graphify/.graphify_obsidian_manifest.json"))).toBe(false);
  });
});

describe("a re-sync clears stale output", () => {
  test("a note for a node the current export no longer produces is removed", async () => {
    const fixtureRoot = buildFixture();
    // Simulate a previous sync that produced a note the CURRENT export run
    // will not — the exact shape a renamed/deleted symbol leaves behind.
    write(join(fixtureRoot, "knowledge/generated/graphify/stale-symbol().md"), "# stale\n");

    const fakeBinDir = mkdtempSync(join(tmpdir(), "fake-graphify-"));
    cleanup.push(fakeBinDir);
    fakeGraphifyBin(fakeBinDir);

    const { code } = await runExport(fixtureRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(existsSync(join(fixtureRoot, "knowledge/generated/graphify/stale-symbol().md"))).toBe(false);
    expect(existsSync(join(fixtureRoot, "knowledge/generated/graphify/thing0().md"))).toBe(true);
  });
});
