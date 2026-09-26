/**
 * pinned-images.mjs — every third-party container image this tool runs
 * ON THE HOST'S BEHALF (cosign, trivy), pinned by digest, one place.
 *
 * The release host has no cosign or trivy binary installed (this tool's own
 * design constraint — see `docs/rilis.md`), so both run as
 * `docker run --rm <image>@sha256:<digest> ...`. Pinning by digest, not tag,
 * for the same reason `local-ci/security`'s own gitleaks image is pinned by
 * digest (`tools/ci/runners/security.ts`): a tag can move, a digest cannot,
 * and both tools sit directly on the supply-chain trust path this release
 * is trying to establish.
 *
 * Bumping one of these is a deliberate act — re-pull the new tag, copy its
 * digest, update the constant and the comment beside it, exercise the
 * end-to-end rehearsal (`docs/rilis.md`'s "Rehearsing without touching
 * GHCR") before trusting it for a real publish.
 */

/** gcr.io/projectsigstore/cosign:v2.4.1 */
export const COSIGN_IMAGE = "gcr.io/projectsigstore/cosign@sha256:b03690aa52bfe94054187142fba24dc54137650682810633901767d8a3e15b31";

/** aquasec/trivy:0.58.1 */
export const TRIVY_IMAGE = "aquasec/trivy@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7";

/** anchore/syft:v1.18.0 — exports each published image's SBOM (SPDX JSON). */
export const SYFT_IMAGE = "anchore/syft@sha256:a2066c7d582669db5c9191ed8b8055766a63a3c231b4134a5c75e65a70f30b23";
