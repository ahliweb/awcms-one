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
  rewriteBunLock,
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
  BJEKMART_SEED_ASSET_FILES,
  OLD_LAYOUT_SEED_DATA_FILES
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
    { path: "bun.lock", transform: (c) => rewriteBunLock(c, flags) },
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
    ...OLD_LAYOUT_SEED_DATA_FILES.map((path) => ({ path, kind: "file" })),
    ...BJEKMART_SEED_ASSET_FILES.map((path) => ({ path, kind: "file" }))
  ];
  const removals = removalCandidates.map(({ path, kind }) => {
    const full = join(root, path);
    const existed = kind === "dir" ? isDir(full) : existsSync(full);
    return { path, kind, existed };
  });

  // `import:seputarborneo` is orphaned the moment its own script is
  // removed — checked against what IS on disk today, not against this
  // plan's own removals, so this stays correct even if called twice.
  const importerOnDisk = existsSync(join(root, "tools/import-seputarborneo.ts"));
  const scriptsToRemove = importerOnDisk ? ["import:seputarborneo"] : [];

  // `tools/seed-cms.ts` (issue #139) exists in every tree this version of
  // `template:init` runs against — its own `--profil` default is rewritten
  // separately, below, as a REWRITE target, not a removal.
  const seedCmsPath = "tools/seed-cms.ts";
  const seedCmsOnDisk = existsSync(join(root, seedCmsPath));
  if (seedCmsOnDisk) {
    const before = readFileIfPresent(join(root, seedCmsPath));
    const seedCmsDefaultRe = /(let profil = )"[\w:-]+"(;)/;
    if (!seedCmsDefaultRe.test(before)) {
      throw new Error(`${seedCmsPath}: expected default --profil assignment not found`);
    }
    const after = before.replace(seedCmsDefaultRe, `$1${JSON.stringify(flags.profil)}$2`);
    rewrites.push({ path: seedCmsPath, before, after, changed: after !== before });
  }

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
  // `db:seed:cms` (issue #139's `tools/seed-cms.ts`) defaults to
  // `contoh:borneojek-mart` — the reference example, correct for THIS
  // repo's own live deployment, wrong for a derived one that just removed
  // that content. Rewritten to seed the deployment's OWN chosen profile by
  // default, matched by the seeder's own flag SHAPE (`--profil <anything>`)
  // rather than the literal current value, so a later run with a different
  // `--profil` still finds and replaces it (see `text.mjs`'s
  // `replaceBetweenAnchors` docblock for why that distinction matters).
  if (nextPkg.scripts && typeof nextPkg.scripts["db:seed:cms"] === "string") {
    const seedScriptRe = /^bun tools\/seed-cms\.ts(?: --profil [\S]+)?$/;
    if (seedScriptRe.test(nextPkg.scripts["db:seed:cms"])) {
      nextPkg.scripts["db:seed:cms"] = `bun tools/seed-cms.ts --profil ${flags.profil}`;
    }
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
