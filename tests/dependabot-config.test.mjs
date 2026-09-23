/**
 * `.github/dependabot.yml` (issue #180) is the config that makes
 * AGENTS.md's "Configuration and toolchain" claim true — that a pinned
 * GitHub Action's `# vX.Y.Z` comment is something "Dependabot reads to keep
 * both in step". Nothing else in this repo's gate chain reads this file, so
 * nothing else would notice if it silently regressed to a shape that:
 *
 *   - opens PRs against `apps/cms/**` — a `git subtree` embed of
 *     `ahliweb/awcms` this repo never edits locally (AGENTS.md's "The
 *     subtree embed"); a Dependabot PR there is exactly the kind of local
 *     patch a future `git subtree pull` can silently conflict with or
 *     overwrite.
 *   - re-adds a `bun` ecosystem block while `bun.lock`'s own
 *     `lockfileVersion` is still one Dependabot's `bun` updater cannot
 *     parse (issue #199, follow-up to #180/#179: the first scheduled run
 *     against that block failed outright — run 35858077848,
 *     "Unsupported bun.lock 'lockfileVersion' 2 in /bun.lock. The bun
 *     version Dependabot runs supports up to 1." — so the block was
 *     removed rather than left permanently red). This repo's own
 *     workspace dependencies are bumped by hand until then: `bun update`,
 *     then `bun run check:lockfile` (AGENTS.md's "Configuration and
 *     toolchain", docs/alur-kerja-pengembangan.md's "Dependency updates").
 *   - bumps Bun's own version through a single-dependency PR, when it is
 *     pinned in three places that must move together (`packageManager`/
 *     `engines.bun` here, `bun-version` in every `ci.yml` job — same
 *     document) — relevant again the day the `bun` block is re-enabled.
 *
 * This is a small, regex-level check — not a full YAML/JSON-schema
 * validator — deliberately: `yaml` is not a declared dependency of any
 * workspace in this repo (it is only ever a transitive one), and parsing
 * Dependabot's own schema is Dependabot's job, not this repo's. What this
 * test owns is the repo-specific invariants above, which a schema
 * validator would never know to check.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTrailingCommas } from "../packages/gerbang/lib/lockfile.mjs";

const CONFIG_PATH = ".github/dependabot.yml";
const config = readFileSync(CONFIG_PATH, "utf8");

// `bun.lock` is JSONC (bun allows trailing commas), not strict JSON — the
// same reason `tools/cek-lockfile.mjs` runs it through this shared helper
// before parsing (AGENTS.md: "a helper is declared once").
const LOCKFILE_PATH = "bun.lock";
const lockfile = JSON.parse(stripTrailingCommas(readFileSync(LOCKFILE_PATH, "utf8")));

/** One `- package-ecosystem: "..."` block per top-level list item, roughly. */
const blocks = config
  .split(/\n(?=  - package-ecosystem:)/)
  .filter((block) => block.trim().startsWith("- package-ecosystem:"));

describe(".github/dependabot.yml", () => {
  test("declares config version 2", () => {
    assert.match(config, /^version:\s*2\s*$/m);
  });

  test("has exactly one github-actions block, and no bun block while bun.lock is lockfileVersion > 1", () => {
    const ecosystems = [...config.matchAll(/package-ecosystem:\s*"([^"]+)"/g)].map(
      (m) => m[1]
    );

    assert.ok(
      typeof lockfile.lockfileVersion === "number",
      "bun.lock has no numeric lockfileVersion to check against"
    );

    if (lockfile.lockfileVersion > 1) {
      // Dependabot's `bun` ecosystem cannot parse this lockfile version yet
      // (issue #199) — the block must stay absent so a scheduled run does
      // not fail every month. If this assertion is what's failing here,
      // Dependabot has caught up: restore the `bun` block (git history has
      // its last shape, prior to the commit that closed #199) and update
      // this test to require it again alongside "github-actions".
      assert.deepEqual(
        ecosystems,
        ["github-actions"],
        `expected only a "github-actions" update block while bun.lock is lockfileVersion ${lockfile.lockfileVersion}, found ${JSON.stringify(ecosystems)}`
      );
    } else {
      assert.deepEqual(
        [...ecosystems].sort(),
        ["bun", "github-actions"],
        `bun.lock is lockfileVersion ${lockfile.lockfileVersion} (Dependabot's bun updater should support it) — expected a "bun" update block back alongside "github-actions", found ${JSON.stringify(ecosystems)}`
      );
    }
  });

  test("never opens updates against apps/cms — that tree is upstream's own subtree", () => {
    // Both as a scanned directory and as anything the file otherwise names,
    // apps/cms only appears here as something explicitly EXCLUDED.
    for (const line of config.split("\n")) {
      if (!line.includes("apps/cms")) continue;
      assert.match(
        line,
        /exclude-paths|#|^\s*-\s*"apps\/cms/,
        `apps/cms must only appear in an exclude-paths entry or a comment, found: ${line.trim()}`
      );
    }
  });

  test("if a bun update block exists, it excludes apps/cms/** and ignores the bun dependency itself", () => {
    const bunBlock = blocks.find((b) => /package-ecosystem:\s*"bun"/.test(b));
    if (!bunBlock) return; // absent entirely is the current, expected shape (issue #199)

    assert.match(bunBlock, /exclude-paths:\s*\n\s*-\s*"apps\/cms\/\*\*"/);

    const ignoreSection = bunBlock.slice(bunBlock.indexOf("ignore:"));
    assert.match(
      ignoreSection,
      /-\s*dependency-name:\s*"bun"/,
      "bun's own version is pinned in three places that move together by hand (AGENTS.md) — a version-update PR must not touch it"
    );
  });

  test("every block groups minor/patch updates and leaves majors ungrouped", () => {
    for (const block of blocks) {
      assert.match(block, /groups:/);
      assert.match(block, /update-types:\s*\n\s*-\s*"minor"\s*\n\s*-\s*"patch"/);
    }
  });

  test("every block runs monthly", () => {
    for (const block of blocks) {
      assert.match(block, /interval:\s*"monthly"/);
    }
  });

  test("every block sets a bounded open-pull-requests-limit", () => {
    for (const block of blocks) {
      const match = block.match(/open-pull-requests-limit:\s*(\d+)/);
      assert.ok(match, "missing open-pull-requests-limit");
      const limit = Number(match[1]);
      assert.ok(limit > 0 && limit <= 20, `open-pull-requests-limit (${limit}) should be a sane, bounded value`);
    }
  });
});
