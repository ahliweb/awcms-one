#!/usr/bin/env bun
/**
 * `bun run ci` — run local CI's legs against the current checkout's HEAD
 * commit, each leg inside its OWN disposable worktree of that exact SHA.
 * Never mutates the developer's own checkout (several legs, `template:init`
 * chief among them, mutate files in place — which is exactly why each leg
 * gets a worktree to itself; see `lib/orchestrate.ts`'s own header comment).
 *
 * Flags:
 *   --leg <name>       Run only this leg (repeatable). Defaults to all twelve.
 *   --report           Post `local-ci/*` commit statuses for HEAD's SHA.
 *   --keep             Do not remove any leg's disposable worktree afterwards.
 */
import { randomBytes } from "node:crypto";
import { gitRunOrThrow } from "../../../packages/gerbang/lib/git.mjs";
import { resolveRepo, resolveToken } from "../lib/github.ts";
import { orchestrate } from "../lib/orchestrate.ts";

function parseArgs(argv: string[]) {
  const legs: string[] = [];
  let report = false;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--leg") {
      legs.push(argv[++i]);
    } else if (argv[i] === "--report") {
      report = true;
    } else if (argv[i] === "--keep") {
      keep = true;
    }
  }
  return { legs, report, keep };
}

async function main() {
  const repoRoot = process.cwd();
  const { legs, report, keep } = parseArgs(process.argv.slice(2));
  const sha = gitRunOrThrow(repoRoot, "rev-parse", "HEAD").trim();
  const runId = `ci-${sha.slice(0, 12)}-${randomBytes(3).toString("hex")}`;

  console.log(`local-ci: running ${legs.length > 0 ? legs.join(", ") : "all 12 legs"} against ${sha}`);

  const reportOptions = report
    ? { repo: resolveRepo(repoRoot), sha, token: resolveToken() }
    : undefined;

  const { outcomes, worktreePaths, cleanup } = await orchestrate(repoRoot, sha, {
    legContexts: legs.length > 0 ? legs : undefined,
    keep,
    report: reportOptions,
    runId
  });

  try {
    let failed = false;
    for (const outcome of outcomes) {
      const status = outcome.ok ? "PASS" : "FAIL";
      const seconds = (outcome.durationMs / 1000).toFixed(1);
      console.log(`  [${status}] ${outcome.context} (${seconds}s) — ${outcome.summary}`);
      if (!outcome.ok) failed = true;
    }
    if (keep) {
      for (const [context, path] of Object.entries(worktreePaths)) {
        console.log(`local-ci: ${context} worktree kept at ${path}`);
      }
    }
    process.exitCode = failed ? 1 : 0;

  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(`local-ci: ${(error as Error).message}`);
  process.exitCode = 1;
});
