---
bump: minor
type: structure
impact: public
---

# Publish `apps/cms`'s runtime/jobs images to GHCR, with SBOM and provenance

Every production deploy re-ran `bun install --frozen-lockfile` and a full `apps/cms`
build on the machine serving traffic, with nothing attestable behind the tag a
rollback would name. `apps/cms/Dockerfile.production`'s `runtime` and `jobs`
targets are content-independent — a pure function of a commit, unlike the
storefront's own image, which bakes a tenant's live catalog/news content at
build time using the CMS owner token as a BuildKit secret. That asymmetry is
why only the CMS images are published here (see [ADR-0020](../docs/adr/0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md)
for the full reasoning and the rejected alternatives — publishing the
storefront too, a runtime-building storefront container, a third-party
registry).

- `.github/workflows/images.yml` (new, not a required check) builds both
  targets and, on a `v*` tag push or an explicit `workflow_dispatch` with its
  `push` input checked, publishes `ghcr.io/<owner>/<repo>-cms` and
  `-cms-jobs` — semver + sha tags, an SBOM, and a provenance attestation
  verifiable with `gh attestation verify`. It builds (never pushes) on a
  `pull_request` touching `apps/cms/**`/`apps/storefront/**`/
  `compose.production.yaml`, and separately proves `apps/storefront/Dockerfile`
  still builds, per `SITE_PROFILE`, against this repo's own stub CMS.
- `compose.production.yaml`'s `cms`/`jobs`/`migrate` services read their
  image name from `AWCMS_ONE_CMS_IMAGE`/`AWCMS_ONE_CMS_JOBS_IMAGE`, defaulting
  to today's local-build names — an operator can now point a deployment at a
  published tag instead of building on the deploy host, or change nothing.
- `docs/deployment.md` gains a "Published images" section (pulling via the
  new env vars, verifying the attestation/SBOM, GHCR package visibility) and
  corrects a stale "not built" note that pre-dated this pipeline; `AGENTS.md`'s
  "Not here yet" list is updated the same way. ADR-0019 itself is left
  untouched — it is cited from ADR-0020, not amended.
