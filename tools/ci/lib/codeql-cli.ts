/**
 * codeql-cli.ts — fetching and verifying the CodeQL CLI bundle local CI
 * runs in place of `github/codeql-action`.
 *
 * The CodeQL CLI is licensed for use on open-source repositories (the
 * GitHub CodeQL Terms and Conditions) — this repository is public, so that
 * license applies here. Pinned to an exact version and verified by its own
 * published sha256 checksum (never trusted on URL alone — a release asset
 * could be replaced or the download could be tampered with in transit),
 * cached under the state directory so a re-run does not re-download ~400MB
 * every time.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { run, runOrThrow } from "./exec.ts";

/** Pinned at the version current when this leg was written (2026-09) — bump deliberately, re-verify the checksum from the release's own `.checksum.txt` asset, never take it on faith from a mirror. */
export const CODEQL_CLI_VERSION = "2.27.1";
export const CODEQL_CLI_SHA256 = "6ad2cead390cecf62dd59ae7ffd673d216902a9c00975ce107a362464a8b891e";
const DOWNLOAD_URL = `https://github.com/github/codeql-cli-binaries/releases/download/v${CODEQL_CLI_VERSION}/codeql-linux64.zip`;

export function codeqlCacheDir(stateRoot: string): string {
  return join(stateRoot, "codeql", CODEQL_CLI_VERSION);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(new Uint8Array(await Bun.file(path).arrayBuffer()));
  return hash.digest("hex");
}

/**
 * Ensure the pinned CodeQL CLI is present, verified, and extracted under
 * `stateRoot`. Returns the path to the `codeql` executable.
 */
export async function ensureCodeqlCli(stateRoot: string): Promise<string> {
  const cacheDir = codeqlCacheDir(stateRoot);
  const executable = join(cacheDir, "codeql", "codeql");
  if (existsSync(executable)) return executable;

  mkdirSync(cacheDir, { recursive: true });
  const zipPath = join(cacheDir, "codeql-linux64.zip");

  const response = await fetch(DOWNLOAD_URL);
  if (!response.ok) {
    throw new Error(`Downloading CodeQL CLI failed: ${response.status} ${DOWNLOAD_URL}`);
  }
  await Bun.write(zipPath, response);

  const actualSha256 = await sha256File(zipPath);
  if (actualSha256 !== CODEQL_CLI_SHA256) {
    throw new Error(
      `CodeQL CLI download checksum mismatch: expected ${CODEQL_CLI_SHA256}, got ${actualSha256}. ` +
        "Refusing to extract and run an unverified binary."
    );
  }

  await runOrThrow(["unzip", "-q", zipPath, "-d", cacheDir]);
  if (!existsSync(executable)) {
    throw new Error(`CodeQL CLI extracted but ${executable} is missing.`);
  }
  await run(["chmod", "+x", executable]);
  return executable;
}
