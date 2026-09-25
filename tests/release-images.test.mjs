/**
 * Pure-logic gate for `tools/release/images.ts` — issue #225 part 2, the
 * trusted-release-host replacement for `.github/workflows/images.yml`.
 *
 * Everything asserted here is side-effect-free logic imported from
 * `tools/release/lib/*.mjs` — no git, no Docker, no network — the same
 * split `packages/gerbang/lib/` uses for `tools/rilis.mjs`. The real
 * end-to-end mechanics (build, push, digest readback, cosign sign/verify,
 * trivy, SBOM export) are proven separately, by hand, against a throwaway
 * local registry — see docs/rilis.md's "Rehearsing without touching GHCR".
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import { buildBuildxArgs, ociLabels } from "../tools/release/lib/buildx.mjs";
import { buildEvidence, validateEvidence } from "../tools/release/lib/evidence.mjs";
import { checkPublishPreconditions } from "../tools/release/lib/refusal.mjs";
import {
  TAG_REGEX,
  deriveImageTags,
  highestTag,
  imageRepository,
  isValidTag,
  lowerCaseOwnerRepo,
  parseGitHubRemote,
  parseTag
} from "../tools/release/lib/tag.mjs";

describe("tag.mjs — tag validity and version parsing", () => {
  test("TAG_REGEX / isValidTag accepts vX.Y.Z and rejects everything else", () => {
    for (const good of ["v0.1.0", "v1.2.3", "v10.20.30"]) {
      assert.ok(isValidTag(good), `expected ${good} to be valid`);
    }
    for (const bad of ["0.1.0", "v1.2", "v1.2.3-rc1", "v1.2.3.4", "v1.2.x", "vv1.2.3", ""]) {
      assert.ok(!isValidTag(bad), `expected ${bad} to be invalid`);
    }
  });

  test("parseTag extracts major/minor/patch/version", () => {
    assert.deepEqual(parseTag("v1.2.3"), { major: 1, minor: 2, patch: 3, version: "1.2.3" });
  });

  test("parseTag throws on a malformed tag", () => {
    assert.throws(() => parseTag("v1.2"), /does not match/);
  });
});

describe("tag.mjs — deriveImageTags (the metadata-action-equivalent tag set)", () => {
  test("produces X.Y.Z, X.Y, and sha-<7> in that order", () => {
    assert.deepEqual(
      deriveImageTags("v1.2.3", "abcdef1234567890"),
      ["1.2.3", "1.2", "sha-abcdef1"]
    );
  });

  test("refuses a SHA shorter than 7 characters", () => {
    assert.throws(() => deriveImageTags("v1.2.3", "abc123"), /at least 7 characters/);
  });
});

describe("tag.mjs — highestTag ignores anything outside the vX.Y.Z namespace", () => {
  test("picks the highest by numeric semver order, not string order", () => {
    assert.equal(highestTag(["v0.9.0", "v0.10.0", "v0.2.0"]), "v0.10.0");
  });

  test("ignores non-matching tags entirely — the AGENTS.md upstream-pollution case", () => {
    // e.g. an upstream `awcms` release tag that leaked in via a fetch
    // without --no-tags, or an arbitrary annotation someone pushed.
    assert.equal(
      highestTag(["v0.9.0", "some-random-tag", "v10.3.0-not-ours-shape", "release-2024"]),
      "v0.9.0"
    );
  });

  test("returns null for an empty or fully-non-matching list", () => {
    assert.equal(highestTag([]), null);
    assert.equal(highestTag(["not-a-tag"]), null);
  });
});

describe("tag.mjs — owner/repo lower-casing and parsing", () => {
  test("lowerCaseOwnerRepo lower-cases both fields", () => {
    assert.deepEqual(lowerCaseOwnerRepo({ owner: "AhliWeb", repo: "AWCMS-One" }), {
      owner: "ahliweb",
      repo: "awcms-one"
    });
  });

  test("parseGitHubRemote handles the SSH and HTTPS forms, with or without .git", () => {
    assert.deepEqual(parseGitHubRemote("git@github.com:ahliweb/awcms-one.git"), {
      owner: "ahliweb",
      repo: "awcms-one"
    });
    assert.deepEqual(parseGitHubRemote("https://github.com/ahliweb/awcms-one.git"), {
      owner: "ahliweb",
      repo: "awcms-one"
    });
    assert.deepEqual(parseGitHubRemote("https://github.com/ahliweb/awcms-one"), {
      owner: "ahliweb",
      repo: "awcms-one"
    });
  });

  test("parseGitHubRemote throws on an unrecognisable URL", () => {
    assert.throws(() => parseGitHubRemote("not a git url"), /Could not parse/);
  });

  test("imageRepository builds the ghcr.io/<owner>/<repo>-<suffix> shape, lower-cased", () => {
    assert.equal(
      imageRepository({ registry: "ghcr.io", owner: "AhliWeb", repo: "AWCMS-One", suffix: "cms" }),
      "ghcr.io/ahliweb/awcms-one-cms"
    );
    assert.equal(
      imageRepository({ registry: "ghcr.io", owner: "ahliweb", repo: "awcms-one", suffix: "cms-jobs" }),
      "ghcr.io/ahliweb/awcms-one-cms-jobs"
    );
  });
});

describe("buildx.mjs — buildBuildxArgs never invents --push", () => {
  const base = {
    context: "apps/cms",
    file: "apps/cms/Dockerfile.production",
    target: "runtime",
    builder: "awcms-one-release",
    tags: ["ghcr.io/o/r-cms:1.2.3"],
    labels: { "org.opencontainers.image.version": "1.2.3" }
  };

  test("push: false never includes --push", () => {
    const args = buildBuildxArgs({ ...base, push: false });
    assert.ok(!args.includes("--push"));
  });

  test("push: true includes --push", () => {
    const args = buildBuildxArgs({ ...base, push: true });
    assert.ok(args.includes("--push"));
  });

  test("always includes provenance and sbom", () => {
    const args = buildBuildxArgs({ ...base, push: false });
    assert.ok(args.includes("--provenance=mode=max"));
    assert.ok(args.includes("--sbom=true"));
  });

  test("includes every tag and every label", () => {
    const args = buildBuildxArgs({
      ...base,
      push: false,
      tags: ["a:1", "a:2"],
      labels: { x: "1", y: "2" }
    });
    assert.deepEqual(
      args.filter((_, i) => args[i - 1] === "--tag"),
      ["a:1", "a:2"]
    );
    assert.deepEqual(
      args.filter((_, i) => args[i - 1] === "--label"),
      ["x=1", "y=2"]
    );
  });

  test("requires context/file/target/builder", () => {
    assert.throws(() => buildBuildxArgs({ ...base, context: undefined, push: false }));
  });

  test("requires at least one tag", () => {
    assert.throws(() => buildBuildxArgs({ ...base, tags: [], push: false }));
  });

  test("ociLabels matches metadata-action's default label set", () => {
    const labels = ociLabels({
      sourceUrl: "https://github.com/ahliweb/awcms-one",
      revision: "abc123",
      version: "1.2.3",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    assert.equal(labels["org.opencontainers.image.source"], "https://github.com/ahliweb/awcms-one");
    assert.equal(labels["org.opencontainers.image.revision"], "abc123");
    assert.equal(labels["org.opencontainers.image.version"], "1.2.3");
    assert.equal(labels["org.opencontainers.image.created"], "2026-01-01T00:00:00.000Z");
    assert.equal(labels["org.opencontainers.image.licenses"], "MIT");
  });
});

describe("refusal.mjs — checkPublishPreconditions", () => {
  const allGood = {
    treeIsClean: true,
    headIsTag: true,
    tagIsAncestorOfMain: true,
    cosignKeyConfigured: true
  };

  test("ok when every fact holds", () => {
    assert.deepEqual(checkPublishPreconditions(allGood), { ok: true });
  });

  test("refuses a dirty tree", () => {
    const result = checkPublishPreconditions({ ...allGood, treeIsClean: false });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes("working tree")));
  });

  test("refuses when HEAD is not the tag", () => {
    const result = checkPublishPreconditions({ ...allGood, headIsTag: false });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes("HEAD")));
  });

  test("refuses when the tag is not an ancestor of origin/main", () => {
    const result = checkPublishPreconditions({ ...allGood, tagIsAncestorOfMain: false });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes("ancestor")));
  });

  test("refuses when no cosign key is configured, and never invents one", () => {
    const result = checkPublishPreconditions({ ...allGood, cosignKeyConfigured: false });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes("cosign")));
  });

  test("reports every failing reason at once, not just the first", () => {
    const result = checkPublishPreconditions({
      treeIsClean: false,
      headIsTag: false,
      tagIsAncestorOfMain: false,
      cosignKeyConfigured: false
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasons.length, 4);
  });
});

describe("evidence.mjs — the release-evidence JSON shape", () => {
  const validImage = { name: "ghcr.io/o/r-cms", target: "runtime", digest: "sha256:" + "a".repeat(64), tags: ["1.2.3"] };
  const valid = buildEvidence({
    tag: "v1.2.3",
    sourceSha: "a".repeat(40),
    images: [validImage],
    sbomFiles: ["cms-sbom.spdx.json"],
    cosign: { verified: true },
    trivy: { failedClosed: true, critical: 0, high: 0 },
    builtAt: "2026-01-01T00:00:00.000Z",
    builder: "docker buildx v0.37.1"
  });

  test("a well-formed document has no problems", () => {
    assert.deepEqual(validateEvidence(valid), []);
  });

  test("rejects a non-object", () => {
    assert.deepEqual(validateEvidence(null), ["evidence must be an object"]);
    assert.ok(validateEvidence("nope").length > 0);
  });

  test("rejects a missing/empty images array", () => {
    assert.ok(validateEvidence({ ...valid, images: [] }).length > 0);
    assert.ok(validateEvidence({ ...valid, images: undefined }).length > 0);
  });

  test("rejects an image digest that does not start with sha256:", () => {
    const problems = validateEvidence({
      ...valid,
      images: [{ ...validImage, digest: "not-a-digest" }]
    });
    assert.ok(problems.some((p) => p.includes("sha256:")));
  });

  test("rejects a missing cosign.verified / trivy.failedClosed boolean", () => {
    assert.ok(validateEvidence({ ...valid, cosign: {} }).length > 0);
    assert.ok(validateEvidence({ ...valid, trivy: {} }).length > 0);
  });

  test("rejects a missing top-level string field", () => {
    const { tag, ...rest } = valid;
    assert.ok(validateEvidence(rest).some((p) => p.includes('"tag"')));
  });
});
