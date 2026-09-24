/**
 * awcms-one issue #212 (acceptance criterion 7): the synchronized
 * `omes_control` owner/operator API (upstream `sql/154`-`sql/158`, ADR-0122 /
 * `ahliweb/omes#196`/`#198`) must not imply arbitrary shell/SSH access or take
 * on OMES/Hermes runtime execution ownership — that ownership was moved OUT
 * of this family to `ahliweb/omes` by issue #146, and stays there.
 *
 * This is a STATIC check, deliberately independent of `DATABASE_URL`: it
 * greps every non-fixture, non-schema source file under
 * `src/modules/omes-control/` and its API routes for the concrete shapes a
 * real shell/SSH executor would need (`node:child_process`, `Bun.spawn`,
 * an `ssh2`-family import, or a raw `exec(`/`execSync(` call) and asserts
 * none exist. `omes_control` today is a tenant-scoped record store plus an
 * owner/operator API surface (register/read/approve/cancel/restore/rollback
 * against its own Postgres tables) — the moment it starts spawning a
 * subprocess or opening an SSH session FROM AWCMS itself is the moment this
 * repo has silently taken back the runtime-execution ownership issue #146
 * deliberately moved out. JSON schema/fixture files are excluded: several
 * fixtures under `contracts/v1/fixtures/deployment.request/` are named
 * `invalid-free-form-command*`/`invalid-operation-not-allowlisted*` — they
 * exist to prove a free-form shell command is REJECTED by the contract, so
 * the string "exec(" appearing inside a fixture's own descriptive text would
 * be a false positive here, not a real capability.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const MODULE_ROOT = path.resolve(
  import.meta.dir,
  "..",
  "src",
  "modules",
  "omes-control"
);

const API_ROOT = path.resolve(
  import.meta.dir,
  "..",
  "src",
  "pages",
  "api",
  "v1",
  "omes"
);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".astro"]);

const FORBIDDEN_PATTERNS: { label: string; pattern: RegExp }[] = [
  {
    label: "node:child_process import",
    pattern: /from\s+["']node:child_process["']/
  },
  { label: "child_process import", pattern: /from\s+["']child_process["']/ },
  { label: "Bun.spawn call", pattern: /Bun\.spawn(Sync)?\s*\(/ },
  { label: "ssh2-family import", pattern: /from\s+["']ssh2["']/ },
  { label: "raw exec()/execSync() call", pattern: /\bexecSync?\s*\(/ }
];

function collectSourceFiles(root: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stats = statSync(fullPath);

      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (SOURCE_EXTENSIONS.has(path.extname(entry))) {
        results.push(fullPath);
      }
    }
  }

  walk(root);
  return results;
}

describe("omes_control carries no shell/SSH execution capability (Issue #212, execution ownership stays in ahliweb/omes)", () => {
  test("no source file under src/modules/omes-control/ imports child_process/ssh2, calls Bun.spawn, or calls a raw exec()/execSync()", () => {
    const files = collectSourceFiles(MODULE_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf8");

      for (const { label, pattern } of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          offenders.push(`${path.relative(MODULE_ROOT, file)}: ${label}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("no route file under src/pages/api/v1/omes/ imports child_process/ssh2, calls Bun.spawn, or calls a raw exec()/execSync()", () => {
    const files = collectSourceFiles(API_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf8");

      for (const { label, pattern } of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          offenders.push(`${path.relative(API_ROOT, file)}: ${label}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
