/**
 * cosign.mjs — pure argv builders for `cosign sign`/`cosign verify`, run
 * through the digest-pinned cosign container (ADR-0023).
 *
 * Two properties live here so a unit test can hold them:
 *
 *   - The key password never appears in an argv. `docker run -e NAME`
 *     (name only) makes docker copy the value from its OWN environment, so
 *     the secret is absent from `ps` output and from the "<argv> failed"
 *     message `proc.mjs`'s `runInherit` throws on a non-zero exit.
 *   - Transparency-log handling is one decision, applied to both sides:
 *     a signature is uploaded to the public Rekor log unless it was
 *     deliberately skipped, and verification skips the Rekor check ONLY
 *     when upload was skipped.
 */

import { COSIGN_IMAGE } from "./pinned-images.mjs";

const LOCAL_REGISTRY = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Whether a signature is recorded in the public Rekor transparency log.
 *
 * Default: yes for a real registry. This repository and its images are
 * public, so a Rekor entry discloses nothing new, and it makes every use
 * of the signing key publicly visible — a stolen key used to sign
 * something shows up there. Default no for a localhost registry: a
 * rehearsal's throwaway digests do not belong in a permanent public log.
 * `COSIGN_TLOG_UPLOAD=true|false` overrides either default.
 *
 * @param {{ registry: string, override?: string }} opts
 * @returns {boolean}
 */
export function shouldUploadTlog({ registry, override }) {
  if (override === "true") return true;
  if (override === "false") return false;
  if (override !== undefined && override !== "") {
    throw new Error(`COSIGN_TLOG_UPLOAD must be "true" or "false", got "${override}"`);
  }
  return !LOCAL_REGISTRY.test(registry);
}

/**
 * @param {{ keyArg: string, keyMount?: string, dockerConfig: string, ref: string, tlogUpload: boolean }} o
 * @returns {string[]}
 */
export function cosignSignArgs({ keyArg, keyMount, dockerConfig, ref, tlogUpload }) {
  // --user 0 -e HOME=/root (issue #263): the pinned cosign image's own
  // `Config.User` is 65532 with no HOME set, so a container started from it
  // never looks in /root for docker credentials — and even if it did, the
  // mounted ~/.docker/config.json is normally 0600 on the host, unreadable
  // by that uid anyway. Without this, cosign has no registry credentials
  // and `sign`/`verify` against an authenticated registry (e.g. GHCR) fail
  // with "accessing image ... UNAUTHORIZED" — after the image has already
  // been pushed unsigned. Proven 29 Sep 2026 against a local authenticated
  // registry: fails with the old argv, succeeds with --user 0 -e HOME=/root,
  // config and key both left at 0600. Trivy and syft already run as root
  // and need no such fix.
  const args = ["docker", "run", "--rm", "--network", "host", "--user", "0", "-e", "HOME=/root", "-e", "COSIGN_PASSWORD"];
  if (keyMount) args.push("-v", keyMount);
  args.push("-v", `${dockerConfig}:/root/.docker/config.json:ro`, COSIGN_IMAGE, "sign", "--key", keyArg, "--yes");
  if (!tlogUpload) args.push("--tlog-upload=false");
  args.push(ref);
  return args;
}

/**
 * @param {{ publicKeyPath: string, dockerConfig: string, ref: string, tlogUpload: boolean }} o
 * @returns {string[]}
 */
export function cosignVerifyArgs({ publicKeyPath, dockerConfig, ref, tlogUpload }) {
  // --user 0 -e HOME=/root: see cosignSignArgs's own docblock (issue #263)
  // — the same reasoning applies to verify, which reads the same mounted
  // docker config to authenticate against the registry it verifies.
  const args = [
    "docker", "run", "--rm", "--network", "host", "--user", "0", "-e", "HOME=/root",
    "-v", `${publicKeyPath}:/keys/cosign.pub:ro`,
    "-v", `${dockerConfig}:/root/.docker/config.json:ro`,
    COSIGN_IMAGE, "verify", "--key", "/keys/cosign.pub",
  ];
  if (!tlogUpload) args.push("--insecure-ignore-tlog=true");
  args.push(ref);
  return args;
}
