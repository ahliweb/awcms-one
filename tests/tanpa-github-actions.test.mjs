/**
 * The zero-GitHub-Actions gate (issue #225, ADR-0021): this repository's own
 * root `.github/workflows/` must never contain a workflow file again.
 *
 * ## Why this is a test, not just a paragraph in AGENTS.md
 *
 * `awcms-one` ran CI, template-init smoke, E2E, CodeQL, image
 * build/publish, and release publication through six root GitHub Actions
 * workflows. Issue #225 replaced every one of them with trusted local/
 * server infrastructure (`tools/ci/`, `tools/release/`, `tools/deploy/` —
 * see ADR-0021 for the architecture and ADR-0023 for the release-image
 * trust model) and deleted the workflow files themselves. Deleting the
 * files is not durable on its own: nothing stops a future change — an
 * agent copying a pattern from another repo, a contributor "just adding a
 * quick check" — from dropping a new `.yml` back under
 * `.github/workflows/` and having it silently start executing again,
 * exactly the outcome the owner's zero-Actions decision forbids. This test
 * is that stop: it runs on every `bun test`, so a reintroduced workflow
 * fails the very next local-CI or root-suite run, not just an audit
 * someone remembers to run by hand.
 *
 * This gate also SUBSUMES issue #224's workflow-guardrail requirement —
 * #224 asked for a check that production deployment could not silently
 * move back into GitHub Actions; #225 is broader (no Actions execution AT
 * ALL), and a check that the directory is empty is a strictly stronger
 * guarantee than a check that only one workflow's job stays absent.
 *
 * ## Why `apps/cms/.github/**` is explicitly out of scope
 *
 * `apps/cms` is `ahliweb/awcms` embedded whole via `git subtree`
 * (AGENTS.md's "The subtree embed") — its own `.github/workflows/**`, if
 * any exist there, are upstream's files, carried here as part of that
 * tree's full history, exactly like any other file under `apps/cms/`. They
 * are not root executable workflows for THIS repository: GitHub Actions
 * only ever reads workflow files from a repository's OWN root
 * `.github/workflows/` directory — a workflow file nested under
 * `apps/cms/.github/workflows/` is inert here; GitHub does not discover or
 * run it from that path. Editing those files locally would also violate
 * "The subtree embed"'s own rule (a local patch a future `git subtree
 * pull` would conflict with or silently overwrite) for no safety benefit,
 * since they cannot execute here in the first place. This test therefore
 * only ever looks at the repository ROOT's `.github/workflows/`.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");

const REINTRODUCTION_MESSAGE =
  "A file was found under root .github/workflows/ — GitHub Actions " +
  "workflows are not an accepted implementation path in this repository " +
  "(ADR-0021, issue #225: CI, security, release, and deploy all run on " +
  "trusted local/server infrastructure instead, see tools/ci/, tools/ " +
  "release/, and tools/deploy/). Reintroducing a root workflow requires, " +
  "in this order: a new ADR explaining why the zero-Actions decision is " +
  "being reversed or narrowed, the repository owner's explicit approval, " +
  "and an update to branch protection's required contexts (today the " +
  "twelve local-ci/* contexts `bun run ci:pr`/`ci:watch` post) — see " +
  "AGENTS.md's \"The gates\" and docs/alur-kerja-pengembangan.md.";

describe("zero GitHub Actions (issue #225, ADR-0021)", () => {
  test("root .github/workflows/ does not exist, or is empty", () => {
    if (!existsSync(WORKFLOWS_DIR)) return;

    const entries = readdirSync(WORKFLOWS_DIR);
    assert.deepEqual(entries, [], `${REINTRODUCTION_MESSAGE} Found: ${JSON.stringify(entries)}`);
  });

  test("no .yml/.yaml file exists anywhere under root .github/workflows/, including nested", () => {
    if (!existsSync(WORKFLOWS_DIR)) return;

    /** @type {string[]} */
    const found = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ya?ml)$/i.test(entry.name)) {
          found.push(full);
        }
      }
    };
    walk(WORKFLOWS_DIR);

    assert.deepEqual(found, [], `${REINTRODUCTION_MESSAGE} Found: ${JSON.stringify(found)}`);
  });

  test("this gate never looks at apps/cms/.github — that tree is upstream's own subtree and cannot execute here", () => {
    // Documented, not asserted against the filesystem: GitHub Actions only
    // discovers workflows under a repository's OWN root .github/workflows/,
    // so apps/cms/.github/** (ahliweb/awcms's own files, if any, carried by
    // the `git subtree` embed) is never in scope for this check and this
    // repo never edits it locally regardless (AGENTS.md's "The subtree
    // embed"). This test asserts the one thing that IS this repo's to
    // enforce: the WORKFLOWS_DIR constant above points at the repository
    // root, not anywhere under apps/cms/.
    assert.ok(
      !WORKFLOWS_DIR.includes(`${join("apps", "cms")}${sep}`),
      "WORKFLOWS_DIR must point at the repository root's .github/workflows/, never apps/cms's"
    );
  });
});
