/**
 * Root env-var coverage gate (issue #25).
 *
 * AGENTS.md's "Configuration and toolchain": "Every env variable a
 * root-level script reads belongs in `.env.example`, with the consequence
 * of leaving it unset." Nothing checked that mechanically until now — it
 * held by discipline alone, which is exactly the class of rule this repo's
 * own gates exist to stop trusting.
 *
 * Scans two new surfaces from issue #25, the first of their kind at the
 * root: `tools/*.ts` (`tools/seed-borneojek-mart.ts`, this repo's first
 * root-level TypeScript tool — every earlier one is `.mjs`) for
 * `process.env.NAME`, and `compose.yaml` for `${NAME}`/`${NAME:-...}`/
 * `${NAME:?...}` interpolation. Every name found must appear as a `NAME=`
 * line in root `.env.example`.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const ENV_EXAMPLE = readFileSync(".env.example", "utf8");

/** Every `NAME=` declaration at the start of a line — commented-out (`# NAME=`) lines are deliberately excluded, since a commented default documents the variable exactly as much as an active one, but only the active-line pattern is unambiguous to parse. */
const DOCUMENTED_NAMES = new Set(
  [...ENV_EXAMPLE.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1])
);

function namesFromProcessEnv(text) {
  return [...text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
}

/** `${NAME}`, `${NAME:-default}`, `${NAME:?message}` — compose's own interpolation syntax. */
function namesFromComposeInterpolation(text) {
  return [...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::[-?][^}]*)?\}/g)].map(
    (m) => m[1]
  );
}

describe("root .env.example documents every variable a root script or compose.yaml reads", () => {
  test("tools/*.ts", () => {
    const files = readdirSync("tools").filter((name) => name.endsWith(".ts"));

    // Non-vacuity: this assertion is only meaningful once there is at least
    // one root-level .ts tool to scan.
    assert.ok(
      files.length > 0,
      "expected at least one tools/*.ts file (tools/seed-borneojek-mart.ts, issue #25) — did it move or get renamed?"
    );

    for (const file of files) {
      const text = readFileSync(`tools/${file}`, "utf8");
      for (const name of namesFromProcessEnv(text)) {
        assert.ok(
          DOCUMENTED_NAMES.has(name),
          `tools/${file} reads process.env.${name}, which .env.example does not document.`
        );
      }
    }
  });

  test("compose.yaml", () => {
    const text = readFileSync("compose.yaml", "utf8");
    const names = namesFromComposeInterpolation(text);

    assert.ok(
      names.length > 0,
      "expected compose.yaml to interpolate at least one ${VAR} — did its shape change?"
    );

    for (const name of names) {
      assert.ok(
        DOCUMENTED_NAMES.has(name),
        `compose.yaml reads \${${name}}, which .env.example does not document.`
      );
    }
  });
});
