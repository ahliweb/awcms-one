/**
 * The gate over the shared script helpers — `packages/gerbang/lib/`.
 *
 * Each rule below is adapted from `ahliweb/media-lenterakalteng`'s own
 * `tests/standar-skrip.test.mjs`, which found each one decaying by
 * ADDITION: nothing breaks when a second copy of a helper is written, so
 * nothing tells the author not to. Asserting the rule directly, rather than
 * trusting it to hold because it holds today, is what keeps it true as this
 * repo's own script surface grows past the two gates and three tools it
 * starts with.
 *
 *   1. **No shell for git.** The only security assertion here, and not
 *      hypothetical: an `execSync` call with a value interpolated into its
 *      command string is a real injection risk the moment that value can
 *      come from something an attacker names (a git ref, a file name) — see
 *      `packages/gerbang/lib/git.mjs`'s own docblock.
 *   2. **One finding/report apparatus**, so a change to gate OUTPUT is made
 *      once, not once per gate with the third copy being the one that gets
 *      missed.
 *   3. **One JSONC scanner, one `readFileIfPresent`.** Each is a small
 *      enough function that duplicating it feels harmless in the moment —
 *      which is exactly how two copies end up with different bugs.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { formatReport } from "../packages/gerbang/lib/reporter.mjs";

const GERBANG_DIR = "packages/gerbang";

/** Every directory that can hold an executable script outside `lib/`. */
const SCRIPT_DIRS = [GERBANG_DIR, "tools"];

/** Every `.mjs` directly under one of `SCRIPT_DIRS` — the executable gates and tools. */
const scripts = SCRIPT_DIRS.flatMap((dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => ({ name: `${dir}/${name}`, text: readFileSync(join(dir, name), "utf8") }))
);

/**
 * Comments and string literals removed, so a pattern named in a docblock is
 * not mistaken for the code it warns about.
 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

describe("packages/gerbang/lib/git.mjs — git never travels through a shell", () => {
  test("no script interpolates a value into an execSync command string", () => {
    for (const { name, text } of scripts) {
      const matches = [...codeOnly(text).matchAll(/execSync\(``/g)];
      // A template literal survives codeOnly() as ``. Any execSync taking
      // one had something interpolated into it — a constant command needs
      // no template literal at all.
      assert.equal(
        matches.length,
        0,
        `${name}: execSync with a template literal. A value interpolated ` +
          `into a shell command is a real injection risk — use ` +
          `packages/gerbang/lib/git.mjs, which spawns an argv array.`
      );
    }
  });

  test("git is spawned only inside packages/gerbang/lib/git.mjs", () => {
    for (const { name, text } of scripts) {
      const code = codeOnly(text);
      assert.ok(
        !/spawnSync\(\s*\[\s*""/.test(code) || !/git/.test(code),
        `${name}: spawns a command array directly. Route it through ` +
          `packages/gerbang/lib/git.mjs so the null-on-failure contract stays in one place.`
      );
      assert.ok(
        !/execFileSync\(/.test(code),
        `${name}: uses execFileSync. packages/gerbang/lib/git.mjs is what ` +
          `keeps every script agreeing on how a missing git repo is reported.`
      );
    }
  });
});

describe("packages/gerbang/lib/reporter.mjs — one finding apparatus", () => {
  const gates = ["audit-dokumen.mjs", "audit-rilis.mjs", "audit-graf.mjs"];

  test("every audit gate builds its report through createReporter", () => {
    for (const gate of gates) {
      const text = readFileSync(join(GERBANG_DIR, gate), "utf8");
      assert.match(
        text,
        /import \{ createReporter \} from "\.\/lib\/reporter\.mjs"/,
        `${gate} no longer imports the shared reporter.`
      );
    }
  });

  test("no gate declares a second printer", () => {
    for (const gate of gates) {
      const code = codeOnly(readFileSync(join(GERBANG_DIR, gate), "utf8"));
      assert.ok(
        !/const findings = \[\]/.test(code),
        `${gate}: re-declares its own findings array instead of the reporter's.`
      );
    }
  });

  test("notes print whatever the outcome — a silent gate is a false tick", () => {
    const green = formatReport(["2 markdown file(s), 3 internal link(s) checked"], []);
    assert.equal(green.exitCode, 0);
    assert.match(green.text, /2 markdown file\(s\)/);
    assert.match(green.text, /OK — no violations\./);

    // The red path must keep them too: the notes are what say which checks
    // ran at all, and that is exactly what a reader needs when something failed.
    const red = formatReport(["adr: docs/adr/README.md does not exist — ADR index gate SKIPPED"], [
      { gate: "dead-link", file: "a.md", message: "points at b.md, which does not exist" }
    ]);
    assert.equal(red.exitCode, 1);
    assert.match(red.text, /ADR index gate SKIPPED/);
  });

  test("findings group by gate, and the count is the finding count", () => {
    const { text, exitCode } = formatReport([], [
      { gate: "named-path", file: "README.md", message: "names `x/y.ts`, which does not exist" },
      { gate: "dead-link", file: "docs/a.md", message: "points at b.md, which does not exist" },
      { gate: "named-path", file: "AGENTS.md", message: "names `x/z.ts`, which does not exist" }
    ]);

    assert.equal(exitCode, 1);
    assert.match(text, /FAILED — 3 violation\(s\):/);
    assert.match(text, /\[named-path\] 2/);
    assert.match(text, /\[dead-link\] 1/);
    // Grouped, so the two `named-path` findings are adjacent rather than
    // split by the `dead-link` one reported between them.
    assert.ok(
      text.indexOf("x/z.ts") < text.indexOf("dead-link"),
      "findings are not grouped by gate"
    );
  });
});

describe("packages/gerbang/lib/ — no helper is declared twice", () => {
  test("the JSONC scanner exists once", () => {
    const copies = scripts.filter(({ text }) =>
      /function stripTrailingCommas\s*\(/.test(codeOnly(text))
    );
    assert.deepEqual(
      copies.map((c) => c.name),
      [],
      "stripTrailingCommas is declared in a script again — it belongs in packages/gerbang/lib/lockfile.mjs."
    );
  });

  test("readFileIfPresent exists once", () => {
    const copies = scripts.filter(({ text }) =>
      /function readFileIfPresent\s*\(/.test(codeOnly(text))
    );
    assert.deepEqual(
      copies.map((c) => c.name),
      [],
      "readFileIfPresent is declared in a script again — it belongs in packages/gerbang/lib/files.mjs."
    );
  });

  test("packages/gerbang/lib/ modules are side-effect free — importing one runs nothing", () => {
    for (const name of readdirSync(join(GERBANG_DIR, "lib"))) {
      const code = codeOnly(readFileSync(join(GERBANG_DIR, "lib", name), "utf8"));

      // Column 0 only. `reporter.mjs` exits INSIDE `finish()` on purpose —
      // that is a gate delivering its verdict when a caller asks for it.
      // What this refuses is an exit at MODULE level: importing a module
      // that can exit means importing a decision the importer did not make.
      assert.ok(
        !/^process\.exit\(/m.test(code),
        `packages/gerbang/lib/${name}: exits at import time.`
      );

      // Nor may it print on import: the reporter's header is printed by
      // createReporter(), i.e. when a gate starts, never by the import itself.
      assert.ok(
        !/^console\.(log|error)\(/m.test(code),
        `packages/gerbang/lib/${name}: writes to stdout at import time.`
      );
    }
  });
});
