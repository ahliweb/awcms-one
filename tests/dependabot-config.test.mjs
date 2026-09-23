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
 *   - bumps Bun's own version through a single-dependency PR, when it is
 *     pinned in three places that must move together (`packageManager`/
 *     `engines.bun` here, `bun-version` in every `ci.yml` job — same
 *     document).
 *
 * This is a small, regex-level check — not a full YAML/JSON-schema
 * validator — deliberately: `yaml` is not a declared dependency of any
 * workspace in this repo (it is only ever a transitive one), and parsing
 * Dependabot's own schema is Dependabot's job, not this repo's. What this
 * test owns is the two repo-specific invariants above, which a schema
 * validator would never know to check.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CONFIG_PATH = ".github/dependabot.yml";
const config = readFileSync(CONFIG_PATH, "utf8");

/** One `- package-ecosystem: "..."` block per top-level list item, roughly. */
const blocks = config
  .split(/\n(?=  - package-ecosystem:)/)
  .filter((block) => block.trim().startsWith("- package-ecosystem:"));

describe(".github/dependabot.yml", () => {
  test("declares config version 2", () => {
    assert.match(config, /^version:\s*2\s*$/m);
  });

  test("has exactly one github-actions block and one bun block", () => {
    const ecosystems = [...config.matchAll(/package-ecosystem:\s*"([^"]+)"/g)].map(
      (m) => m[1]
    );
    assert.deepEqual(
      [...ecosystems].sort(),
      ["bun", "github-actions"],
      `expected exactly one "github-actions" and one "bun" update block, found ${JSON.stringify(ecosystems)}`
    );
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

  test("the bun update block excludes apps/cms/**", () => {
    const bunBlock = blocks.find((b) => /package-ecosystem:\s*"bun"/.test(b));
    assert.ok(bunBlock, "no bun update block found");
    assert.match(bunBlock, /exclude-paths:\s*\n\s*-\s*"apps\/cms\/\*\*"/);
  });

  test("the bun update block ignores the bun dependency itself", () => {
    const bunBlock = blocks.find((b) => /package-ecosystem:\s*"bun"/.test(b));
    const ignoreSection = bunBlock.slice(bunBlock.indexOf("ignore:"));
    assert.match(
      ignoreSection,
      /-\s*dependency-name:\s*"bun"/,
      "bun's own version is pinned in three places that move together by hand (AGENTS.md) — a version-update PR must not touch it"
    );
  });

  test("both blocks group minor/patch updates and leave majors ungrouped", () => {
    for (const block of blocks) {
      assert.match(block, /groups:/);
      assert.match(block, /update-types:\s*\n\s*-\s*"minor"\s*\n\s*-\s*"patch"/);
    }
  });

  test("both blocks run monthly", () => {
    for (const block of blocks) {
      assert.match(block, /interval:\s*"monthly"/);
    }
  });

  test("both blocks set a bounded open-pull-requests-limit", () => {
    for (const block of blocks) {
      const match = block.match(/open-pull-requests-limit:\s*(\d+)/);
      assert.ok(match, "missing open-pull-requests-limit");
      const limit = Number(match[1]);
      assert.ok(limit > 0 && limit <= 20, `open-pull-requests-limit (${limit}) should be a sane, bounded value`);
    }
  });
});
