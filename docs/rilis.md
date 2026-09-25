🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](rilis.id.md)

# Release runbook

The end-to-end path from a written changeset to a signed, published `apps/cms` image and a GitHub Release — `bun run release`, then `bun run release:images -- --publish`, then `bun run release:publish`. See [ADR-0023](adr/0023-release-images-are-built-signed-and-published-from-a-trusted-release-host.md) for why this runs from a trusted release host rather than GitHub Actions, and [ADR-0020](adr/0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md) for which images are published and why the storefront is not.

## The four steps, in order

### 1. `bun run release --apply --commit`

Unchanged from before this ADR (`tools/rilis.mjs`) — folds the waiting `.changesets/*.md` into `CHANGELOG.md`, bumps `package.json`, commits, and tags `vX.Y.Z`. Preview it first without `--apply`; nothing is written until then.

### 2. `git push && git push origin vX.Y.Z`

The tag push is what everything downstream keys off. Push it to `origin` before running either of the next two steps — both refuse to run against a tag that has not reached `origin`.

### 3. `bun run release:images -- --publish --tag vX.Y.Z`

Builds `apps/cms/Dockerfile.production`'s `runtime` and `jobs` targets, pushes both to GHCR, signs each pushed digest, verifies the signature, scans for vulnerabilities, exports each image's SBOM, and writes a release-evidence bundle. Refuses outright unless **all** of the following hold:

- the working tree is clean (no uncommitted or untracked changes);
- `HEAD` is exactly the commit tagged `vX.Y.Z`;
- that commit is an ancestor of `origin/main` (a fetch runs first);
- `COSIGN_KEY` is set to a real signing key — this tool never generates one on the fly.

Required environment (documented in full in root `.env.example`): `GHCR_USER`, `GHCR_TOKEN` (`write:packages` only), `COSIGN_KEY`, `COSIGN_PASSWORD`, `COSIGN_PUBLIC_KEY`. Optional: `--registry` (default `ghcr.io`), `--owner`/`--repo` (default: parsed from `git remote get-url origin`), `--trivy-severity` (default `CRITICAL`), `--evidence-dir` (default: a directory under the OS temp path, deliberately outside this repository's working tree).

Without `--publish`, the same command only builds — never logs in, never pushes, never signs. This is the PR/verification mode; run it as `bun run release:images` (no `--tag` needed, since nothing downstream reads one) to prove both Dockerfile targets still build from the current tree.

**If trivy blocks the run:** a `CRITICAL` finding fails the release closed — read `<evidence-dir>/<target>-trivy.json` for the full report. Two honest paths forward, no third: update the base image (`apps/cms/Dockerfile.production`'s own `FROM oven/bun:...`, upstream — see AGENTS.md's subtree rule for who can change it) so the finding is actually gone, or record a time-boxed, reasoned exception in this repository's own `SECURITY.md` and re-run with a narrower `--trivy-severity` only for the specific, accepted CVE window. Never re-run with a wider severity filter just to make a release go green — that is hiding the finding, not resolving it.

Also runs the build-only storefront Dockerfile smoke — `bun run release:images -- --storefront-smoke` (all three profiles) or `--storefront-smoke --profile toko` (one), replacing `.github/workflows/images.yml`'s `storefront-smoke` job. Never publishes anything (ADR-0020 D2/D3): it only proves `apps/storefront/Dockerfile` still builds against the repository's own stub CMS.

### 4. `bun run release:publish -- vX.Y.Z --evidence <evidence-dir>`

Extracts `vX.Y.Z`'s `CHANGELOG.md` section, computes whether it is the highest release, and creates or updates the matching GitHub Release idempotently. With `--evidence`, attaches the evidence JSON, every exported SBOM, and `SHA256SUMS` as Release assets.

**The `--latest` computation filters out upstream `awcms` tags, not just by ancestry.** `git tag --list 'v*'` in this checkout returns both this repository's own release tags AND `ahliweb/awcms`'s own release tags (`v9.x`, `v10.x` — leaked in by a fetch of that remote without `tagOpt: --no-tags`, AGENTS.md's "Why `--no-tags` is not optional"). Checking that a candidate tag's commit is an ancestor of `origin/main` is **not** sufficient to exclude them: `apps/cms` carries `ahliweb/awcms`'s FULL history via `git subtree`, so an upstream release tag's commit genuinely is an ancestor of `origin/main` once that subtree sync has landed — verified directly against this repository's own clone while building this tool (`git merge-base --is-ancestor v10.3.0 origin/main` answers true, and `v10.3.0` is `ahliweb/awcms`'s own release, not `awcms-one`'s). `release:publish` instead reads each candidate tag's own `package.json` (`git show <tag>:package.json`) and only trusts a tag whose `name` matches this checkout's own `package.json` name and whose `version` matches the tag — see `tools/release/lib/tag.mjs`'s `matchesOwnRelease`.

Token: `RELEASE_GITHUB_TOKEN`, falling back to `gh auth token` (an already-authenticated `gh` CLI) when unset.

## Verifying a published image

For any image published by `tools/release/images.ts` (after ADR-0023):

```bash
cosign verify --key <published-cosign-public-key> \
  ghcr.io/<owner>/<repo>-cms@sha256:<digest>
```

The public key is distributed alongside the release (its own evidence bundle, or this repository's own operational documentation — never committed to the repo itself, since it is meant to outlive any one commit).

For an image published **before** ADR-0023 (by `.github/workflows/images.yml`, with `actions/attest-build-provenance`), the old command still works and always will — that attestation was real and GitHub-issued at the time:

```bash
gh attestation verify oci://ghcr.io/<owner>/<repo>-cms:<tag> --owner <owner>
```

Both commands stay documented here, side by side, rather than the old one quietly going stale.

Signatures on a real publish are recorded in the public Rekor transparency log, so the plain command above works as written. A signature made with `COSIGN_TLOG_UPLOAD=false` has no Rekor entry and verifies only with `--insecure-ignore-tlog=true` added; the release's evidence JSON (`cosign.tlog`) says which applies.

## Rehearsing without touching GHCR

`tools/release/images.ts`'s full publish path (build → push → digest readback → sign → verify → scan → SBOM → evidence) can be rehearsed end to end against a throwaway local registry, without pushing anything real or touching a production key:

```bash
# 1. A throwaway registry, bound to localhost only.
docker run -d --name rehearsal-registry -p 5999:5000 registry:2

# 2. A throwaway cosign keypair, in a directory nothing else reads.
mkdir -m 777 /tmp/rehearsal-cosign   # 777 only because the cosign
                                      # container runs as a non-root uid;
                                      # delete this directory when done.
docker run --rm -e COSIGN_PASSWORD=rehearsal-pw -e COSIGN_YES=true \
  -v /tmp/rehearsal-cosign:/work -w /work \
  gcr.io/projectsigstore/cosign@sha256:<pinned digest — see tools/release/lib/pinned-images.mjs> \
  generate-key-pair

# 3. A temporary LOCAL-ONLY tag, never pushed to origin.
git tag v99.99.99 HEAD

# 4. The rehearsal run itself.
RELEASE_DANGEROUSLY_SKIP_ANCESTOR_CHECK=1 \
GHCR_USER=x GHCR_TOKEN=x \
COSIGN_KEY=/tmp/rehearsal-cosign/cosign.key \
COSIGN_PASSWORD=rehearsal-pw \
COSIGN_PUBLIC_KEY=/tmp/rehearsal-cosign/cosign.pub \
RELEASE_EVIDENCE_DIR=/tmp/rehearsal-evidence \
bun run release:images -- --publish --tag v99.99.99 \
  --registry localhost:5999 --owner <owner> --repo <repo>

# 5. Clean up — every one of these, every time.
git tag -d v99.99.99
docker rm -f rehearsal-registry
rm -rf /tmp/rehearsal-cosign /tmp/rehearsal-evidence
docker logout localhost:5999
```

`RELEASE_DANGEROUSLY_SKIP_ANCESTOR_CHECK=1` exists for exactly this — a rehearsal tag can never be an ancestor of `origin/main` by construction — and is logged loudly by the script itself every time it is set. It has no other legitimate use; a real release always tags a commit already on `origin/main`, so the real ancestry check always passes for it and this variable is never needed there.

Two Docker mechanics worth knowing before running this by hand:

- The `docker-container` buildx builder this tool creates (`awcms-one-release`, or whatever `--builder` names) is created with `--driver-opt network=host` specifically so it can reach a registry bound to the release host's own `localhost` — a `docker-container` builder otherwise runs BuildKit in its own network namespace and cannot see it.
- Every `docker run` this tool makes for `cosign`/`trivy`/`syft` also runs with `--network host`, for the same reason.

## Escalating a blocked release

| Signal | Where it shows | What to do |
| --- | --- | --- |
| `release:images` refuses to publish | Its own error, naming every unmet precondition at once | Fix each one named — a dirty tree, `HEAD` not the tag, the tag not reachable from `origin/main`, or no `COSIGN_KEY` configured |
| trivy blocks on a CRITICAL finding | `<evidence-dir>/<target>-trivy.json` | Update the base image, or record a reasoned, time-boxed exception in `SECURITY.md` — never widen the severity filter just to pass |
| cosign verify fails right after signing | The script's own error, before anything else runs | The key and public key do not match, or the registry served something other than what was just pushed — stop and investigate; never retry blindly |
| `--latest` looks wrong for a release that should be newest | The script's own `--latest computation: ...` log line | `release:publish` already filters `git tag -l 'v*'` down to this repo's own release tags by package identity (see above) — if it still looks wrong, check `git show <the-tag-you-expected>:package.json` actually has this repo's own `name`/`version` at that commit |
