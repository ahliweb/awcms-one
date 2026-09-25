---
bump: minor
type: structure
impact: public
---

# Build, sign, and publish release images and GitHub Releases from a trusted release host

Issue #225 part 2 (zero-GitHub-Actions policy). `tools/release/images.ts` and `tools/release/publish.ts` (`bun run release:images`, `bun run release:publish`) replace what `.github/workflows/images.yml` and `.github/workflows/release.yml` do — building and pushing `apps/cms`'s `runtime`/`jobs` images to GHCR, signing each pushed digest with cosign, scanning with trivy (fail-closed on `CRITICAL`), exporting SBOMs, and publishing the matching GitHub Release — from a release host `awcms-one` itself controls, rather than a GitHub-hosted runner.

Neither workflow file is removed by this change; both keep running until a later change disables GitHub Actions at the repository level and migrates the required-status-check contexts (issue #225's own remaining steps).

- [ADR-0023](../docs/adr/0023-release-images-are-built-signed-and-published-from-a-trusted-release-host.md) documents the new cosign-key trust root, why it supersedes ADR-0020's GitHub-native attestation for images published from here on, and the honest assurance-level trade-off.
- [`docs/rilis.md`](../docs/rilis.md) is the full release runbook, including how to rehearse the whole publish path against a throwaway local registry without touching GHCR or a production key.
- New root env vars: `GHCR_USER`, `GHCR_TOKEN`, `COSIGN_KEY`, `COSIGN_PASSWORD`, `COSIGN_PUBLIC_KEY`, `RELEASE_EVIDENCE_DIR`, `RELEASE_DANGEROUSLY_SKIP_ANCESTOR_CHECK`, `RELEASE_GITHUB_TOKEN` — all documented in root `.env.example`.
- An owner running the first real `--publish` needs a `COSIGN_KEY`/`COSIGN_PUBLIC_KEY` pair provisioned on the release host and a `GHCR_TOKEN` scoped to `write:packages` only — neither exists yet as a repository secret, by design (this tool never generates a signing key on the fly).
