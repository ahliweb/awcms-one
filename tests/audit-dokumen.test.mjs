/**
 * End-to-end tests for `packages/gerbang/audit-dokumen.mjs`, run against
 * disposable fixture trees rather than this repo's own documents — which is
 * exactly what the script's optional root argument exists for.
 *
 * Not a port of `ahliweb/media-lenterakalteng`'s much larger
 * `tests/audit-dokumen.test.mjs`: most of that file exercises an
 * `EXCLUDED_PATHS` list built from years of that repo's own history, and a
 * `docs/adr/` corpus this repo does not have yet. What is ported is the
 * MECHANISM — proven here to actually go red on the defect it claims to
 * catch, and green on the same tree once corrected, for each check this
 * repo's own `audit-dokumen.mjs` still runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve("packages/gerbang/audit-dokumen.mjs");

/** @type {string[]} */
const cleanup = [];

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
});

/**
 * A fixture tree from a map of relative path -> file content.
 *
 * @param {Record<string, string>} files
 * @returns {string} absolute path to the fixture root
 */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "audit-dokumen-"));
  cleanup.push(root);

  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
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

describe("an unusable root", () => {
  test("a root that does not exist exits 2 with only its own message", async () => {
    const { code, output } = await run(join(tmpdir(), "does-not-exist-at-all"));
    expect(code).toBe(2);
    expect(output).toContain("is not a directory");
  });
});

describe("dead relative links", () => {
  test("a link to a file that does not exist is a violation", async () => {
    const root = tree({ "a.md": "See [the plan](plan.md).\n" });
    const { code, output } = await run(root);

    expect(output).toContain("a.md");
    expect(output).toContain("points at plan.md, which does not exist");
    expect(code).toBe(1);
  });

  test("the same link is clean once the target exists", async () => {
    const root = tree({
      "a.md": "See [the plan](plan.md).\n",
      "plan.md": "# Plan\n"
    });
    const { code, output } = await run(root);

    expect(output).toContain("OK — no violations.");
    expect(code).toBe(0);
  });

  test("a link resolving outside the repo root is a violation", async () => {
    const root = tree({ "a.md": "[out](../outside.md)\n" });
    const { code, output } = await run(root);

    expect(output).toContain("escapes the repo root");
    expect(code).toBe(1);
  });

  test("a leading-slash link is resolved from the repo root, not the disk root", async () => {
    const root = tree({
      "a.md": "[x](/docs/x.md)\n",
      "docs/x.md": "# X\n"
    });
    const { code } = await run(root);
    expect(code).toBe(0);
  });

  test("external links, mailto, and bare anchors are never checked", async () => {
    const root = tree({
      "a.md": [
        "[site](https://example.com/nope)",
        "[mail](mailto:nobody@example.com)",
        "[top](#top)",
        ""
      ].join("\n")
    });
    const { code, output } = await run(root);

    expect(output).toContain("OK — no violations.");
    expect(code).toBe(0);
  });

  test("a link inside a fenced code block is not a link", async () => {
    const root = tree({
      "a.md": "```markdown\n[dead](nope.md)\n```\n"
    });
    const { code } = await run(root);
    expect(code).toBe(0);
  });
});

describe("the ADR index", () => {
  test("no docs/adr/ at all — the check skips itself and says so", async () => {
    const root = tree({ "README.md": "# Hello\n" });
    const { code, output } = await run(root);

    expect(output).toContain("ADR index gate SKIPPED");
    expect(code).toBe(0);
  });

  test("a consistent index (both directions, matching status) is clean", async () => {
    const root = tree({
      "docs/adr/0001-example-decision.md": "# 0001. Example decision\n\n- **Status:** Accepted\n",
      "docs/adr/README.md":
        "# ADR index\n\n| ADR | Title | Status |\n| --- | --- | --- |\n| [0001](0001-example-decision.md) | Example decision | Accepted |\n"
    });
    const { code, output } = await run(root);

    expect(output).toContain("OK — no violations.");
    expect(code).toBe(0);
  });

  test("an ADR file missing from the table is a violation", async () => {
    const root = tree({
      "docs/adr/0001-example-decision.md": "# 0001. Example decision\n\n- **Status:** Accepted\n",
      "docs/adr/README.md": "# ADR index\n\n(nothing recorded yet)\n"
    });
    const { code, output } = await run(root);

    expect(output).toContain("0001-example-decision.md is not recorded in the table");
    expect(code).toBe(1);
  });

  test("a table row pointing at a file that does not exist is a violation", async () => {
    const root = tree({
      "docs/adr/README.md":
        "| ADR | Title | Status |\n| --- | --- | --- |\n| [0002](0002-missing.md) | Ghost | Accepted |\n"
    });
    const { code, output } = await run(root);

    expect(output).toContain("row 0002 points at 0002-missing.md, which does not exist");
    expect(code).toBe(1);
  });

  test("the table's status disagreeing with the ADR file's own status is a violation", async () => {
    const root = tree({
      "docs/adr/0001-example-decision.md": "# 0001. Example decision\n\n- **Status:** Superseded\n",
      "docs/adr/README.md":
        "| ADR | Title | Status |\n| --- | --- | --- |\n| [0001](0001-example-decision.md) | Example decision | Accepted |\n"
    });
    const { code, output } = await run(root);

    expect(output).toContain('is status "Superseded" but the table says "Accepted"');
    expect(code).toBe(1);
  });

  test("the same ADR number recorded twice is a violation, even pointing at the same file", async () => {
    const root = tree({
      "docs/adr/0001-example-decision.md": "# 0001. Example decision\n\n- **Status:** Accepted\n",
      "docs/adr/README.md": [
        "| ADR | Title | Status |",
        "| --- | --- | --- |",
        "| [0001](0001-example-decision.md) | Example decision | Accepted |",
        "| [0001](0001-example-decision.md) | Example decision, again | Accepted |",
        ""
      ].join("\n")
    });
    const { code, output } = await run(root);

    expect(output).toContain("ADR-0001 appears 2 times in the table");
    expect(code).toBe(1);
  });
});

describe("file paths a document names", () => {
  test("a named path that does not exist is a violation", async () => {
    const root = tree({ "a.md": "See `tools/rilis.mjs` for the release script.\n" });
    const { code, output } = await run(root);

    expect(output).toContain("names `tools/rilis.mjs`, which does not exist");
    expect(code).toBe(1);
  });

  test("the same span is clean once the path exists", async () => {
    const root = tree({
      "a.md": "See `tools/rilis.mjs` for the release script.\n",
      "tools/rilis.mjs": "// placeholder\n"
    });
    const { code } = await run(root);
    expect(code).toBe(0);
  });

  test("a path ending in / or containing * is a shape, not a file, and is never checked", async () => {
    const root = tree({ "a.md": "Everything under `apps/` and `packages/*` follows this rule.\n" });
    const { code } = await run(root);
    expect(code).toBe(0);
  });

  test("apps/storefront and packages/kontrak are excluded — not built yet, per issues #5 and #6", async () => {
    const root = tree({
      "a.md": "`apps/storefront` and `packages/kontrak` do not exist in this repo yet.\n"
    });
    const { code, output } = await run(root);

    expect(output).toContain("OK — no violations.");
    expect(code).toBe(0);
  });

  test("a path inside a fenced code block is not checked", async () => {
    const root = tree({ "a.md": "```\ntools/does-not-exist.mjs\n```\n" });
    const { code } = await run(root);
    expect(code).toBe(0);
  });
});

describe("ADR-NNNN citations", () => {
  test("no docs/adr/ at all — the check skips itself and says so", async () => {
    const root = tree({ "a.md": "See ADR-0042 for the reasoning.\n" });
    const { code, output } = await run(root);

    expect(output).toContain("ADR citation gate SKIPPED");
    expect(code).toBe(0);
  });

  test("a citation that resolves to a local ADR file is clean", async () => {
    const root = tree({
      "docs/adr/0001-example-decision.md": "# 0001. Example decision\n\n- **Status:** Accepted\n",
      "a.md": "See ADR-0001 for the reasoning.\n"
    });
    const { code } = await run(root);
    expect(code).toBe(0);
  });

  test("a citation with no local file and no external marker is a violation", async () => {
    const root = tree({
      "docs/adr/0001-example-decision.md": "# 0001. Example decision\n\n- **Status:** Accepted\n",
      "a.md": "See ADR-0099 for the reasoning.\n"
    });
    const { code, output } = await run(root);

    expect(output).toContain("cites ADR-0099");
    expect(output).toContain("does not resolve");
    expect(code).toBe(1);
  });

  test("a citation marked as belonging to another repo (awcms) is skipped", async () => {
    const root = tree({
      "docs/adr/0001-example-decision.md": "# 0001. Example decision\n\n- **Status:** Accepted\n",
      "a.md": "awcms's own ADR-0099 decided this upstream.\n"
    });
    const { code } = await run(root);
    expect(code).toBe(0);
  });
});

describe("linked counts", () => {
  test("a spelled number that matches the actual table-rows count is clean", async () => {
    const root = tree({
      "a.md": [
        "<!-- hitung:mulai key=example source=table-rows -->",
        "This lists three items.",
        "",
        "| a |",
        "| --- |",
        "| 1 |",
        "| 2 |",
        "| 3 |",
        "<!-- hitung:selesai -->",
        ""
      ].join("\n")
    });
    const { code, output } = await run(root);

    expect(output).toContain("OK — no violations.");
    expect(code).toBe(0);
  });

  test("a spelled number that disagrees with the actual count is a violation", async () => {
    const root = tree({
      "a.md": [
        "<!-- hitung:mulai key=example source=table-rows -->",
        "This lists four items.",
        "",
        "| a |",
        "| --- |",
        "| 1 |",
        "| 2 |",
        "| 3 |",
        "<!-- hitung:selesai -->",
        ""
      ].join("\n")
    });
    const { code, output } = await run(root);

    expect(output).toContain('word "four" (4) does not match the actual count 3');
    expect(code).toBe(1);
  });

  test("a marked block with no spelled number at all is a violation, not a pass", async () => {
    const root = tree({
      "a.md": [
        "<!-- hitung:mulai key=example source=table-rows -->",
        "This lists several items.",
        "",
        "| a |",
        "| --- |",
        "| 1 |",
        "<!-- hitung:selesai -->",
        ""
      ].join("\n")
    });
    const { code, output } = await run(root);

    expect(output).toContain("contains no spelled number to check");
    expect(code).toBe(1);
  });

  test("a match: source pointing at a missing file is a violation", async () => {
    const root = tree({
      "a.md": [
        "<!-- hitung:mulai key=example source=match:tools/absent.mjs:(x) -->",
        "One thing.",
        "<!-- hitung:selesai -->",
        ""
      ].join("\n")
    });
    const { code, output } = await run(root);

    expect(output).toContain("does not exist");
    expect(code).toBe(1);
  });

  test("unmarked prose containing spelled numbers is never checked", async () => {
    const root = tree({ "a.md": "Two rules this repo deliberately does not follow.\n" });
    const { code } = await run(root);
    expect(code).toBe(0);
  });
});
