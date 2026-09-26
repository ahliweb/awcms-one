#!/usr/bin/env bun
/**
 * `bun run ci:watch` — one polling pass: list open PRs, skip any whose
 * (repo, PR, head SHA, CI-definition version) already has a recorded
 * result, and run+report local CI for the rest. Meant to be invoked by the
 * systemd timer in `tools/ci/systemd/` every 10 minutes — see that
 * directory's own comment for installing it (not done automatically by
 * this tool).
 *
 * Holds the cross-run lock ({@link acquireLock}) for its entire pass so two
 * invocations never overlap. Retries an INFRASTRUCTURE error (a network
 * fetch that failed, a docker daemon that was briefly unreachable) once;
 * never retries a leg that ran to completion and failed — that failure is
 * deterministic until the PR's code changes.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gitRunOrThrow } from "../../../packages/gerbang/lib/git.mjs";
import { acquireLock } from "../lib/lock.ts";
import { ciDefinitionHash } from "../lib/hash.ts";
import { resolveRepo, resolveToken } from "../lib/github.ts";
import { orchestrate } from "../lib/orchestrate.ts";
import { lockFilePath, resultKey, resultsDir } from "../lib/state-dir.ts";
import { fetchPullRequestInfo } from "../lib/fork.ts";

interface OpenPr {
  number: number;
  headSha: string;
}

async function listOpenPrs(repoRoot: string): Promise<OpenPr[]> {
  const proc = Bun.spawn(["gh", "pr", "list", "--state", "open", "--json", "number,headRefOid", "--limit", "100"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) throw new Error(`gh pr list failed: ${stderr.trim()}`);
  const parsed = JSON.parse(stdout) as Array<{ number: number; headRefOid: string }>;
  return parsed.map((p) => ({ number: p.number, headSha: p.headRefOid }));
}

function hasRecordedResult(key: string): boolean {
  return existsSync(join(resultsDir(), `${key}.json`));
}

function recordResult(key: string, payload: unknown): void {
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.json`), JSON.stringify(payload, null, 2));
}

async function main() {
  const repoRoot = process.cwd();
  const lock = acquireLock(lockFilePath());

  try {
    const repo = resolveRepo(repoRoot);
    const ciVersion = ciDefinitionHash(repoRoot);
    const openPrs = await listOpenPrs(repoRoot);

    console.log(`ci:watch: ${openPrs.length} open PR(s), CI-definition ${ciVersion}`);

    for (const pr of openPrs) {
      const key = resultKey({ owner: repo.owner, repo: repo.repo, pr: pr.number, sha: pr.headSha, ciDefinitionVersion: ciVersion });
      if (hasRecordedResult(key)) {
        console.log(`ci:watch: PR #${pr.number} @ ${pr.headSha} already has a result for ${ciVersion} — skipping`);
        continue;
      }

      let info;
      try {
        info = await fetchPullRequestInfo(pr.number, repoRoot);
      } catch (error) {
        console.error(`ci:watch: could not fetch PR #${pr.number} info, retrying once: ${(error as Error).message}`);
        info = await fetchPullRequestInfo(pr.number, repoRoot);
      }

      if (info.isCrossRepository) {
        console.log(`ci:watch: PR #${pr.number} is from a fork (${info.headRepoFullName}) — skipping (run \`bun run ci:pr -- ${pr.number} --allow-fork\` by hand to override)`);
        continue;
      }

      // orchestrate() checks out `pr.headSha` into a disposable worktree,
      // which needs that commit object already fetched into this checkout —
      // not guaranteed for a PR branch this local clone has not seen before.
      gitRunOrThrow(repoRoot, "fetch", "origin", `refs/pull/${pr.number}/head`);

      const token = resolveToken();
      const runId = `watch-pr${pr.number}-${pr.headSha.slice(0, 12)}`;

      console.log(`ci:watch: running PR #${pr.number} @ ${pr.headSha}`);
      const { outcomes, cleanup } = await orchestrate(repoRoot, pr.headSha, {
        report: { repo, sha: pr.headSha, token },
        runId
      });
      cleanup();

      recordResult(key, {
        pr: pr.number,
        sha: pr.headSha,
        ciDefinitionVersion: ciVersion,
        recordedAt: new Date().toISOString(),
        outcomes: outcomes.map((o) => ({ context: o.context, ok: o.ok, summary: o.summary }))
      });
    }
  } finally {
    lock.release();
  }
}

main().catch((error) => {
  console.error(`ci:watch: ${(error as Error).message}`);
  process.exitCode = 1;
});
