/**
 * The gate over version mirrors (issue #536) — copies of the product version
 * that live where the root `package.json` cannot be read.
 *
 *   1. The real tree: every mirror declared in `tools/version-mirrors.json`
 *      equals the root version. The template ships none, so this is vacuously
 *      true here and becomes a real guard in a derived product.
 *   2. The library: rewrite, loud failure, no partial write.
 *   3. `tools/rilis.mjs` end to end in a disposable repository, preview mode
 *      only (`--apply` would run the whole gate suite): a declared mirror is
 *      reported, a broken one refuses the release.
 *
 * Every filesystem case uses a temp directory; the real CHANGELOG.md and
 * package.json are only ever read.
 */
import { afterAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { gitRunOrThrow } from "../packages/gerbang/lib/git.mjs";
import {
  MIRRORS_CONFIG_PATH,
  applyMirrorPlan,
  findMirrorMismatches,
  loadMirrors,
  parseMirrorConfig,
  planMirrors
} from "../packages/gerbang/lib/version-mirrors.mjs";

const REPO_ROOT = resolve(import.meta.dir, "..");
const RILIS = join(REPO_ROOT, "tools", "rilis.mjs");

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "version-mirrors-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const CONSTANT = 'export const PRODUCT_VERSION = "1.2.3";\n';
const MIRROR = {
  file: "sub/src/version.ts",
  pattern: 'PRODUCT_VERSION = "([^"]+)"'
};

function seedTree(dir, { source = CONSTANT, mirrors = [MIRROR] } = {}) {
  mkdirSync(join(dir, "sub", "src"), { recursive: true });
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, MIRROR.file), source);
  writeFileSync(join(dir, MIRRORS_CONFIG_PATH), JSON.stringify({ mirrors }));
}

describe("the repository's own mirrors", () => {
  test("every declared mirror equals the root package.json version", () => {
    const { version } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    const mirrors = loadMirrors(REPO_ROOT);
    assert.deepEqual(findMirrorMismatches(REPO_ROOT, mirrors, version), []);
  });

  test("the template ships an empty list", () => {
    assert.deepEqual(loadMirrors(REPO_ROOT), []);
  });
});

describe("parseMirrorConfig refuses a malformed declaration", () => {
  test("accepts an empty list and a valid mirror", () => {
    assert.deepEqual(parseMirrorConfig({ mirrors: [] }), []);
    assert.deepEqual(parseMirrorConfig({ mirrors: [MIRROR] }), [MIRROR]);
  });

  test("rejects each malformed shape", () => {
    for (const bad of [
      null,
      {},
      { mirrors: "x" },
      { mirrors: [{ file: "a" }] },
      { mirrors: [{ file: "/etc/x", pattern: "(a)" }] },
      { mirrors: [{ file: "../x", pattern: "(a)" }] },
      { mirrors: [{ file: "a", pattern: "(" }] },
      { mirrors: [{ file: "a", pattern: "no group" }] },
      { mirrors: [{ file: "a", pattern: "(a)(b)" }] },
      { mirrors: [{ file: "a", pattern: "(a)" }, { file: "a", pattern: "(b)" }] }
    ]) {
      assert.throws(() => parseMirrorConfig(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe("planMirrors and applyMirrorPlan", () => {
  test("rewrites only the captured version and leaves the rest alone", () => {
    const dir = tempDir();
    seedTree(dir, { source: `// header\n${CONSTANT}export const OTHER = "1.2.3";\n` });
    const plan = planMirrors(dir, [MIRROR], "1.3.0");
    assert.equal(plan[0].from, "1.2.3");
    applyMirrorPlan(dir, plan);
    assert.equal(
      readFileSync(join(dir, MIRROR.file), "utf8"),
      '// header\nexport const PRODUCT_VERSION = "1.3.0";\nexport const OTHER = "1.2.3";\n'
    );
    assert.deepEqual(findMirrorMismatches(dir, [MIRROR], "1.3.0"), []);
    assert.equal(findMirrorMismatches(dir, [MIRROR], "1.4.0").length, 1);
  });

  test("a missing file fails loudly", () => {
    const dir = tempDir();
    assert.throws(() => planMirrors(dir, [MIRROR], "1.3.0"), /sub\/src\/version\.ts: file does not exist/);
  });

  test("a pattern that matches nothing fails loudly", () => {
    const dir = tempDir();
    seedTree(dir, { source: "export const NAME = 1;\n" });
    assert.throws(() => planMirrors(dir, [MIRROR], "1.3.0"), /matches nothing/);
  });

  test("a pattern that matches twice fails loudly", () => {
    const dir = tempDir();
    seedTree(dir, { source: `${CONSTANT}${CONSTANT}` });
    assert.throws(() => planMirrors(dir, [MIRROR], "1.3.0"), /matches 2 times/);
  });

  test("a captured value that is not a version fails loudly", () => {
    const dir = tempDir();
    seedTree(dir, { source: 'export const PRODUCT_VERSION = "dev";\n' });
    assert.throws(() => planMirrors(dir, [MIRROR], "1.3.0"), /not an X\.Y\.Z version/);
  });

  test("one bad mirror among good ones writes nothing", () => {
    const dir = tempDir();
    seedTree(dir);
    writeFileSync(join(dir, "other.ts"), "nothing here\n");
    const bad = { file: "other.ts", pattern: 'V = "([^"]+)"' };
    assert.throws(() => planMirrors(dir, [MIRROR, bad], "1.3.0"), /1 version mirror\(s\) cannot be rewritten/);
    assert.equal(readFileSync(join(dir, MIRROR.file), "utf8"), CONSTANT);
  });
});

describe("tools/rilis.mjs wires the hook in", () => {
  /** A disposable git repository with one patch changeset, version 1.2.3. */
  function seedRelease(dir, opts) {
    seedTree(dir, opts);
    gitRunOrThrow(dir, "init", "-q");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.2.3" }, null, 2));
    mkdirSync(join(dir, ".changesets"));
    writeFileSync(
      join(dir, ".changesets", "2026-11-24-a-fix.md"),
      "---\nbump: patch\ntype: fix\nimpact: internal\n---\n\n# A fix\n\nBody.\n"
    );
  }

  async function runRilis(dir) {
    const child = Bun.spawn(["bun", RILIS], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);
    return { out, err, code };
  }

  test("a declared mirror is reported in the preview and nothing is written", async () => {
    const dir = tempDir();
    seedRelease(dir);
    const { out, code } = await runRilis(dir);
    assert.equal(code, 0);
    assert.match(out, /Version mirror: sub\/src\/version\.ts {2}1\.2\.3 -> 1\.2\.4/);
    assert.equal(readFileSync(join(dir, MIRROR.file), "utf8"), CONSTANT);
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "1.2.3");
  });

  test("a mirror whose pattern is missing refuses the release and leaves the tree untouched", async () => {
    const dir = tempDir();
    seedRelease(dir, { source: "export const NAME = 1;\n" });
    const { err, code } = await runRilis(dir);
    assert.equal(code, 1);
    assert.match(err, /Version mirrors \(tools\/version-mirrors\.json\)/);
    assert.match(err, /matches nothing/);
  });

  test("with no mirrors the output carries no mirror line", async () => {
    const dir = tempDir();
    seedRelease(dir, { mirrors: [] });
    const { out, code } = await runRilis(dir);
    assert.equal(code, 0);
    assert.doesNotMatch(out, /Version mirror/);
  });

  test("the rewrite is applied only after the root package.json is written", () => {
    const source = readFileSync(RILIS, "utf8");
    const bump = source.indexOf('fs.writeFileSync("package.json"');
    const apply = source.indexOf("applyMirrorPlan(");
    const plan = source.indexOf("planMirrors(");
    assert.ok(plan > 0 && plan < source.indexOf("if (!apply)"), "mirrors are planned before anything is written");
    assert.ok(bump > 0 && apply > bump, "mirrors are rewritten after the root bump");
  });
});
