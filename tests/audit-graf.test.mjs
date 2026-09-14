/**
 * End-to-end tests for `packages/gerbang/audit-graf.mjs`, run against
 * disposable fixture trees — the same pattern as
 * `tests/audit-dokumen.test.mjs`, extended with a real (tiny) git repo per
 * fixture, because several of this gate's checks read `git ls-files`
 * (tracked-artefact hygiene, the federated graph staying untracked, the
 * subtree staying untouched) and cannot be proven without one.
 *
 * Each defect below is reproduced once to prove the gate goes RED, and
 * cleared once to prove the SAME tree then goes GREEN — the same discipline
 * `apps/cms/scripts/graph-artifacts-check.ts`'s own test suite uses, and the
 * proof this gate is not a trivial always-green check (issue #11's
 * acceptance criteria, and README.md's own reason `audit:graf` was withheld
 * until there was something real for it to guard).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve("packages/gerbang/audit-graf.mjs");

/** @type {string[]} */
const cleanup = [];

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
});

/**
 * A minimal, self-consistent graph.json + GRAPH_REPORT.md + .graphifyignore
 * fixture: one community, one node, properly labeled, counts agreeing. Every
 * test starts from this GREEN baseline and mutates exactly one thing, so a
 * failing assertion points at the one change that caused it.
 *
 * @param {object} [overrides]
 * @param {object} [overrides.graph] - merged over the default graph object
 * @param {string} [overrides.report] - replaces GRAPH_REPORT.md wholesale
 * @param {string} [overrides.ignore] - replaces .graphifyignore wholesale
 * @param {Record<string, string>} [overrides.extra] - extra files, e.g. a stray tracked artefact
 * @param {boolean} [overrides.git] - init a real git repo and `git add -A` (default true)
 */
function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "audit-graf-"));
  cleanup.push(root);

  const graph = {
    built_at_commit: "0".repeat(40),
    directed: false,
    nodes: [
      { id: "n1", label: "thing()", community: 0, community_name: "Widget Assembly", source_file: "src/thing.ts" }
    ],
    links: [],
    ...overrides.graph
  };

  const report =
    overrides.report ??
    [
      "# Graph Report - .  (2026-09-15)",
      "",
      "## Summary",
      "- 1 nodes · 0 edges · 1 communities",
      "",
      '### Community 0 - "Widget Assembly"',
      "Nodes (1): thing()"
    ].join("\n");

  const ignore =
    overrides.ignore ?? "# root .graphifyignore\napps/cms/\n";

  const files = {
    "graphify-out/graph.json": JSON.stringify(graph),
    "graphify-out/GRAPH_REPORT.md": report,
    "graphify-out/manifest.json": "{}",
    "graphify-out/cost.json": '{"runs":[],"total_input_tokens":0,"total_output_tokens":0}',
    ".graphifyignore": ignore,
    "apps/cms/graphify-out/graph.json": "{}",
    "apps/cms/graphify-out/GRAPH_REPORT.md": "",
    "apps/cms/graphify-out/manifest.json": "{}",
    "apps/cms/graphify-out/cost.json": "{}",
    ...overrides.extra
  };

  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  if (overrides.git !== false) {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: root });
    Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: root });
    Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  }

  return root;
}

async function run(root) {
  const child = Bun.spawn(["bun", SCRIPT, root], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return { code: await child.exited, output: out + err };
}

describe("baseline", () => {
  test("a self-consistent, git-tracked fixture is green", async () => {
    const { code, output } = await run(fixture());
    expect(output).toContain("OK — no violations.");
    expect(code).toBe(0);
  });

  test("no graphify-out/ at all passes with a note, not a failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "audit-graf-"));
    cleanup.push(root);
    const { code, output } = await run(root);
    expect(code).toBe(0);
    expect(output).toContain("absent — no root graph artefacts to check");
  });
});

describe("no duplicate extraction of apps/cms", () => {
  test("a node sourced from apps/cms/ is a violation", async () => {
    const root = fixture({
      graph: {
        nodes: [
          { id: "n1", label: "thing()", community: 0, community_name: "Widget Assembly", source_file: "src/thing.ts" },
          { id: "n2", label: "cms()", community: 0, community_name: "Widget Assembly", source_file: "apps/cms/src/x.ts" }
        ]
      },
      report: [
        "## Summary",
        "- 2 nodes · 0 edges · 1 communities",
        "",
        '### Community 0 - "Widget Assembly"',
        "Nodes (2): thing(), cms()"
      ].join("\n")
    });

    const { code, output } = await run(root);
    expect(code).toBe(1);
    expect(output).toContain("no-duplicate-extraction");
    expect(output).toContain("apps/cms/src/x.ts");
  });
});

describe(".graphifyignore must exclude apps/cms", () => {
  test("a .graphifyignore with no apps/cms entry is a violation", async () => {
    const root = fixture({ ignore: "# nothing excluded here\n" });
    const { code, output } = await run(root);
    expect(code).toBe(1);
    expect(output).toContain("subtree-excluded");
    expect(output).toContain("does not exclude apps/cms");
  });

  test("excluding it only via a glob is reported, not silently accepted", async () => {
    const root = fixture({ ignore: "apps/cms/**\n" });
    const { code, output } = await run(root);
    expect(code).toBe(1);
    expect(output).toContain("subtree-excluded");
    expect(output).toContain("cannot verify");
  });
});

describe("the report agrees with the graph", () => {
  test("a stale Summary line is a violation", async () => {
    const root = fixture({
      report: ["## Summary", "- 99 nodes · 99 edges · 99 communities", "", '### Community 0 - "Widget Assembly"'].join("\n")
    });
    const { code, output } = await run(root);
    expect(code).toBe(1);
    expect(output).toContain("report-agrees");
    expect(output).toContain("claims 99 nodes, graph.json holds 1");
  });
});

describe("every community has a name somebody chose", () => {
  test("a placeholder Community N label is a violation", async () => {
    const root = fixture({
      graph: { nodes: [{ id: "n1", community: 0, community_name: "Community 0", source_file: "src/thing.ts" }] },
      report: ["## Summary", "- 1 nodes · 0 edges · 1 communities", "", '### Community 0 - "Community 0"'].join("\n")
    });
    const { code, output } = await run(root);
    expect(code).toBe(1);
    expect(output).toContain("still the placeholder");
  });

  test("a bare filename label is a violation", async () => {
    const root = fixture({
      graph: { nodes: [{ id: "n1", community: 0, community_name: "thing.ts", source_file: "src/thing.ts" }] },
      report: ["## Summary", "- 1 nodes · 0 edges · 1 communities", "", '### Community 0 - "thing.ts"'].join("\n")
    });
    const { code, output } = await run(root);
    expect(code).toBe(1);
    expect(output).toContain("that is a filename");
  });
});

describe("the federated graph is never accidentally committed", () => {
  test("a tracked file under graphify-out/combined/ is a violation", async () => {
    const root = fixture({ extra: { "graphify-out/combined/graph.json": "{}" } });
    const { code, output } = await run(root);
    expect(code).toBe(1);
    expect(output).toContain("combined-untracked");
  });
});

describe("only the tracked root artefacts are tracked", () => {
  test("an extra tracked file under graphify-out/ is a violation", async () => {
    const root = fixture({ extra: { "graphify-out/scratch.txt": "hello" } });
    const { code, output } = await run(root);
    expect(code).toBe(1);
    expect(output).toContain("not one of the tracked root artefacts");
  });

  test("a missing tracked artefact is a violation", async () => {
    const root = fixture();
    // Remove one of the four from the git index without deleting the file's
    // sibling content, so the loop under test sees "not tracked" specifically.
    Bun.spawnSync(["git", "rm", "-q", "--cached", "graphify-out/cost.json"], { cwd: root });
    const { code, output } = await run(root);
    expect(code).toBe(1);
    expect(output).toContain("cost.json: shared artefact is not tracked");
  });
});

describe("the subtree stays untouched", () => {
  test("an extra tracked file under apps/cms/graphify-out/ is a violation", async () => {
    const root = fixture({ extra: { "apps/cms/graphify-out/combined.json": "{}" } });
    const { code, output } = await run(root);
    expect(code).toBe(1);
    expect(output).toContain("subtree-untouched");
  });
});
