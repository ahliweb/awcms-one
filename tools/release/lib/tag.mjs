/**
 * tag.mjs — pure tag/version logic shared by `bun run release:images` and
 * `bun run release:publish`.
 *
 * Kept dependency-free and side-effect-free (no git, no filesystem, no
 * network) so `tests/release-images.test.mjs` and
 * `tests/release-publish.test.mjs` can assert on it directly — the same
 * discipline `packages/gerbang/lib/semver.mjs` already uses for
 * `tools/rilis.mjs`. This module is deliberately a SEPARATE one: it encodes
 * this tool's own tag/image-tag shape (three tags per image, `sha-<7>`,
 * `X.Y`), which is not `packages/gerbang/lib/semver.mjs`'s concern.
 */

/** The one tag shape this repo's releases use — see `packages/gerbang/lib/semver.mjs`. */
export const TAG_REGEX = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * @param {string} tag
 * @returns {boolean}
 */
export function isValidTag(tag) {
  return typeof tag === "string" && TAG_REGEX.test(tag);
}

/**
 * @param {string} tag - `vX.Y.Z`
 * @returns {{ major: number, minor: number, patch: number, version: string }}
 * @throws {Error} when `tag` does not match {@link TAG_REGEX}
 */
export function parseTag(tag) {
  const match = TAG_REGEX.exec(tag);
  if (!match) {
    throw new Error(`"${tag}" does not match ^v<major>.<minor>.<patch>$`);
  }
  const [, major, minor, patch] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    version: `${major}.${minor}.${patch}`
  };
}

/**
 * The image reference tags a published image carries — same policy
 * `docker/metadata-action` applied in `.github/workflows/images.yml`:
 * the full semver, its `major.minor`, and a short commit tag.
 *
 * @param {string} tag - `vX.Y.Z`
 * @param {string} sha - a full or short commit SHA; only its first 7 chars are used
 * @returns {string[]} `["X.Y.Z", "X.Y", "sha-<7>"]`
 */
export function deriveImageTags(tag, sha) {
  const { major, minor, version } = parseTag(tag);
  if (!sha || sha.length < 7) {
    throw new Error(`sha must be at least 7 characters, got "${sha}"`);
  }
  return [version, `${major}.${minor}`, `sha-${sha.slice(0, 7)}`];
}

/**
 * Version-sorts a list of tags (descending) and returns the highest one that
 * matches {@link TAG_REGEX}, ignoring everything else — including any tag
 * that slipped in from outside this repo's own namespace (see AGENTS.md's
 * "Why `--no-tags` is not optional": a fetch of the `awcms` upstream remote
 * without `tagOpt: --no-tags` imports THAT repo's own `v*` release tags into
 * this clone's `git tag` output).
 *
 * This function does not know which tags are reachable from `origin/main` —
 * that requires git and is the caller's job (see `tools/release/publish.ts`'s
 * `--latest` computation, which combines this with an ancestry check before
 * trusting the result).
 *
 * @param {string[]} tags
 * @returns {string | null}
 */
export function highestTag(tags) {
  const parsed = tags
    .filter(isValidTag)
    .map((tag) => ({ tag, ...parseTag(tag) }));
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch);
  return parsed[0].tag;
}

/**
 * Lower-cases an owner/repo pair for a GHCR path — GHCR image paths must be
 * all lower-case, and a repository name (or a template-derived repository's
 * own rename) is not guaranteed to already be one.
 *
 * @param {{ owner: string, repo: string }} ownerRepo
 * @returns {{ owner: string, repo: string }}
 */
export function lowerCaseOwnerRepo({ owner, repo }) {
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

/**
 * Parses an `owner/repo` pair out of a git remote URL — `git@github.com:` and
 * `https://github.com/` forms, with or without a trailing `.git`.
 *
 * @param {string} remoteUrl
 * @returns {{ owner: string, repo: string }}
 * @throws {Error} when the URL does not carry a recognisable `owner/repo`
 */
export function parseGitHubRemote(remoteUrl) {
  const cleaned = remoteUrl.trim().replace(/\.git$/, "");
  const match = /(?:github\.com[:/])([^/]+)\/([^/]+)$/.exec(cleaned);
  if (!match) {
    throw new Error(`Could not parse an owner/repo out of remote URL "${remoteUrl}".`);
  }
  const [, owner, repo] = match;
  return { owner, repo };
}

/**
 * Whether a tag's own `package.json` (as read from that commit, by the
 * caller — this function is pure) actually belongs to THIS repository's
 * release lineage, rather than an upstream tag that leaked into `git tag`
 * (AGENTS.md's "Why `--no-tags` is not optional").
 *
 * Ancestry of `origin/main` alone cannot tell these apart: `apps/cms` is
 * `ahliweb/awcms` embedded via `git subtree` with FULL history, so an
 * upstream release tag's commit genuinely IS an ancestor of this
 * repository's own `origin/main` once a subtree sync has landed (verified
 * directly against this repository's own clone — `git merge-base
 * --is-ancestor v10.3.0 origin/main` answers true, and `v10.3.0` is
 * `ahliweb/awcms`'s own release, not this repository's). What DOES differ is
 * the package identity: this repository's own release tags are only ever
 * created by `tools/rilis.mjs`, which bumps root `package.json`'s `name`
 * (this repo's own) and `version` (matching the tag) together, in the same
 * commit — an upstream tag's commit has root `package.json` read as THAT
 * repo's own package instead.
 *
 * @param {{ name?: unknown, version?: unknown } | null} pkg - parsed
 *   `package.json` from the candidate tag's commit, or `null` if it could
 *   not be read there at all
 * @param {string} tag - `vX.Y.Z`
 * @param {string} ownPackageName - this checkout's OWN `package.json` name,
 *   never a hard-coded string (a template-derived repository may rename its
 *   own root package — AGENTS.md's `template:init`)
 * @returns {boolean}
 */
export function matchesOwnRelease(pkg, tag, ownPackageName) {
  if (!pkg || typeof pkg !== "object") return false;
  if (pkg.name !== ownPackageName) return false;
  try {
    return pkg.version === parseTag(tag).version;
  } catch {
    return false;
  }
}

/**
 * The full GHCR image reference for one target, before any tag is appended.
 *
 * @param {object} opts
 * @param {string} opts.registry - e.g. `ghcr.io`
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.suffix - `cms` or `cms-jobs`
 * @returns {string}
 */
export function imageRepository({ registry, owner, repo, suffix }) {
  const lower = lowerCaseOwnerRepo({ owner, repo });
  return `${registry}/${lower.owner}/${lower.repo}-${suffix}`;
}
