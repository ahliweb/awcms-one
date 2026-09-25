/**
 * refusal.mjs — the publish-refusal decision, as one pure function over
 * already-gathered facts.
 *
 * `tools/release/images.ts` gathers each fact (is the tree clean, is HEAD
 * the tag, is that commit an ancestor of `origin/main`, is a cosign key
 * configured) through git/filesystem/env calls that cannot be unit-tested
 * without a real checkout — but the DECISION those facts feed is plain
 * boolean logic, and that is what lives here, so
 * `tests/release-images.test.mjs` can assert on every combination without
 * touching git or the filesystem.
 */

/**
 * @param {object} facts
 * @param {boolean} facts.treeIsClean
 * @param {boolean} facts.headIsTag - HEAD is exactly the annotated/lightweight tag `vX.Y.Z`
 * @param {boolean} facts.tagIsAncestorOfMain - that tag's commit is an ancestor of `origin/main`
 * @param {boolean} facts.cosignKeyConfigured - `COSIGN_KEY` is set (and, implicitly, readable)
 * @returns {{ ok: true } | { ok: false, reasons: string[] }}
 */
export function checkPublishPreconditions(facts) {
  const reasons = [];

  if (!facts.treeIsClean) {
    reasons.push("the working tree is not clean (uncommitted or untracked changes present)");
  }
  if (!facts.headIsTag) {
    reasons.push("HEAD is not exactly the tag being published");
  }
  if (!facts.tagIsAncestorOfMain) {
    reasons.push("the tag's commit is not an ancestor of origin/main");
  }
  if (!facts.cosignKeyConfigured) {
    reasons.push(
      "no cosign signing key is configured (set COSIGN_KEY to a file path or KMS URI) — " +
        "refusing to publish an unsigned image rather than generating a production key on the fly"
    );
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
