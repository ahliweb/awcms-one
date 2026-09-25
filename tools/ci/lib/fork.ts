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

export interface PullRequestInfo {
  number: number;
  headSha: string;
  headRepoFullName: string;
  baseRepoFullName: string;
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

/**
 * Fetch a PR's head SHA and fork status via `gh pr view`. Isolated behind
 * this function so `enforceForkPolicyOrThrow`'s policy above stays pure and
 * unit-testable with no network call.
 *
 * @param {number} prNumber
 * @param {string} repoRoot
 * @returns {Promise<PullRequestInfo>}
 */
export async function fetchPullRequestInfo(prNumber: number, repoRoot: string): Promise<PullRequestInfo> {
  const proc = Bun.spawn(
    [
      "gh",
      "pr",
      "view",
      String(prNumber),
      "--json",
      "number,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,baseRepository"
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(`gh pr view ${prNumber} failed: ${stderr.trim()}`);
  }
  const parsed = JSON.parse(stdout);
  const headOwner = parsed.headRepositoryOwner?.login ?? "";
  const headRepoName = parsed.headRepository?.name ?? "";
  return {
    number: parsed.number,
    headSha: parsed.headRefOid,
    headRepoFullName: `${headOwner}/${headRepoName}`,
    baseRepoFullName: `${parsed.baseRepository?.owner?.login ?? ""}/${parsed.baseRepository?.name ?? ""}`,
    isCrossRepository: Boolean(parsed.isCrossRepository)
  };
}
