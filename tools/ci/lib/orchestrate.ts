/**
 * orchestrate.ts — running a set of legs, each inside its OWN disposable
 * worktree, and (optionally) reporting their outcomes as commit statuses.
 *
 * Shared by `bun run ci` and `bun run ci:pr` so the two entrypoints differ
 * only in how they resolve the SHA to run, not in how legs are executed or
 * reported.
 *
 * ## Why every leg gets its own worktree, not one shared for the whole run
 *
 * A first end-to-end run against all twelve legs shared a single worktree
 * across every leg, in table order. It looked fine for the four `check-*`
 * legs (which only install and build), then `local-ci/template-root` ran
 * `bun run template:init` for real — which REWRITES `package.json`, removes
 * seed fixtures, and rebrands the tree in place, by design (AGENTS.md's
 * "Build profiles and the template mechanism"). Every leg that ran
 * afterwards in that same worktree — `e2e-toko`, `security` — then executed
 * against an already-template-initialized, no-longer-representative copy
 * of the repository: `e2e-toko` failed outright, and `security`'s CodeQL
 * scan picked up stray `dist/` build output several EARLIER legs had left
 * behind in the same tree. One worktree per leg is the fix: `git worktree
 * add` is cheap (it shares this repo's own object store), so paying that
 * cost twelve times instead of once is a rounding error next to what a
 * single leg itself costs, and it is what actually keeps ADR-0021's "never
 * mutate the developer's own checkout" promise from leaking sideways
 * between legs that mutate their OWN copy on purpose.
 */
import { mkdirSync } from "node:fs";
import { LEGS, type LegDefinition } from "../legs.ts";
import { enforceBunPinOrThrow } from "./bun-pin.ts";
import type { RepoRef } from "./github.ts";
import { runLeg } from "../runners/index.ts";
import { postStatus } from "./statuses.ts";
import { evidenceDir } from "./state-dir.ts";
import type { LegOutcome } from "./types.ts";
import { createDisposableWorktree, type DisposableWorktree } from "./worktree.ts";

export interface OrchestrateOptions {
  /** Which legs to run — defaults to all twelve. */
  legContexts?: string[];
  /** Skip cleanup of every leg's disposable worktree. */
  keep?: boolean;
  /** Post `local-ci/*` commit statuses for each leg. */
  report?: {
    repo: RepoRef;
    sha: string;
    token: string;
  };
  /** A label distinguishing this run's worktree/evidence directories from another concurrent one. */
  runId: string;
  concurrency?: number;
}

export interface OrchestrateResult {
  outcomes: LegOutcome[];
  /** Every leg's own worktree path, keyed by its context — there is no longer a single shared path. */
  worktreePaths: Record<string, string>;
  cleanup: () => void;
}

function selectLegs(contexts?: string[]): LegDefinition[] {
  if (!contexts || contexts.length === 0) return [...LEGS];
  const selected = contexts.map((context) => {
    const leg = LEGS.find((l) => l.context === context);
    if (!leg) throw new Error(`Unknown leg context: ${context}. Known: ${LEGS.map((l) => l.context).join(", ")}`);
    return leg;
  });
  return selected;
}

/**
 * Run `options.legContexts` (or all legs) against `sha`, each in its own
 * fresh disposable worktree of `repoRoot`. Enforces the Bun pin before doing
 * anything else — a leg run under the wrong Bun is worse than useless, it
 * is misleading.
 */
export async function orchestrate(
  repoRoot: string,
  sha: string,
  options: OrchestrateOptions
): Promise<OrchestrateResult> {
  const packageJsonText = await Bun.file(`${repoRoot}/package.json`).text();
  enforceBunPinOrThrow(packageJsonText);

  // GitHub Actions set CI=true for every step, and both Playwright configs
  // key their CI behaviour off it: `forbidOnly` (a stray `test.only` fails
  // the run instead of silently skipping the rest of the suite), one retry
  // for a flaky browser-protocol error, and the HTML report the e2e leg
  // copies into its evidence. Every leg's child process inherits
  // process.env, so setting it once here restores exactly what the removed
  // workflows ran with.
  process.env.CI = "true";

  const legs = selectLegs(options.legContexts);

  if (options.report) {
    for (const leg of legs) {
      await postStatus({
        repo: options.report.repo,
        sha: options.report.sha,
        token: options.report.token,
        context: leg.context,
        state: "pending",
        description: "Running via local CI"
      });
    }
  }

  const outcomes: LegOutcome[] = [];
  const worktreePaths: Record<string, string> = {};
  const worktrees: DisposableWorktree[] = [];
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const queue = [...legs];

  async function worker() {
    while (queue.length > 0) {
      const leg = queue.shift();
      if (!leg) return;
      const legLabel = `${options.runId}-${leg.context.replace(/\//g, "_")}`;
      const legEvidenceDir = evidenceDir(legLabel);
      mkdirSync(legEvidenceDir, { recursive: true });

      const worktree = createDisposableWorktree(repoRoot, sha, { keep: options.keep, label: legLabel });
      worktrees.push(worktree);
      worktreePaths[leg.context] = worktree.path;

      let outcome: LegOutcome;
      try {
        outcome = await runLeg(leg, { worktreeRoot: worktree.path, evidenceDir: legEvidenceDir });
      } catch (error) {
        outcome = {
          context: leg.context,
          ok: false,
          summary: `runner threw: ${(error as Error).message}`.slice(0, 140),
          durationMs: 0,
          evidenceDir: legEvidenceDir
        };
      }
      outcomes.push(outcome);

      if (!options.keep) worktree.cleanup();

      if (options.report) {
        await postStatus({
          repo: options.report.repo,
          sha: options.report.sha,
          token: options.report.token,
          context: leg.context,
          state: outcome.ok ? "success" : "failure",
          description: outcome.summary
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    outcomes,
    worktreePaths,
    cleanup: () => {
      for (const worktree of worktrees) worktree.cleanup();
    }
  };
}
