#!/usr/bin/env bun
/**
 * tools/release/images.ts — replaces `.github/workflows/images.yml`.
 *
 * Builds `apps/cms/Dockerfile.production`'s `runtime` and `jobs` targets
 * (unmodified, upstream — AGENTS.md's subtree rule) with `docker buildx`,
 * and — only with `--publish` — pushes both to GHCR, verifies the pushed
 * digest matches what was built, signs each image BY DIGEST with cosign,
 * verifies that signature, scans it with trivy (failing closed on
 * CRITICAL by default), exports its SBOM, and writes a release-evidence
 * JSON plus a `SHA256SUMS` file. See `docs/rilis.md` for the full runbook
 * and `docs/adr/0023-...md` for why this replaces ADR-0020's GitHub-native
 * attestation trust root with a cosign key the release host itself holds.
 *
 * Usage:
 *   bun run release:images                         # build only (PR/verification mode)
 *   bun run release:images -- --publish            # build, push, sign, verify, scan
 *   bun run release:images -- --publish --tag v1.2.3
 *   bun run release:images -- --publish --registry ghcr.io
 *   bun run release:images -- --storefront-smoke    # apps/storefront Dockerfile smoke, all 3 profiles
 *   bun run release:images -- --storefront-smoke --profile toko
 *
 * Every value this script cannot compute is read from the environment;
 * every one of them is documented in the root `.env.example` (AGENTS.md's
 * "every env variable a root-level script reads belongs in .env.example").
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { gitRun, gitRunOrThrow } from "../../packages/gerbang/lib/git.mjs";
import { buildBuildxArgs, ociLabels } from "./lib/buildx.mjs";
import { buildEvidence } from "./lib/evidence.mjs";
import { cosignSignArgs, cosignVerifyArgs, shouldUploadTlog } from "./lib/cosign.mjs";
import { SYFT_IMAGE, TRIVY_IMAGE } from "./lib/pinned-images.mjs";
import { runCapture, runCaptureOrThrow, runInherit } from "./lib/proc.mjs";
import { checkPublishPreconditions } from "./lib/refusal.mjs";
import { deriveImageTags, imageRepository, parseGitHubRemote, parseTag } from "./lib/tag.mjs";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

/** The two content-independent apps/cms images, ADR-0020. */
const TARGETS = [
  { target: "runtime", suffix: "cms" },
  { target: "jobs", suffix: "cms-jobs" }
];

const PROFILES = ["toko", "berita", "landing"];

function parseArgs(argv: string[]) {
  const opts = {
    publish: argv.includes("--publish"),
    storefrontSmoke: argv.includes("--storefront-smoke"),
    registry: "ghcr.io",
    tag: undefined as string | undefined,
    profile: undefined as string | undefined,
    owner: undefined as string | undefined,
    repo: undefined as string | undefined,
    trivySeverity: "CRITICAL",
    evidenceDir: process.env.RELEASE_EVIDENCE_DIR ?? join(tmpdir(), "awcms-one-release-evidence"),
    builder: "awcms-one-release"
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--registry") opts.registry = argv[++i];
    else if (a === "--tag") opts.tag = argv[++i];
    else if (a === "--profile") opts.profile = argv[++i];
    else if (a === "--owner") opts.owner = argv[++i];
    else if (a === "--repo") opts.repo = argv[++i];
    else if (a === "--trivy-severity") opts.trivySeverity = argv[++i];
    else if (a === "--evidence-dir") opts.evidenceDir = argv[++i];
    else if (a === "--builder") opts.builder = argv[++i];
  }
  return opts;
}

function log(msg: string) {
  console.log(`[release:images] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[release:images] ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Ensures a `docker-container` builder named `opts.builder` exists, creating
 * it if not. `--driver-opt network=host` puts BuildKit's own container on
 * the HOST network namespace (not merely a bridge network shared with a
 * registry container) — needed because this tool's own rehearsal
 * (docs/rilis.md's "Rehearsing without touching GHCR") pushes to a registry
 * bound to the release host's own `localhost`, which a `docker-container`
 * builder cannot otherwise reach (the same class of problem
 * `apps/storefront`'s own `storefront-smoke` job solves differently — see
 * `runStorefrontSmoke`'s own comment — because that job needs the classic
 * `docker` driver instead, which this one cannot use: pushing to a registry
 * needs `docker-container`'s own multi-manifest/attestation support).
 */
function ensureBuilder(name: string) {
  const list = runCapture(["docker", "buildx", "inspect", name]);
  if (list.ok) return;
  log(`Creating docker-container builder "${name}" (none found).`);
  runInherit([
    "docker",
    "buildx",
    "create",
    "--name",
    name,
    "--driver",
    "docker-container",
    "--driver-opt",
    "network=host",
    "--bootstrap"
  ]);
}

function resolveOwnerRepo(explicitOwner: string | undefined, explicitRepo: string | undefined) {
  if (explicitOwner && explicitRepo) return { owner: explicitOwner, repo: explicitRepo };
  const remote = gitRun(REPO_ROOT, "remote", "get-url", "origin");
  if (!remote) fail("Could not read `git remote get-url origin` — pass --owner/--repo explicitly.");
  return parseGitHubRemote((remote as string).trim());
}

function resolveTag(explicitTag: string | undefined): string {
  if (explicitTag) return explicitTag;
  const described = gitRun(REPO_ROOT, "describe", "--tags", "--exact-match", "HEAD");
  if (!described) {
    fail(
      "HEAD is not exactly a tag and no --tag was given. " +
        "Pass --tag vX.Y.Z, or run this from a checkout of that tag."
    );
  }
  return (described as string).trim();
}

/** True when the working tree (tracked + untracked) is clean. */
function treeIsClean(): boolean {
  const status = gitRun(REPO_ROOT, "status", "--porcelain");
  return status === "";
}

function headIsExactlyTag(tag: string): boolean {
  const headSha = gitRunOrThrow(REPO_ROOT, "rev-parse", "HEAD").trim();
  const tagSha = gitRun(REPO_ROOT, "rev-list", "-n", "1", tag);
  return tagSha !== null && tagSha.trim() === headSha;
}

function tagIsAncestorOfOriginMain(tag: string): boolean {
  runInherit(["git", "-C", REPO_ROOT, "fetch", "origin", "main", "--quiet"]);
  const result = runCapture(["git", "-C", REPO_ROOT, "merge-base", "--is-ancestor", tag, "origin/main"]);
  return result.ok;
}

/** Resolves COSIGN_KEY into a cosign CLI argument plus any docker bind-mount it needs. */
function resolveCosignKeyArg(cosignKey: string): { keyArg: string; mount?: string } {
  if (/^(awskms|gcpkms|azurekms|hashivault):\/\//.test(cosignKey)) {
    return { keyArg: cosignKey };
  }
  // A local file path: mounted read-only into the cosign container at a fixed path.
  const abs = cosignKey.startsWith("/") ? cosignKey : join(process.cwd(), cosignKey);
  if (!existsSync(abs)) fail(`COSIGN_KEY names a file that does not exist: ${abs}`);
  return { keyArg: "/keys/cosign.key", mount: `${abs}:/keys/cosign.key:ro` };
}

function cosignSign(ref: string, digest: string, tlogUpload: boolean) {
  const cosignKey = process.env.COSIGN_KEY;
  if (!cosignKey) fail("COSIGN_KEY is not set — refusing to sign.");
  const { keyArg, mount } = resolveCosignKeyArg(cosignKey);
  // COSIGN_PASSWORD is passed by NAME (lib/cosign.mjs): docker copies it from
  // this process's environment, so it never appears in an argv.
  const args = cosignSignArgs({
    keyArg,
    keyMount: mount,
    dockerConfig: `${process.env.HOME}/.docker/config.json`,
    ref: `${ref}@${digest}`,
    tlogUpload
  });
  log(`Signing ${ref}@${digest} with cosign (Rekor transparency log: ${tlogUpload ? "upload" : "skipped"})...`);
  runInherit(args, { env: { ...process.env, COSIGN_PASSWORD: process.env.COSIGN_PASSWORD ?? "" } });
}

function cosignVerify(ref: string, digest: string, tlogUpload: boolean): { verified: boolean; output: string; tlog: boolean } {
  const publicKey = process.env.COSIGN_PUBLIC_KEY;
  if (!publicKey) fail("COSIGN_PUBLIC_KEY is not set — refusing to verify what was just signed.");
  const abs = publicKey.startsWith("/") ? publicKey : join(process.cwd(), publicKey);
  const args = cosignVerifyArgs({
    publicKeyPath: abs,
    dockerConfig: `${process.env.HOME}/.docker/config.json`,
    ref: `${ref}@${digest}`,
    tlogUpload
  });
  const result = runCapture(args);
  if (!result.ok) fail(`cosign verify failed for ${ref}@${digest}:\n${result.stderr}`);
  return { verified: true, output: result.stdout.trim(), tlog: tlogUpload };
}

function trivyScan(ref: string, digest: string, severity: string, reportFile: string) {
  const args = [
    "docker",
    "run",
    "--rm",
    "--network",
    "host",
    "-v",
    `${process.env.HOME}/.docker/config.json:/root/.docker/config.json:ro`,
    TRIVY_IMAGE,
    "image",
    "--quiet",
    "--severity",
    severity,
    "--exit-code",
    "1",
    "--format",
    "json",
    `${ref}@${digest}`
  ];
  log(`Scanning ${ref}@${digest} with trivy (fail-closed on ${severity})...`);
  const result = runCapture(args);
  // The full JSON report always goes to the evidence dir — never dumped to
  // the terminal, which for a real finding is thousands of lines. A
  // reviewer reads the file; the terminal gets counts.
  writeFileSync(reportFile, result.stdout);
  let summary: { critical: number; high: number } = { critical: 0, high: 0 };
  try {
    const parsed = JSON.parse(result.stdout);
    const vulns = (parsed.Results ?? []).flatMap((r: { Vulnerabilities?: { Severity: string }[] }) => r.Vulnerabilities ?? []);
    summary = {
      critical: vulns.filter((v: { Severity: string }) => v.Severity === "CRITICAL").length,
      high: vulns.filter((v: { Severity: string }) => v.Severity === "HIGH").length
    };
  } catch {
    // Non-JSON output (e.g. a trivy usage error) — surfaced via the exit-code check below.
  }
  if (!result.ok) {
    fail(
      `trivy found ${summary.critical} CRITICAL / ${summary.high} HIGH vulnerabilities in ` +
        `${ref}@${digest} (fail-closed at ${severity}+). Full report: ${reportFile}${result.stderr ? `\n${result.stderr}` : ""}`
    );
  }
  return { scanner: "trivy", ...summary, failedClosed: true };
}

function syftSbom(ref: string, digest: string, outFile: string) {
  const args = [
    "docker",
    "run",
    "--rm",
    "--network",
    "host",
    "-v",
    `${process.env.HOME}/.docker/config.json:/root/.docker/config.json:ro`,
    SYFT_IMAGE,
    `${ref}@${digest}`,
    "-o",
    "spdx-json"
  ];
  log(`Exporting SBOM for ${ref}@${digest}...`);
  const result = runCaptureOrThrow(args);
  writeFileSync(outFile, result);
}

async function runStorefrontSmoke(profiles: string[]) {
  for (const profile of profiles) {
    if (!PROFILES.includes(profile)) fail(`Unknown profile "${profile}" — expected one of ${PROFILES.join(", ")}.`);
    log(`Storefront Dockerfile smoke — profile=${profile}`);

    const stub = Bun.spawn(["bun", "scripts/stub-awcms.mjs"], {
      cwd: join(REPO_ROOT, "apps/storefront"),
      stdout: "pipe",
      stderr: "pipe"
    });

    try {
      let ready = false;
      for (let i = 0; i < 30 && !ready; i++) {
        const probe = await fetch("http://localhost:4310/api/v1/commerce/products", {
          headers: { Authorization: "Bearer smoke" }
        }).catch(() => null);
        if (probe && probe.ok) ready = true;
        else await new Promise((r) => setTimeout(r, 1000));
      }
      if (!ready) fail("Stub CMS did not become ready in time.");

      const secretsDir = join(REPO_ROOT, ".secrets");
      mkdirSync(secretsDir, { recursive: true });
      const secretFile = join(secretsDir, "awcms_api_token");
      writeFileSync(secretFile, "smoke-test-dummy-token");

      // `--network host`, classic `docker` buildx driver: issue #198's own
      // reason — see images.yml's historical comment, reproduced verbatim
      // in docs/rilis.md, for why the container driver cannot reach a stub
      // bound to this host's own localhost.
      runInherit([
        "docker",
        "buildx",
        "build",
        "--builder",
        "default",
        "--network",
        "host",
        "-f",
        "apps/storefront/Dockerfile",
        "--build-arg",
        `SITE_PROFILE=${profile}`,
        "--build-arg",
        "SITE_URL=http://localhost:4321",
        "--build-arg",
        "AWCMS_API_URL=http://localhost:4310",
        "--build-arg",
        "PUBLIC_AWCMS_ORIGIN=http://localhost:4310",
        "--secret",
        `id=awcms_api_token,src=${secretFile}`,
        "."
      ], { cwd: REPO_ROOT });
    } finally {
      stub.kill();
    }
  }
  log("Storefront Dockerfile smoke passed for: " + profiles.join(", "));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.storefrontSmoke) {
    await runStorefrontSmoke(opts.profile ? [opts.profile] : PROFILES);
    return;
  }

  const tag = resolveTag(opts.tag);
  const { version } = parseTag(tag);
  const { owner, repo } = resolveOwnerRepo(opts.owner, opts.repo);

  if (opts.publish) {
    // `RELEASE_DANGEROUSLY_SKIP_ANCESTOR_CHECK` exists for exactly one use:
    // the end-to-end rehearsal against a throwaway local registry and a
    // temporary local-only tag (docs/rilis.md's "Rehearsing without touching
    // GHCR") — a real release always publishes a tag already on
    // origin/main, so the real check always passes for it. Set only in that
    // rehearsal, never for an actual publish; every use is logged loudly so
    // it cannot pass unnoticed in a transcript or CI log.
    const skipAncestorCheck = process.env.RELEASE_DANGEROUSLY_SKIP_ANCESTOR_CHECK === "1";
    if (skipAncestorCheck) {
      log(
        "RELEASE_DANGEROUSLY_SKIP_ANCESTOR_CHECK=1 — skipping the origin/main ancestry check. " +
          "This must ONLY be set for a rehearsal against a throwaway registry, never a real publish."
      );
    }
    const facts = {
      treeIsClean: treeIsClean(),
      headIsTag: headIsExactlyTag(tag),
      tagIsAncestorOfMain: skipAncestorCheck || tagIsAncestorOfOriginMain(tag),
      cosignKeyConfigured: Boolean(process.env.COSIGN_KEY)
    };
    const decision = checkPublishPreconditions(facts);
    if (!decision.ok) {
      fail(`Refusing to publish ${tag}:\n` + decision.reasons.map((r) => `  - ${r}`).join("\n"));
    }

    const ghcrUser = process.env.GHCR_USER;
    const ghcrToken = process.env.GHCR_TOKEN;
    if (!ghcrUser || !ghcrToken) {
      fail("GHCR_USER and GHCR_TOKEN (write:packages only) must both be set to publish.");
    }
    log(`Logging in to ${opts.registry} as ${ghcrUser}...`);
    const login = Bun.spawnSync(["docker", "login", opts.registry, "-u", ghcrUser, "--password-stdin"], {
      stdin: Buffer.from(ghcrToken)
    });
    if (login.exitCode !== 0) fail(`docker login ${opts.registry} failed.`);
  }

  ensureBuilder(opts.builder);

  const sourceSha = gitRunOrThrow(REPO_ROOT, "rev-parse", "HEAD").trim();
  const createdAt = new Date().toISOString();
  const sourceUrl = `https://github.com/${owner}/${repo}`;

  mkdirSync(opts.evidenceDir, { recursive: true });
  const sbomFiles: string[] = [];
  const images: { name: string; target: string; digest: string; tags: string[] }[] = [];
  let lastCosign: { verified: boolean; output: string; tlog: boolean } | undefined;
  let lastTrivy: { scanner: string; critical: number; high: number; failedClosed: boolean } | undefined;

  for (const { target, suffix } of TARGETS) {
    const repository = imageRepository({ registry: opts.registry, owner, repo, suffix });
    const versionTags = deriveImageTags(tag, sourceSha);
    const fullTags = versionTags.map((t) => `${repository}:${t}`);
    const labels = ociLabels({ sourceUrl, revision: sourceSha, version, createdAt });

    const metadataFile = join(opts.evidenceDir, `${suffix}-metadata.json`);
    const args = buildBuildxArgs({
      context: "apps/cms",
      file: "apps/cms/Dockerfile.production",
      target,
      builder: opts.builder,
      tags: fullTags,
      labels,
      push: opts.publish
    });

    log(`Building ${repository} (target=${target})${opts.publish ? " and pushing" : " (build only)"}...`);
    runInherit(["docker", "buildx", "build", ...args, "--metadata-file", metadataFile], { cwd: REPO_ROOT });

    // Without `--push` (and without `--output`), a `docker-container`
    // builder keeps the result only in its own build cache — buildx then
    // reports no `containerimage.digest` at all (see its own "No output
    // specified" warning). That is fine for build-only mode, whose only
    // job is "did the build succeed" — digest verification, signing,
    // scanning, and SBOM export below all require `--publish`.
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
    const builtDigest: string | undefined = metadata["containerimage.digest"];
    if (opts.publish && !builtDigest) {
      fail(`buildx did not report a digest for ${repository} (target=${target}) despite --push.`);
    }

    let digest = builtDigest ?? "";

    if (opts.publish) {
      log(`Reading back the pushed digest for ${fullTags[0]}...`);
      const inspect = runCaptureOrThrow(["docker", "buildx", "imagetools", "inspect", fullTags[0], "--format", "{{json .Manifest}}"]);
      const pushedDigest: string = JSON.parse(inspect).digest;
      if (pushedDigest !== builtDigest) {
        fail(
          `Pushed digest for ${repository} does not match the build's own digest:\n` +
            `  built:  ${builtDigest}\n  pushed: ${pushedDigest}`
        );
      }
      digest = pushedDigest;

      const tlogUpload = shouldUploadTlog({ registry: opts.registry, override: process.env.COSIGN_TLOG_UPLOAD });
      cosignSign(repository, digest, tlogUpload);
      const verify = cosignVerify(repository, digest, tlogUpload);
      log(`cosign verify: ${verify.verified ? "OK" : "FAILED"}`);

      const trivyReportFile = join(opts.evidenceDir, `${suffix}-trivy.json`);
      const trivy = trivyScan(repository, digest, opts.trivySeverity, trivyReportFile);
      log(`trivy: ${JSON.stringify(trivy)}`);

      const sbomFile = join(opts.evidenceDir, `${suffix}-sbom.spdx.json`);
      syftSbom(repository, digest, sbomFile);
      sbomFiles.push(sbomFile);

      images.push({ name: repository, target, digest, tags: fullTags });

      // One evidence document's cosign/trivy summary stands for the whole
      // publish, not per-image — both targets are built from the same
      // commit under the same policy, and a per-image breakdown would only
      // duplicate the same pass/fail twice.
      lastCosign = verify;
      lastTrivy = trivy;
    } else {
      images.push({ name: repository, target, digest, tags: fullTags });
    }
  }

  if (!opts.publish) {
    log("Build-only mode (no --publish): never logged in, never pushed.");
    return;
  }

  const evidence = buildEvidence({
    tag,
    sourceSha,
    images,
    sbomFiles: sbomFiles.map((f) => f.replace(`${opts.evidenceDir}/`, "")),
    cosign: lastCosign!,
    trivy: lastTrivy!,
    builtAt: createdAt,
    builder: runCaptureOrThrow(["docker", "buildx", "version"]).trim()
  });

  const evidenceFile = join(opts.evidenceDir, `${tag}-evidence.json`);
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);

  // SHA256SUMS over every evidence artefact, so `gh release upload` carries
  // one file a consumer can check everything else against.
  const shaLines: string[] = [];
  for (const f of [evidenceFile, ...sbomFiles]) {
    const sum = runCaptureOrThrow(["sha256sum", f]).trim();
    // sha256sum prints the path as given; rewrite to a bare filename so the
    // checksum file is portable once these artefacts are downloaded together.
    const [hash] = sum.split(/\s+/);
    shaLines.push(`${hash}  ${f.split("/").pop()}`);
  }
  writeFileSync(join(opts.evidenceDir, "SHA256SUMS"), `${shaLines.join("\n")}\n`);

  log(`Evidence written to ${opts.evidenceDir}`);
  log(`  ${evidenceFile}`);
  log(`  ${join(opts.evidenceDir, "SHA256SUMS")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
