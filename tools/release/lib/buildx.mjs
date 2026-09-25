/**
 * buildx.mjs — pure construction of the `docker buildx build` argv this
 * tool runs, so `tests/release-images.test.mjs` can assert on the exact
 * argument list without invoking Docker.
 *
 * The one invariant every caller of {@link buildBuildxArgs} relies on:
 * `--push` is present in the returned argv if and only if `push: true` was
 * passed in. `tools/release/images.ts` never sets `push: true` unless
 * `--publish` was given on its own command line — see that file's own
 * "Refuse to publish unless..." guard — but the check that this function
 * itself never invents a `--push` belongs here, next to the code that could
 * introduce it.
 */

/**
 * @param {object} opts
 * @param {string} opts.context - build context directory, e.g. `apps/cms`
 * @param {string} opts.file - Dockerfile path, e.g. `apps/cms/Dockerfile.production`
 * @param {string} opts.target - Dockerfile build target (`runtime` | `jobs`)
 * @param {string} opts.builder - the named `docker-container` builder to use
 * @param {string[]} opts.tags - full image refs, e.g. `["ghcr.io/o/r-cms:1.2.3", ...]`
 * @param {Record<string,string>} opts.labels - OCI labels
 * @param {boolean} opts.push - whether to push after building
 * @param {string} [opts.sbomOutputDir] - when given, also writes the BuildKit
 *   SBOM attestation to this local directory (`type=local`) so it can be
 *   copied into the evidence bundle without a registry round-trip.
 * @returns {string[]} argv, WITHOUT the leading `docker buildx build`
 */
export function buildBuildxArgs({ context, file, target, builder, tags, labels, push, sbomOutputDir }) {
  if (!context || !file || !target || !builder) {
    throw new Error("buildBuildxArgs: context, file, target, and builder are all required.");
  }
  if (!Array.isArray(tags) || tags.length === 0) {
    throw new Error("buildBuildxArgs: at least one tag is required.");
  }

  const args = [
    "--builder",
    builder,
    "--file",
    file,
    "--target",
    target,
    "--provenance=mode=max",
    "--sbom=true"
  ];

  for (const tag of tags) {
    args.push("--tag", tag);
  }

  for (const [key, value] of Object.entries(labels ?? {})) {
    args.push("--label", `${key}=${value}`);
  }

  if (push) {
    args.push("--push");
  } else {
    // `--load` would fail for a multi-platform build attempt and is not
    // needed here (this tool never inspects the local image layer-by-layer
    // after a dry-run build) — a bare build-only invocation is intentional.
  }

  if (sbomOutputDir) {
    args.push("--output", `type=local,dest=${sbomOutputDir}`);
  }

  args.push(context);

  return args;
}

/**
 * The default OCI labels this tool writes, matching what
 * `docker/metadata-action` produced by default in `.github/workflows/images.yml`
 * (`org.opencontainers.image.source`, `.revision`, `.version`, `.created`,
 * `.licenses`).
 *
 * @param {object} opts
 * @param {string} opts.sourceUrl - e.g. `https://github.com/ahliweb/awcms-one`
 * @param {string} opts.revision - full commit SHA
 * @param {string} opts.version - `X.Y.Z`, no leading `v`
 * @param {string} opts.createdAt - ISO-8601 timestamp
 * @param {string} [opts.licenses] - SPDX identifier; defaults to `MIT`
 * @returns {Record<string,string>}
 */
export function ociLabels({ sourceUrl, revision, version, createdAt, licenses = "MIT" }) {
  return {
    "org.opencontainers.image.source": sourceUrl,
    "org.opencontainers.image.revision": revision,
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.created": createdAt,
    "org.opencontainers.image.licenses": licenses
  };
}
