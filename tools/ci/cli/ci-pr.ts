#!/usr/bin/env bun
/**
 * `bun run ci:pr -- <number>` — fetch `refs/pull/<n>/head`, resolve its
 * exact head SHA, run local CI's legs against it in a disposable worktree,
 * and post `local-ci/*` statuses to that SHA.
 *
 * Refuses a fork PR unless `--allow-fork` (see `lib/fork.ts`'s own
 * docblock for the risk this guards). Re-checks the PR's head SHA right
 * before posting final results; if it moved during the run, nothing is
 * posted for the now-stale commit.
 *
 * Flags: --leg <name> (repeatable), --keep, --allow-fork.
 */
import { randomBytes } from "node:crypto";
import { gitRunOrThrow } from "../../../packages/gerbang/lib/git.mjs";
import { enforceForkPolicyOrThrow, fetchPullRequestInfo } from "../lib/fork.ts";
import { resolveRepo, resolveToken } from "../lib/github.ts";
import { orchestrate } from "../lib/orchestrate.ts";
import { assertHeadUnchanged } from "../lib/statuses.ts";

function parseArgs(argv: string[]) {
  const legs: string[] = [];
  let keep = false;
  let allowFork = false;
  let prNumber: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--leg") legs.push(argv[++i]);
    else if (argv[i] === "--keep") keep = true;
    else if (argv[i] === "--allow-fork") allowFork = true;
    else if (/^\d+$/.test(argv[i])) prNumber = Number.parseInt(argv[i], 10);
  }
  if (prNumber === undefined) throw new Error("Usage: bun run ci:pr -- <pr-number> [--leg <name>] [--keep] [--allow-fork]");
  return { legs, keep, allowFork, prNumber };
}

async function main() {
  const repoRoot = process.cwd();
  const { legs, keep, allowFork, prNumber } = parseArgs(process.argv.slice(2));

  const pr = await fetchPullRequestInfo(prNumber, repoRoot);
  enforceForkPolicyOrThrow(pr, allowFork);

  gitRunOrThrow(repoRoot, "fetch", "origin", `refs/pull/${prNumber}/head`);
  const fetchedSha = gitRunOrThrow(repoRoot, "rev-parse", "FETCH_HEAD").trim();
  if (fetchedSha !== pr.headSha) {
    console.warn(`local-ci: fetched SHA ${fetchedSha} differs from gh's reported head ${pr.headSha} — using the freshly fetched one.`);
  }
  const sha = fetchedSha;
  const runId = `pr${prNumber}-${sha.slice(0, 12)}-${randomBytes(3).toString("hex")}`;
  const repo = resolveRepo(repoRoot);
  const token = resolveToken();

  console.log(`local-ci: PR #${prNumber} (${pr.headRepoFullName}) at ${sha}`);

  const { outcomes, worktreePaths, cleanup } = await orchestrate(repoRoot, sha, {
    legContexts: legs.length > 0 ? legs : undefined,
    keep,
    report: { repo, sha, token },
    runId
  });

  try {
    // Re-check before posting FINAL results — a pending status was already
    // posted per-leg by orchestrate() as each leg started; this guards only
    // the final success/failure state, which is the one a branch-protection
    // decision actually reads.
    const freshPr = await fetchPullRequestInfo(prNumber, repoRoot);
    assertHeadUnchanged(sha, freshPr.headSha, prNumber);

    let failed = false;
    for (const outcome of outcomes) {
      const status = outcome.ok ? "PASS" : "FAIL";
      console.log(`  [${status}] ${outcome.context} (${(outcome.durationMs / 1000).toFixed(1)}s) — ${outcome.summary}`);
      if (!outcome.ok) failed = true;
    }
    if (keep) {
      for (const [context, path] of Object.entries(worktreePaths)) {
        console.log(`local-ci: ${context} worktree kept at ${path}`);
      }
    }
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    // The head moved — the per-leg statuses already posted above are now
    // stale too, but re-posting "pending forever" statuses for an
    // abandoned SHA is not this tool's job; a fresh `ci:pr` run against the
    // new head does that naturally. Surface the reason and stop.
    console.error(`local-ci: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(`local-ci: ${(error as Error).message}`);
  process.exitCode = 1;
});
