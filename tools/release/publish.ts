#!/usr/bin/env bun
/**
 * tools/release/publish.ts — replaces `.github/workflows/release.yml`.
 *
 * Validates a tag, extracts its `CHANGELOG.md` section via the existing
 * `tools/rilis-catatan.mjs` logic, computes whether it is the highest
 * release the same way the old workflow did, and creates or updates the
 * matching GitHub Release idempotently — optionally attaching the evidence
 * bundle `bun run release:images -- --publish` wrote.
 *
 * Usage:
 *   bun run release:publish -- v1.2.3
 *   bun run release:publish -- v1.2.3 --evidence /path/to/evidence-dir
 *
 * Token: RELEASE_GITHUB_TOKEN, falling back to `gh auth token` (the CLI's
 * own cached credential) when unset.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { changelogSection } from "../../packages/gerbang/lib/changelog.mjs";
import { readFileIfPresent } from "../../packages/gerbang/lib/files.mjs";
import { gitRun, gitRunInherit, gitRunOrThrow } from "../../packages/gerbang/lib/git.mjs";
import { computeLatestFlag } from "./lib/latest.mjs";
import { runCapture, runCaptureOrThrow, runInherit } from "./lib/proc.mjs";
import { isValidTag, matchesOwnRelease } from "./lib/tag.mjs";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

function fail(msg: string): never {
  console.error(`[release:publish] ERROR: ${msg}`);
  process.exit(1);
}

function log(msg: string) {
  console.log(`[release:publish] ${msg}`);
}

function parseArgs(argv: string[]) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const tag = positional[0];
  const evidenceIdx = argv.indexOf("--evidence");
  const evidenceDir = evidenceIdx !== -1 ? argv[evidenceIdx + 1] : undefined;
  return { tag, evidenceDir };
}

function resolveToken(): string {
  if (process.env.RELEASE_GITHUB_TOKEN) return process.env.RELEASE_GITHUB_TOKEN;
  const result = runCapture(["gh", "auth", "token"]);
  if (result.ok && result.stdout.trim()) return result.stdout.trim();
  fail("No token available: set RELEASE_GITHUB_TOKEN, or `gh auth login` first.");
}

async function main() {
  const { tag, evidenceDir } = parseArgs(process.argv.slice(2));

  if (!tag || !isValidTag(tag)) {
    fail(`Usage: bun run release:publish -- vX.Y.Z [--evidence <dir>]\nGot tag: "${tag}"`);
  }

  // -- Tag exists locally and on origin ----------------------------------------
  const localTagSha = gitRun(REPO_ROOT, "rev-list", "-n", "1", tag);
  if (!localTagSha) fail(`Tag ${tag} does not exist in this local checkout.`);

  gitRunInherit(REPO_ROOT, "fetch", "origin", "--tags", "--quiet");
  const remoteTags = runCaptureOrThrow(["git", "-C", REPO_ROOT, "ls-remote", "--tags", "origin", tag]);
  if (!remoteTags.trim()) fail(`Tag ${tag} exists locally but not on origin — push it first.`);

  // -- Tag commit is an ancestor of origin/main --------------------------------
  gitRunInherit(REPO_ROOT, "fetch", "origin", "main", "--quiet");
  const ancestry = runCapture(["git", "-C", REPO_ROOT, "merge-base", "--is-ancestor", tag, "origin/main"]);
  if (!ancestry.ok) fail(`${tag}'s commit is not an ancestor of origin/main — refusing to publish.`);

  // -- Extract release notes ----------------------------------------------------
  const changelogPath = join(REPO_ROOT, "CHANGELOG.md");
  const changelogText = readFileIfPresent(changelogPath);
  if (changelogText === null) fail(`${changelogPath} does not exist.`);
  let notes: string;
  try {
    notes = changelogSection(changelogText, tag);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // -- Compute --latest, guarding against a polluted tag namespace ------------
  //
  // Ancestry of origin/main is NOT enough on its own: `apps/cms` is
  // `ahliweb/awcms` embedded via `git subtree` with FULL history (AGENTS.md's
  // "The subtree embed"), so an upstream `awcms` release tag that leaked into
  // this clone's `git tag` (a fetch of that remote without `tagOpt: --no-tags`
  // — AGENTS.md's own "Why --no-tags is not optional") points at a commit
  // that genuinely IS an ancestor of this repo's own origin/main, once the
  // subtree merge has landed. Verified against this repository's own clone
  // while building this tool: `git merge-base --is-ancestor v10.3.0
  // origin/main` answers true here, even though v10.3.0 is `ahliweb/awcms`'s
  // own release, not this repository's.
  //
  // The signal that DOES distinguish them: this repository's own release
  // tags are only ever created by `tools/rilis.mjs`, which bumps ROOT
  // `package.json`'s own `version` to match in the same commit. An upstream
  // `awcms` tag's commit has root `package.json` read as `ahliweb/awcms`'s
  // OWN package (`"name": "awcms"`, a version matching upstream's release
  // line, e.g. `10.3.0`) — that file simply has a different identity at that
  // commit, checked here against this checkout's own package name rather
  // than a hardcoded string, so this also works correctly for a
  // template-derived repository that renamed its own root package.
  const ownPackageName = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).name;

  function isOwnReleaseTag(candidateTag: string): boolean {
    const raw = runCapture(["git", "-C", REPO_ROOT, "show", `${candidateTag}:package.json`]);
    if (!raw.ok) return false;
    let pkg: unknown;
    try {
      pkg = JSON.parse(raw.stdout);
    } catch {
      return false;
    }
    return matchesOwnRelease(pkg as { name?: unknown; version?: unknown }, candidateTag, ownPackageName);
  }

  const allTagsRaw = gitRun(REPO_ROOT, "tag", "--list", "v*");
  const allTagsUnfiltered = allTagsRaw ? allTagsRaw.split("\n").filter(Boolean) : [];
  const allTags = allTagsUnfiltered.filter((t) => !isValidTag(t) || isOwnReleaseTag(t));
  const highestCandidate = allTags
    .filter(isValidTag)
    .sort()
    .reverse()[0]; // rough pre-sort; computeLatestFlag re-derives the real highest
  const highestIsAncestorOfMain = highestCandidate
    ? runCapture(["git", "-C", REPO_ROOT, "merge-base", "--is-ancestor", highestCandidate, "origin/main"]).ok
    : true;

  let flag: "--latest" | "--latest=false";
  try {
    ({ flag } = computeLatestFlag({ tag, allTags, highestIsAncestorOfMain }));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  log(`--latest computation: ${flag}`);

  const token = resolveToken();
  const env = { ...process.env, GH_TOKEN: token };
  const repoSlug = runCaptureOrThrow(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    env
  }).trim();

  const notesFile = join(REPO_ROOT, `.release-notes-${tag}.md`);
  await Bun.write(notesFile, notes);

  try {
    const exists = runCapture(["gh", "release", "view", tag, "--repo", repoSlug], { env });
    if (exists.ok) {
      log(`Release ${tag} already exists — updating its notes.`);
      runInherit(
        ["gh", "release", "edit", tag, "--repo", repoSlug, "--title", tag, "--notes-file", notesFile, flag],
        { env }
      );
    } else {
      log(`Release ${tag} does not exist yet — creating it.`);
      runInherit(
        [
          "gh",
          "release",
          "create",
          tag,
          "--repo",
          repoSlug,
          "--title",
          tag,
          "--notes-file",
          notesFile,
          "--verify-tag",
          flag
        ],
        { env }
      );
    }

    if (evidenceDir) {
      if (!existsSync(evidenceDir)) fail(`--evidence directory does not exist: ${evidenceDir}`);
      const assets = readdirSync(evidenceDir)
        .filter((f) => f.endsWith(".json") || f === "SHA256SUMS")
        .map((f) => join(evidenceDir, f));
      if (assets.length === 0) {
        log(`--evidence given but ${evidenceDir} has no evidence/SBOM/SHA256SUMS files — nothing to attach.`);
      } else {
        log(`Attaching ${assets.length} evidence file(s) to ${tag}...`);
        runInherit(["gh", "release", "upload", tag, ...assets, "--repo", repoSlug, "--clobber"], { env });
      }
    }
  } finally {
    await Bun.write(notesFile, ""); // best-effort; the file is removed next
    try {
      Bun.spawnSync(["rm", "-f", notesFile]);
    } catch {
      // non-fatal
    }
  }

  log(`Done: ${tag} published/updated on ${repoSlug}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
