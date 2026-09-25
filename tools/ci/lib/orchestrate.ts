/**
 * orchestrate.ts — running a set of legs inside a disposable worktree and
 * (optionally) reporting their outcomes as commit statuses.
 *
 * Shared by `bun run ci` and `bun run ci:pr` so the two entrypoints differ
 * only in how they resolve the SHA to run, not in how legs are executed or
 * reported.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LEGS, type LegDefinition } from "../legs.ts";
import { enforceBunPinOrThrow } from "./bun-pin.ts";
import type { RepoRef } from "./github.ts";
import { runLeg } from "../runners/index.ts";
import { postStatus } from "./statuses.ts";
import { evidenceDir } from "./state-dir.ts";
import type { LegOutcome } from "./types.ts";
import { createDisposableWorktree } from "./worktree.ts";

export interface OrchestrateOptions {
  /** Which legs to run — defaults to all twelve. */
  legContexts?: string[];
  /** Skip cleanup of the disposable worktree. */
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
  worktreePath: string;
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
 * Run `options.legContexts` (or all legs) against `sha`, inside a fresh
 * disposable worktree of `repoRoot`. Enforces the Bun pin before doing
 * anything else — a leg run under the wrong Bun is worse than useless, it
 * is misleading.
 */
export async function orchestrate(
  repoRoot: string,
  sha: string,
  options: OrchestrateOptions
): Promise<OrchestrateResult> {
  const packageJsonText = await Bun.file(join(repoRoot, "package.json")).text();
  enforceBunPinOrThrow(packageJsonText);

  const legs = selectLegs(options.legContexts);
  const worktree = createDisposableWorktree(repoRoot, sha, { keep: options.keep, label: options.runId });

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
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const queue = [...legs];

  async function worker() {
    while (queue.length > 0) {
      const leg = queue.shift();
      if (!leg) return;
      const legEvidenceDir = evidenceDir(`${options.runId}-${leg.context.replace(/\//g, "_")}`);
      mkdirSync(legEvidenceDir, { recursive: true });

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

  return { outcomes, worktreePath: worktree.path, cleanup: worktree.cleanup };
}
