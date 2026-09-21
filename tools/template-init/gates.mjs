/**
 * gates.mjs — the "a derived repo's first commit is already green" tail of
 * `template:init` (ADR-0018 D5 / `docs/template.md`'s "After it runs"),
 * run in the exact documented order: `docs:i18n:stamp --force-restamp`,
 * `bun install`, `audit:dokumen`, `audit:translation`, `audit:rilis`,
 * `bun test`.
 *
 * `--force-restamp` is this tool's own flag on `docs:i18n:stamp`, not an
 * existing one on `tools/docs-i18n-stamp.mjs` — the underlying script is
 * already idempotent and unconditional (it always reads and rewrites every
 * mirror's banner/hash to the current source), so `--force-restamp` here is
 * accepted and simply forwarded as a no-op-if-absent CLI nicety for a
 * caller that wants to be explicit that this run intends a full restamp
 * after a brand-wide rewrite — see `docs/template.md`'s own note.
 */
import { spawnSync } from "node:child_process";

/**
 * @param {string} root
 * @param {string[]} args - argv for `bun`
 * @param {string} label
 * @returns {void}
 * @throws {Error} when the command exits non-zero
 */
function run(root, args, label) {
  const result = spawnSync("bun", args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? "signal " + result.signal})`);
  }
}

/**
 * The exact `bun test` argv for a given `testScope` — pulled out of
 * {@link runFollowUpGates} so `tests/gerbang-test-scope.test.mjs` can spawn
 * it directly against a purpose-built temp directory and assert what it
 * ACTUALLY scopes, rather than trusting the docblock below. See that
 * docblock for why `"root"` is `["test", "./tests/"]` and not
 * `["test", "tests"]`.
 * @param {"all" | "root"} scope
 * @returns {string[]}
 */
export function testScopeArgs(scope) {
  return scope === "root" ? ["test", "./tests/"] : ["test"];
}

/**
 * @param {string} root
 * @param {{ skipInstall?: boolean, testScope?: "all" | "root" }} [opts] -
 *   `testScope: "root"` runs only the root gate tests (`bun test ./tests/`),
 *   not the workspace suites with their stub-CMS builds — for a runner that
 *   already executes the full `bun test` itself (the `template-init-smoke`
 *   workflow's own next step, or `tests/template-init.test.mjs`'s outer
 *   suite), where a NESTED full run only doubles the load and trips the
 *   stub-start deadline. Also read from `TEMPLATE_INIT_TEST_SCOPE`. A real
 *   derived repository keeps the default `"all"`. `skipInstall`: for
 *   `tests/template-init.test.mjs`'s temp-copy runs, which SYMLINK
 *   `node_modules` in rather than reinstalling (this file's own docblock
 *   references the reasoning the test file states in full) — everything
 *   ELSE in this chain still runs for real.
 *
 *   **Why `./tests/`, not `tests` (issue #147's second finding).** A bare
 *   positional argument to `bun test` is a PATH **FILTER** — a substring
 *   match against every test file's path — not a directory restriction.
 *   `bun test tests` therefore matches `apps/storefront/tests/*.test.ts`
 *   too, because that path also CONTAINS the substring `tests`; it matches
 *   every test file in this repository, since every one lives under a
 *   directory literally named `tests`. The "root gate tests only" scope
 *   this option promises never actually scoped anything — a `testScope:
 *   "root"` run silently re-ran the WHOLE workspace suite, including every
 *   storefront build-smoke test and its own stub-CMS `astro build`, inside
 *   the SAME 90 s test budget the outer caller sized for "root gate tests
 *   only". That is exactly the double-build contention this option exists
 *   to remove, and whether the nested run finished before the outer test's
 *   own timeout was a race — reproduced directly: a temp directory holding
 *   only `tests/a.test.mjs` and `apps/x/tests/b.test.mjs`, `bun test tests`
 *   runs BOTH; `bun test ./tests/` runs only the root one (verified against
 *   bun 1.4.0 in CI and 1.4.2 locally; see `tests/gerbang-test-scope.test.mjs`
 *   for the same check kept as a permanent regression test). A path that
 *   starts with `./` or `/` is not treated as a filter — it is resolved as
 *   an actual directory, and `bun test` then collects test files under it
 *   the normal way.
 * @returns {void}
 */
export function runFollowUpGates(root, opts = {}) {
  run(root, ["run", "docs:i18n:stamp"], "docs:i18n:stamp");
  if (!opts.skipInstall) run(root, ["install"], "bun install");
  run(root, ["run", "audit:dokumen"], "audit:dokumen");
  run(root, ["run", "audit:translation"], "audit:translation");
  run(root, ["run", "audit:rilis"], "audit:rilis");
  const scope = opts.testScope ?? process.env.TEMPLATE_INIT_TEST_SCOPE ?? "all";
  const label = scope === "root" ? "bun test ./tests/ (root gate tests only)" : "bun test";
  run(root, testScopeArgs(scope), label);
}
