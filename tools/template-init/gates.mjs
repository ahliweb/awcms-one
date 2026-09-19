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
 * @param {string} root
 * @param {{ skipInstall?: boolean }} [opts] - `skipInstall`: for
 *   `tests/template-init.test.mjs`'s temp-copy runs, which SYMLINK
 *   `node_modules` in rather than reinstalling (this file's own docblock
 *   references the reasoning the test file states in full) — everything
 *   ELSE in this chain still runs for real.
 * @returns {void}
 */
export function runFollowUpGates(root, opts = {}) {
  run(root, ["run", "docs:i18n:stamp"], "docs:i18n:stamp");
  if (!opts.skipInstall) run(root, ["install"], "bun install");
  run(root, ["run", "audit:dokumen"], "audit:dokumen");
  run(root, ["run", "audit:translation"], "audit:translation");
  run(root, ["run", "audit:rilis"], "audit:rilis");
  run(root, ["test"], "bun test");
}
