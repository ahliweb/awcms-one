#!/usr/bin/env bun
/**
 * Writes `dist/client/build-id.txt` (issue #24) — read at server startup by
 * `server/penyaji.mjs`'s `readBuildId()` and served at `GET /healthz` as
 * `{ ok: true, build: <id> }`.
 *
 * Runs AFTER `astro build` (`dist/client/` must already exist) and BEFORE
 * `build:penyaji` bundles the server (order doesn't matter for that half,
 * but `astro build` having run first does) — see `package.json`'s `build`
 * script.
 *
 * The id is the short git commit this build was cut from, when one is
 * available — the same identifier an operator would already use to find
 * the build in `git log`. A shallow checkout, a worktree with no `.git`
 * reachable, or `git` simply not being on `PATH` are all real states a
 * container image build can be in, so a failure to resolve one is not a
 * build error: it falls back to a timestamp-based id instead, which is
 * still enough to tell "is this a fresh deploy" apart from "is this
 * container still serving yesterday's build".
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_PATH = fileURLToPath(new URL("../dist/client/build-id.txt", import.meta.url));

function resolveBuildId() {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
    const sha = proc.stdout.toString("utf8").trim();
    if (proc.exitCode === 0 && sha.length > 0) return sha;
  } catch {
    // git not on PATH, or not a git checkout at all — fall through.
  }

  return `ts-${Date.now().toString(36)}`;
}

const buildId = resolveBuildId();

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${buildId}\n`, "utf8");

console.log(`[write-build-id] dist/client/build-id.txt = ${buildId}`);
