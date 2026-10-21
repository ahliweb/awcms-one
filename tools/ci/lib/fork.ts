/**
 * fork.ts — refusing to run untrusted fork PR code on a trusted host,
 * unless the operator explicitly overrides with `--allow-fork`.
 *
 * The risk this guards is exactly the one GitHub's own docs warn about for
 * self-hosted runners: a self-hosted (or here, locally-run) CI that
 * checks out and executes a PR's code gives that code a shell on a machine
 * this project's own maintainers control — a fork PR is, by definition,
 * code from someone who does not have write access to this repository.
 */

import { resolveRepo } from "./github.ts";

export interface PullRequestInfo {
  number: number;
  headSha: string;
  headRepoFullName: string;
  isCrossRepository: boolean;
}

/** Pure predicate: does this PR need `--allow-fork` to run? */
export function isFromFork(pr: Pick<PullRequestInfo, "isCrossRepository">): boolean {
  return pr.isCrossRepository;
}

/**
 * @throws {Error} when `pr` is from a fork and `allowFork` is not set
 */
export function enforceForkPolicyOrThrow(
  pr: Pick<PullRequestInfo, "isCrossRepository" | "headRepoFullName" | "number">,
  allowFork: boolean
): void {
  if (isFromFork(pr) && !allowFork) {
    throw new Error(
      `PR #${pr.number} is from a fork (${pr.headRepoFullName}) — refusing to run its code on ` +
        "this host. Review the diff yourself, then re-run with --allow-fork if you accept the risk."
    );
  }
}

/** The fields of a REST `GET /repos/{owner}/{repo}/pulls/{n}` response this module reads. */
export interface RestPullRequest {
  number: number;
  head: { sha: string; repo: { full_name: string } | null };
  base: { repo: { full_name: string } };
}

/**
 * Pure: map a REST pull-request object to {@link PullRequestInfo}.
 *
 * A PR is cross-repository when its head repository is not its base
 * repository. A head repository of `null` (the fork was deleted after the
 * PR was opened) is treated as a fork: its code is still not this
 * repository's, so the `--allow-fork` refusal must still apply.
 */
export function pullRequestInfoFromRest(pr: RestPullRequest): PullRequestInfo {
  const headRepoFullName = pr.head.repo?.full_name ?? "";
  return {
    number: pr.number,
    headSha: pr.head.sha,
    headRepoFullName,
    isCrossRepository: pr.head.repo === null || headRepoFullName.toLowerCase() !== pr.base.repo.full_name.toLowerCase()
  };
}

/**
 * Run `gh api <path>` from `repoRoot` and parse its JSON. REST only, never
 * GraphQL (`gh pr view`/`gh pr list` are GraphQL), so a token or a host that
 * allows the REST API alone is enough for local CI.
 */
export async function ghApiJson(path: string, repoRoot: string): Promise<unknown> {
  const proc = Bun.spawn(["gh", "api", path], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(`gh api ${path} failed: ${stderr.trim()}`);
  }
  return JSON.parse(stdout);
}

/**
 * Fetch a PR's head SHA and fork status via the REST API
 * (`gh api repos/{owner}/{repo}/pulls/{n}`). Isolated behind this function so
 * `enforceForkPolicyOrThrow`'s policy above stays pure and unit-testable with
 * no network call; the mapping itself is the pure
 * {@link pullRequestInfoFromRest}.
 *
 * @param {number} prNumber
 * @param {string} repoRoot
 * @returns {Promise<PullRequestInfo>}
 */
export async function fetchPullRequestInfo(prNumber: number, repoRoot: string): Promise<PullRequestInfo> {
  const { owner, repo } = resolveRepo(repoRoot);
  const parsed = (await ghApiJson(`repos/${owner}/${repo}/pulls/${prNumber}`, repoRoot)) as RestPullRequest;
  return pullRequestInfoFromRest(parsed);
}
