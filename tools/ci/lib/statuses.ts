/**
 * statuses.ts — posting `local-ci/*` commit statuses to
 * `POST /repos/{owner}/{repo}/statuses/{sha}`, the exact-SHA reporting
 * ADR-0021 replaces required GitHub Actions checks with.
 *
 * The token never appears in a thrown error or a log line here — every
 * failure message below names the HTTP status and response body only.
 */
import type { RepoRef } from "./github.ts";

export type StatusState = "pending" | "success" | "failure" | "error";

export interface PostStatusParams {
  repo: RepoRef;
  sha: string;
  token: string;
  context: string;
  state: StatusState;
  description: string;
  targetUrl?: string;
}

/**
 * Post one commit status. Throws on a non-2xx response, naming the status
 * code and body — never the token, which is sent only in the `Authorization`
 * header and nowhere in the thrown message.
 */
export async function postStatus(params: PostStatusParams): Promise<void> {
  const { repo, sha, token, context, state, description, targetUrl } = params;
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/statuses/${sha}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      state,
      // A 140-char description is GitHub's own limit for this field.
      description: description.slice(0, 140),
      context,
      ...(targetUrl ? { target_url: targetUrl } : {})
    })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`POST statuses/${sha} (${context}) -> ${response.status}: ${body.slice(0, 500)}`);
  }
}

/**
 * Re-check that `sha` is still the PR's head before posting final results —
 * `bun run ci:pr`'s own "if the head moved, post nothing stale" rule. Throws
 * when it moved, naming both SHAs (never a token).
 */
export function assertHeadUnchanged(expectedSha: string, currentSha: string, prNumber: number): void {
  if (expectedSha !== currentSha) {
    throw new Error(
      `PR #${prNumber}'s head moved during the run (${expectedSha} -> ${currentSha}) — ` +
        "refusing to post results for a commit that is no longer the PR's head."
    );
  }
}
