/**
 * plan.mjs — computes what `template:init` would do, without doing any of
 * it. Both `--dry-run` and a real run share this exact function: the plan
 * IS the dry-run output, and applying it is the only difference between the
 * two modes (`apply.mjs`).
 *
 * Idempotency (ADR-0018 D5) falls directly out of how a plan is built:
 *
 *   - **Flag-driven rewrites** (`rewriters.mjs`) are diffed against the
 *     file's CURRENT content. Same flags, same file already in that shape
 *     -> no diff -> not in the plan. Different flags -> a real diff -> in
 *     the plan, and only that file.
 *   - **Removals** are diffed against existence. Already removed -> not in
 *     the plan.
 *   - **The one-time resets** (`CHANGELOG.md`, `.changesets/*.md`,
 *     `package.json.version`) are gated on `pkg.awcmsOne.templateVersion`
 *     already being set — the signal that SOME prior run already did this
 *     exactly once. They are not re-diffed against content, because a
 *     derived repo's own CHANGELOG/changesets are meant to diverge from
 *     this reset immediately (the whole point of resetting them) and must
 *     never be forced back to it by a later `template:init` run.
 *
 * A plan with every field's `changed`/`existed`/`willRun` false is exactly
 * "nothing to do" (`run.mjs` reads `isEmpty(plan)` for this).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFileIfPresent } from "../../packages/gerbang/lib/files.mjs";
import { planDocCitationCleanup } from "./docs-cleanup.mjs";
import {
  rewriteComposeYaml,
  rewriteReadme,
  rewriteRootEnvExample,
  rewriteSecurity,
  rewriteSiteTs,
  rewriteStorefrontEnvExample,
  rewriteSupport
} from "./rewriters.mjs";
import {
  ALWAYS_REMOVE_DIRS,
  ALWAYS_REMOVE_FILES,
  NEW_LAYOUT_SEED_DIR,
  OLD_LAYOUT_SEED_ASSETS_DIR,
  OLD_LAYOUT_SEED_DATA_FILES,
  OLD_LAYOUT_SEED_SCRIPT
} from "./removals.mjs";

/**
 * Every REQUIRED text-based rewrite target. A missing file here is an
 * internal failure (exit 1, per `docs/template.md`'s exit-code table) — the
 * tool expected to rewrite it and it is not there.
 */
function requiredRewriteTargets(flags) {
  return [
    { path: "apps/storefront/src/config/site.ts", transform: (c) => rewriteSiteTs(c, flags) },
    { path: "compose.yaml", transform: (c) => rewriteComposeYaml(c, flags) },
    { path: ".env.example", transform: (c) => rewriteRootEnvExample(c, flags) },
    { path: "apps/storefront/.env.example", transform: (c) => rewriteStorefrontEnvExample(c, flags) },
    { path: "README.md", transform: (c) => rewriteReadme(c, flags, { lang: "en" }) },
    { path: "README.id.md", transform: (c) => rewriteReadme(c, flags, { lang: "id" }) },
    { path: "SUPPORT.md", transform: (c) => rewriteSupport(c, flags, { lang: "en" }) },
    { path: "SUPPORT.id.md", transform: (c) => rewriteSupport(c, flags, { lang: "id" }) },
    { path: "SECURITY.md", transform: (c) => rewriteSecurity(c, flags, { lang: "en" }) },
    { path: "SECURITY.id.md", transform: (c) => rewriteSecurity(c, flags, { lang: "id" }) }
  ];
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {object} args
 * @param {string} args.root
 * @param {import("./flags.mjs").TemplateFlags} args.flags
 * @param {string} args.today - `YYYY-MM-DD`, local date
 * @param {string} args.originSha - the commit `template:init` is running from
 * @returns {object} the plan
 */
export function buildPlan({ root, flags, today, originSha }) {
  const pkgPath = join(root, "package.json");
  const pkgRaw = readFileIfPresent(pkgPath);
  if (pkgRaw === null) throw new Error("package.json is missing — cannot plan a template:init run");
  const pkg = JSON.parse(pkgRaw);

  const selfGuardTriggered = pkg.name === "awcms-one";
  const alreadyInitialized = Boolean(pkg.awcmsOne && typeof pkg.awcmsOne.templateVersion === "string");

  // -- Rewrites ----------------------------------------------------------
  const rewrites = requiredRewriteTargets(flags).map(({ path, transform }) => {
    const before = readFileIfPresent(join(root, path));
    if (before === null) {
      throw new Error(`${path}: expected by template:init but not found in this tree`);
    }
    const after = transform(before);
    return { path, before, after, changed: after !== before };
  });

  // -- Removals ------------------------------------------------------------
  const removalCandidates = [
    ...ALWAYS_REMOVE_FILES.map((path) => ({ path, kind: "file" })),
    ...ALWAYS_REMOVE_DIRS.map((path) => ({ path, kind: "dir" })),
    { path: OLD_LAYOUT_SEED_SCRIPT, kind: "file" },
    ...OLD_LAYOUT_SEED_DATA_FILES.map((path) => ({ path, kind: "file" })),
    { path: OLD_LAYOUT_SEED_ASSETS_DIR, kind: "dir" },
    { path: NEW_LAYOUT_SEED_DIR, kind: "dir" }
  ];
  const removals = removalCandidates.map(({ path, kind }) => {
    const full = join(root, path);
    const existed = kind === "dir" ? isDir(full) : existsSync(full);
    return { path, kind, existed };
  });

  // package.json scripts orphaned by a removal (only once the removal has
  // actually happened somewhere — checked against what IS on disk today,
  // not against this plan's own removals, so this stays correct even if
  // called twice).
  const oldSeedScriptOnDisk = existsSync(join(root, OLD_LAYOUT_SEED_SCRIPT));
  const newSeedScriptOnDisk = existsSync(join(root, "tools/seed-cms.ts"));
  const importerOnDisk = existsSync(join(root, "tools/import-seputarborneo.ts"));
  const scriptsToRemove = [];
  if (oldSeedScriptOnDisk && !newSeedScriptOnDisk) scriptsToRemove.push("db:seed:cms");
  if (importerOnDisk) scriptsToRemove.push("import:seputarborneo");

  // -- package.json (name/description/homepage/repository + once-only reset) --
  const nextPkg = JSON.parse(JSON.stringify(pkg));
  nextPkg.name = flags.slug;
  nextPkg.description = `${flags.nama} — dibuat dari template awcms-one.`;
  nextPkg.homepage = `https://${flags.domain}`;
  if (nextPkg.repository && typeof nextPkg.repository === "object") {
    nextPkg.repository = {
      ...nextPkg.repository,
      // No `--org`/`--repo` flag names a derived repo's own GitHub location
      // (see docs/template.md) — GANTI-ORG is a loud, greppable placeholder
      // rather than a guess this tool has no way to validate.
      url: `git+https://github.com/GANTI-ORG/${flags.slug}.git`
    };
  }
  for (const name of scriptsToRemove) {
    if (nextPkg.scripts) delete nextPkg.scripts[name];
  }

  let changelog = null;
  let changesetsToClear = [];
  if (!alreadyInitialized) {
    nextPkg.version = "0.1.0";
    nextPkg.awcmsOne = {
      templateVersion: pkg.version,
      initializedAt: today
    };

    const changelogPath = join(root, "CHANGELOG.md");
    const changelogBefore = readFileIfPresent(changelogPath) ?? "";
    const marker = "\n## [";
    const preambleEnd = changelogBefore.indexOf(marker);
    const preamble = preambleEnd === -1 ? changelogBefore.trimEnd() : changelogBefore.slice(0, preambleEnd).trimEnd();
    const entry = `\n\n## [0.1.0] — ${today}\n\nDibuat dari template awcms-one v${pkg.version} (${originSha}).\n`;
    changelog = { before: changelogBefore, after: `${preamble}${entry}`, changed: true };

    const changesetsDir = join(root, ".changesets");
    if (isDir(changesetsDir)) {
      changesetsToClear = readdirSync(changesetsDir).filter((name) => !/^readme/i.test(name) && name.endsWith(".md"));
    }
  }

  const pkgAfterText = `${JSON.stringify(nextPkg, null, 2)}\n`;
  const packageJson = { before: pkgRaw, after: pkgAfterText, changed: pkgAfterText !== pkgRaw };

  // Only for paths this run is ACTUALLY about to remove — a citation of a
  // path that was already removed by a prior run has already been cleaned
  // up (or never existed to clean), so re-scanning the whole tree for it
  // every run would be wasted work with nothing left to find.
  const rewriteOverlay = new Map(rewrites.filter((r) => r.path.endsWith(".md")).map((r) => [r.path, r.after]));
  const docCitationEdits = planDocCitationCleanup(
    root,
    removals.filter((r) => r.existed).map((r) => r.path),
    rewriteOverlay
  );

  return {
    selfGuardTriggered,
    alreadyInitialized,
    rewrites,
    removals,
    scriptsToRemove,
    packageJson,
    changelog,
    changesetsToClear,
    docCitationEdits
  };
}

/**
 * @param {ReturnType<typeof buildPlan>} plan
 * @returns {boolean} true when applying `plan` would change nothing at all
 */
export function isEmptyPlan(plan) {
  return (
    plan.rewrites.every((r) => !r.changed) &&
    plan.removals.every((r) => !r.existed) &&
    !plan.packageJson.changed &&
    plan.changelog === null &&
    plan.changesetsToClear.length === 0 &&
    plan.docCitationEdits.length === 0
  );
}

/**
 * Human-readable plan, for `--dry-run` and for the log a real run prints
 * before applying.
 *
 * @param {ReturnType<typeof buildPlan>} plan
 * @returns {string}
 */
export function describePlan(plan) {
  const lines = [];
  const changedRewrites = plan.rewrites.filter((r) => r.changed);
  const existingRemovals = plan.removals.filter((r) => r.existed);

  if (
    changedRewrites.length === 0 &&
    existingRemovals.length === 0 &&
    !plan.packageJson.changed &&
    plan.changelog === null &&
    plan.changesetsToClear.length === 0 &&
    plan.docCitationEdits.length === 0
  ) {
    return "nothing to do — every rewrite target already matches these flags, and every removal target is already absent.";
  }

  lines.push("Rewrite:");
  lines.push(plan.packageJson.changed ? "  - package.json (name/description/homepage/repository)" : "  - package.json — unchanged");
  for (const r of changedRewrites) lines.push(`  - ${r.path}`);
  if (changedRewrites.length === 0) lines.push("  (no other file needs a rewrite)");

  lines.push("");
  lines.push("Remove:");
  if (existingRemovals.length === 0) {
    lines.push("  (nothing left to remove)");
  } else {
    for (const r of existingRemovals) lines.push(`  - ${r.path}${r.kind === "dir" ? "/" : ""}`);
  }
  if (plan.scriptsToRemove.length > 0) {
    lines.push(`  - package.json scripts: ${plan.scriptsToRemove.join(", ")}`);
  }
  if (plan.docCitationEdits.length > 0) {
    lines.push(
      `  - ${plan.docCitationEdits.length} markdown file(s) — un-backtick citation(s) of the removed path(s) above`
    );
  }

  lines.push("");
  lines.push("Reset (one-time):");
  if (plan.alreadyInitialized) {
    lines.push("  (already run once — CHANGELOG.md, .changesets/, and package.json's version are left as this repo's own history)");
  } else {
    lines.push("  - CHANGELOG.md -> single 0.1.0 entry");
    lines.push(`  - .changesets/*.md cleared (${plan.changesetsToClear.length} file(s), README kept)`);
    lines.push("  - package.json version -> 0.1.0, awcmsOne.templateVersion recorded");
  }

  return lines.join("\n");
}
