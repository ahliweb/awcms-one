/**
 * apply.mjs — writes a plan built by `plan.mjs` to disk. `--dry-run` never
 * calls this; every other path does, after the dirty-tree/self/flag guards
 * in `run.mjs` have already passed.
 */
import { existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {ReturnType<typeof import("./plan.mjs").buildPlan>} plan
 * @param {string} root
 * @returns {void}
 */
export function applyPlan(plan, root) {
  for (const rewrite of plan.rewrites) {
    if (!rewrite.changed) continue;
    writeFileSync(join(root, rewrite.path), rewrite.after);
  }

  for (const removal of plan.removals) {
    if (!removal.existed) continue;
    const full = join(root, removal.path);
    if (removal.kind === "dir") {
      rmSync(full, { recursive: true, force: true });
    } else if (existsSync(full)) {
      unlinkSync(full);
    }
  }

  if (plan.changelog) {
    writeFileSync(join(root, "CHANGELOG.md"), plan.changelog.after);
  }

  for (const edit of plan.docCitationEdits) {
    writeFileSync(join(root, edit.path), edit.after);
  }

  for (const name of plan.changesetsToClear) {
    unlinkSync(join(root, ".changesets", name));
  }

  if (plan.packageJson.changed) {
    writeFileSync(join(root, "package.json"), plan.packageJson.after);
  }
}
