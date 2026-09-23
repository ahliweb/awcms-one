#!/usr/bin/env bun
/**
 * Regenerates the screenshots a README (`README.md`/`README.id.md`, or a
 * derived template's own) would embed — deterministically, from the SAME
 * harness `tests/e2e/screenshots.e2e.ts` already runs in CI (issue #183):
 * `tests/e2e/build-and-serve.ts` builds one profile against the stub CMS
 * and serves it, then Playwright walks that profile's key pages
 * (`tests/e2e/profil-halaman.ts`) and writes a full-page PNG per page per
 * viewport (360px mobile, 1280px desktop — the same two widths
 * `responsif.e2e.ts` checks for overflow).
 *
 * This script does not itself pick which shots a README embeds — that
 * curation is the issue that actually wires images into `README.md`
 * (tracked separately; this script only needs to exist and produce
 * deterministic output for it to consume, per issue #183's own scope). It
 * exists so that a maintainer, or a future CI step, never has to hand-drive
 * a browser to refresh those images: run this, look in the output
 * directory below, pick what is needed.
 *
 * Usage:
 *
 *   bun run screenshots:readme                  # SITE_PROFILE=toko (default)
 *   bun run screenshots:readme -- --profil berita
 *   bun run screenshots:readme -- --profil landing
 *
 * Three optional flags, passed straight through to `screenshots.e2e.ts` as
 * the env vars its own docblock describes (issue #189, the README's own
 * above-the-fold crops):
 *
 *   bun run screenshots:readme -- --profil toko --pages home --viewport desktop --above-fold
 *
 *   --pages <name,name,...>   only these KEY_PAGES names (default: all)
 *   --viewport <mobile|desktop|mobile,desktop>  only these viewports (default: both)
 *   --above-fold              crop to the viewport instead of the full page
 *
 * Output: `E2E_SCREENSHOT_DIR` (default `test-results/screenshots-readme`),
 * one PNG per key page per viewport at `<dir>/<profile>/<page>-<viewport>.png`
 * — the exact layout `tests/e2e/screenshots.e2e.ts` itself writes, since
 * this script runs that same spec file. `test-results/` is gitignored
 * (`apps/storefront/../.gitignore`'s `apps/storefront/test-results/` line);
 * nothing this script writes is ever committed by running it.
 */
import { parseArgs } from "node:util";
import { SITE_PROFILES } from "../src/config/profil";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    profil: { type: "string", default: "toko" },
    pages: { type: "string" },
    viewport: { type: "string" },
    "above-fold": { type: "boolean", default: false }
  },
  strict: true
});

const profile = values.profil;
if (!SITE_PROFILES.includes(profile)) {
  console.error(`--profil must be one of: ${SITE_PROFILES.join(", ")} (got "${profile}").`);
  process.exit(1);
}

const outputDir = process.env.E2E_SCREENSHOT_DIR ?? "test-results/screenshots-readme";
console.log(`[screenshots-readme] SITE_PROFILE=${profile} -> ${outputDir}/${profile}/`);

const run = Bun.spawnSync(["bun", "--bun", "playwright", "test", "tests/e2e/screenshots.e2e.ts"], {
  cwd: new URL("../", import.meta.url).pathname,
  env: {
    ...process.env,
    SITE_PROFILE: profile,
    E2E_SCREENSHOT_DIR: outputDir,
    ...(values.pages ? { E2E_SCREENSHOT_PAGES: values.pages } : {}),
    ...(values.viewport ? { E2E_SCREENSHOT_VIEWPORTS: values.viewport } : {}),
    ...(values["above-fold"] ? { E2E_SCREENSHOT_FULLPAGE: "false" } : {})
  },
  stdout: "inherit",
  stderr: "inherit"
});

process.exit(run.exitCode ?? 1);
