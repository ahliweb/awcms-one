/**
 * run.mjs — `bun run template:init`'s orchestration: parse, validate,
 * prompt, guard, plan, and (unless `--dry-run`) apply plus run the
 * trailing gates. `tools/template-init.ts` is the thin entry point that
 * calls {@link main}; every exit code below matches
 * `docs/template.md`'s own table.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitRun } from "../../packages/gerbang/lib/git.mjs";
import { applyColorDefaults, missingRequired, parseArgs, USAGE, validateFlags } from "./cli.mjs";
import { promptForMissing } from "./cli.mjs";
import { buildPlan, describePlan, isEmptyPlan } from "./plan.mjs";
import { applyPlan } from "./apply.mjs";
import { runFollowUpGates } from "./gates.mjs";

/**
 * @param {string[]} argv
 * @param {object} [opts]
 * @param {string} [opts.root] - defaults to the repo root (two levels up from this file)
 * @param {boolean} [opts.isTTY] - defaults to `process.stdin.isTTY`
 * @param {boolean} [opts.skipGates] - for tests: build + apply the plan, but never spawn `bun run <gate>`
 * @param {boolean} [opts.skipInstall] - forwarded to {@link runFollowUpGates} — see that function's own docblock
 * @returns {Promise<number>} the process exit code — never calls `process.exit` itself, so tests can assert on the return value
 */
export async function main(argv, opts = {}) {
  const root = opts.root ?? join(import.meta.dirname, "..", "..");
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);

  let flags;
  try {
    flags = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(`\n${USAGE}`);
    return 2;
  }

  if (flags.help) {
    console.log(USAGE);
    return 0;
  }

  const missing = missingRequired(flags);
  if (missing.length > 0) {
    if (isTTY && !flags.dryRun) {
      flags = await promptForMissing(flags);
    } else {
      console.error(`Missing required flag(s): ${missing.join(", ")}`);
      console.error(`\n${USAGE}`);
      return 2;
    }
  }

  flags = applyColorDefaults(flags);

  const problems = validateFlags(flags);
  if (problems.length > 0) {
    for (const p of problems) console.error(`- ${p}`);
    return 2;
  }

  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

  if (pkg.name === "awcms-one" && !flags.yes && !flags.dryRun) {
    console.error(
      "REFUSING: this looks like the upstream awcms-one template itself " +
        `(package.json name is "awcms-one"), not a derived repository. ` +
        "Running template:init here would rewrite the template's OWN brand " +
        "surface. Pass --yes if this is genuinely intended."
    );
    return 3;
  }

  if (!flags.dryRun) {
    const status = gitRun(root, "status", "--porcelain");
    const dirty = status !== null && status.trim() !== "";
    if (dirty && !flags.yes) {
      console.error(
        "REFUSING: the working tree is dirty. Commit or stash first, or pass " +
          "--yes to proceed anyway (docs/template.md's exit-code table)."
      );
      return 3;
    }
  }

  const today = new Date().toLocaleDateString("sv-SE");
  const originSha = gitRun(root, "rev-parse", "HEAD")?.trim() ?? "unknown";

  let plan;
  try {
    plan = buildPlan({ root, flags, today, originSha });
  } catch (error) {
    console.error(`template:init: ${error.message}`);
    return 1;
  }

  if (flags.dryRun) {
    console.log(describePlan(plan));
    return 0;
  }

  if (isEmptyPlan(plan)) {
    console.log("template:init — nothing to do.");
    return 0;
  }

  console.log(describePlan(plan));
  console.log("");

  try {
    applyPlan(plan, root);
  } catch (error) {
    console.error(`template:init: failed while applying the plan: ${error.message}`);
    return 1;
  }

  if (opts.skipGates) return 0;

  try {
    runFollowUpGates(root, { skipInstall: opts.skipInstall });
  } catch (error) {
    console.error(`template:init: ${error.message}`);
    return 1;
  }

  console.log("\ntemplate:init — done. This repository's first commit is green.");
  return 0;
}
