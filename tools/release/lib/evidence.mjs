/**
 * evidence.mjs — the shape of the release-evidence JSON `bun run
 * release:images -- --publish` writes, and the pure validator
 * `tests/release-images.test.mjs` runs against it.
 *
 * One shape, declared once, so a field added to the evidence file is added
 * here and nowhere else — the same reasoning AGENTS.md's "A helper is
 * declared once" states for `packages/gerbang/lib/`.
 */

/** @typedef {{ name: string, target: string, digest: string, tags: string[] }} ImageEvidence */

/**
 * @param {object} opts
 * @param {string} opts.tag
 * @param {string} opts.sourceSha
 * @param {ImageEvidence[]} opts.images
 * @param {string[]} opts.sbomFiles - paths (relative to the evidence dir) of exported SBOM files
 * @param {{ verified: boolean, output?: string }} opts.cosign
 * @param {{ scanner: string, critical: number, high: number, failedClosed: boolean }} opts.trivy
 * @param {string} opts.builtAt - ISO-8601 timestamp
 * @param {string} opts.builder - e.g. `docker buildx v0.37.1 / BuildKit v0.33.0`
 * @returns {object} the evidence document
 */
export function buildEvidence({ tag, sourceSha, images, sbomFiles, cosign, trivy, builtAt, builder }) {
  return {
    tag,
    sourceSha,
    images,
    sbomFiles,
    cosign,
    trivy,
    builtAt,
    builder
  };
}

/**
 * @param {unknown} evidence
 * @returns {string[]} problems found; empty means the shape is valid
 */
export function validateEvidence(evidence) {
  const problems = [];
  if (typeof evidence !== "object" || evidence === null) {
    return ["evidence must be an object"];
  }
  const e = /** @type {Record<string, unknown>} */ (evidence);

  for (const key of ["tag", "sourceSha", "builtAt", "builder"]) {
    if (typeof e[key] !== "string" || e[key] === "") {
      problems.push(`"${key}" must be a non-empty string`);
    }
  }

  if (!Array.isArray(e.images) || e.images.length === 0) {
    problems.push('"images" must be a non-empty array');
  } else {
    for (const [i, image] of e.images.entries()) {
      const img = /** @type {Record<string, unknown>} */ (image);
      for (const key of ["name", "target", "digest"]) {
        if (typeof img[key] !== "string" || img[key] === "") {
          problems.push(`images[${i}].${key} must be a non-empty string`);
        }
      }
      if (!Array.isArray(img.tags) || img.tags.length === 0) {
        problems.push(`images[${i}].tags must be a non-empty array`);
      }
      if (typeof img.digest === "string" && !img.digest.startsWith("sha256:")) {
        problems.push(`images[${i}].digest must start with "sha256:", got "${img.digest}"`);
      }
    }
  }

  if (!Array.isArray(e.sbomFiles)) {
    problems.push('"sbomFiles" must be an array');
  }

  if (typeof e.cosign !== "object" || e.cosign === null || typeof (e.cosign).verified !== "boolean") {
    problems.push('"cosign.verified" must be a boolean');
  }

  if (
    typeof e.trivy !== "object" ||
    e.trivy === null ||
    typeof (e.trivy).failedClosed !== "boolean"
  ) {
    problems.push('"trivy.failedClosed" must be a boolean');
  }

  return problems;
}
