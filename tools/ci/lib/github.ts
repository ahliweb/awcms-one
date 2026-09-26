/**
 * github.ts — resolving which GitHub repository local CI talks to, and with
 * what credential, without ever printing the credential.
 *
 * Both are overridable, because this tool ships inside a GitHub template
 * repository (AGENTS.md's "Build profiles and the template mechanism") — a
 * derived repository's `origin` remote names a different owner/repo, and
 * `template:init` never touches this directory, so nothing here may assume
 * `ahliweb/awcms-one` specifically.
 */
import { gitRun } from "../../../packages/gerbang/lib/git.mjs";

export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * Parse `owner/repo` out of a git remote URL, HTTPS or SSH.
 *
 * @param {string} url
 * @returns {RepoRef | null}
 */
export function parseGitHubRemoteUrl(url: string): RepoRef | null {
  const patterns = [
    /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url.trim());
    if (match) return { owner: match[1], repo: match[2] };
  }
  return null;
}

/**
 * Resolve the (owner, repo) local CI reports statuses against.
 *
 * Overridable via `LOCAL_CI_GITHUB_OWNER` / `LOCAL_CI_GITHUB_REPO` — for a
 * checkout whose `origin` does not point at GitHub at all, or a derived
 * repository whose remote name differs. Otherwise derived from the `origin`
 * remote of `repoRoot`, per AGENTS.md's requirement that this never be
 * assumed hardcoded.
 *
 * @param {string} repoRoot
 * @param {Record<string, string | undefined>} env
 * @returns {RepoRef}
 * @throws {Error} when neither the env override nor `origin` resolves
 */
export function resolveRepo(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env
): RepoRef {
  if (env.LOCAL_CI_GITHUB_OWNER && env.LOCAL_CI_GITHUB_REPO) {
    return { owner: env.LOCAL_CI_GITHUB_OWNER, repo: env.LOCAL_CI_GITHUB_REPO };
  }
  const remoteUrl = gitRun(repoRoot, "remote", "get-url", "origin");
  if (!remoteUrl) {
    throw new Error(
      "Could not read the `origin` remote to resolve owner/repo. Set " +
        "LOCAL_CI_GITHUB_OWNER and LOCAL_CI_GITHUB_REPO instead."
    );
  }
  const parsed = parseGitHubRemoteUrl(remoteUrl);
  if (!parsed) {
    throw new Error(
      `origin (${remoteUrl.trim()}) is not a github.com remote. Set ` +
        "LOCAL_CI_GITHUB_OWNER and LOCAL_CI_GITHUB_REPO instead."
    );
  }
  return parsed;
}

/**
 * Resolve the GitHub token local CI authenticates as, WITHOUT ever printing
 * it. `LOCAL_CI_GITHUB_TOKEN` first (a dedicated fine-grained token or
 * GitHub App installation token is the recommended credential — see
 * ADR-0021), falling back to `gh auth token` (the operator's own logged-in
 * `gh` session) so a first run needs no extra setup beyond `gh auth login`.
 *
 * @returns {string}
 * @throws {Error} when neither source has a token — the message never
 *   includes a token value, only the fact that none was found
 */
export function resolveToken(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.LOCAL_CI_GITHUB_TOKEN;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();

  const result = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode === 0) {
    const token = result.stdout.toString().trim();
    if (token !== "") return token;
  }
  throw new Error(
    "No GitHub token available: LOCAL_CI_GITHUB_TOKEN is unset and `gh auth token` " +
      "failed. Run `gh auth login`, or set LOCAL_CI_GITHUB_TOKEN to a token with " +
      "`statuses:write` (and `security-events:write` for --upload-sarif)."
  );
}
