/**
 * latest.mjs — pure `--latest` flag computation for `bun run release:publish`,
 * mirroring `.github/workflows/release.yml`'s own
 * `git tag --list 'v*' --sort=-v:refname | head -n1` logic exactly (see that
 * workflow's "Determine whether this tag is the highest release" step) —
 * this is the server-side replacement for it, so it must answer the same
 * question the same way.
 *
 * The ancestry guard AGENTS.md warns about (a `git tag` polluted by
 * upstream `awcms` release tags — "Why `--no-tags` is not optional") is
 * NOT pure: it requires asking git whether a commit is an ancestor of
 * `origin/main`. This module only computes the flag FROM an already-decided
 * "is the highest tag trustworthy" boolean, so the impure ancestry check in
 * `tools/release/publish.ts` stays the only place that decision is made.
 */
import { highestTag } from "./tag.mjs";

/**
 * @param {object} opts
 * @param {string} opts.tag - the tag being published, `vX.Y.Z`
 * @param {string[]} opts.allTags - every `v*` tag visible in this checkout
 * @param {boolean} opts.highestIsAncestorOfMain - whether the highest tag
 *   found among `allTags` is reachable from `origin/main`. When `false`,
 *   `allTags` is treated as untrustworthy (likely polluted by an upstream
 *   remote's own tags — AGENTS.md's warning) and this function refuses to
 *   answer rather than silently getting `--latest` wrong.
 * @returns {{ flag: "--latest" | "--latest=false", highest: string | null }}
 * @throws {Error} when `highestIsAncestorOfMain` is `false` and the computed
 *   highest tag is not `tag` itself (i.e. the untrustworthy tag would have
 *   changed the answer)
 */
export function computeLatestFlag({ tag, allTags, highestIsAncestorOfMain }) {
  const highest = highestTag(allTags);

  if (!highestIsAncestorOfMain && highest !== tag) {
    throw new Error(
      `Highest v* tag "${highest}" is not reachable from origin/main — refusing to compute ` +
        `--latest from a tag set that may be polluted by an upstream remote's own tags ` +
        `(AGENTS.md's "Why --no-tags is not optional"). Verify \`git tag -l\` names only this ` +
        `repo's own releases before retrying.`
    );
  }

  return { flag: tag === highest ? "--latest" : "--latest=false", highest };
}
