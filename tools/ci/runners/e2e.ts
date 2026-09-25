/**
 * runners/e2e.ts — the `e2e-<profile>` legs, reproducing
 * `.github/workflows/e2e.yml`: `apps/storefront`'s own Playwright suite
 * under `SITE_PROFILE=<profile>`, with the report and screenshots kept
 * under this run's evidence directory instead of uploaded as a CI artifact.
 * No retries beyond what `apps/storefront/playwright.config.ts` already
 * configures.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.ts";
import type { LegContext, LegOutcome } from "../lib/types.ts";
import type { Profile } from "./check.ts";

export async function runE2eLeg(context: string, profile: Profile, ctx: LegContext): Promise<LegOutcome> {
  const start = performance.now();
  const { worktreeRoot, evidenceDir } = ctx;
  const storefrontDir = join(worktreeRoot, "apps", "storefront");
  const screenshotDir = join(evidenceDir, "screenshots");
  mkdirSync(screenshotDir, { recursive: true });

  // This leg's disposable worktree has no node_modules of its own yet —
  // matching e2e.yml's own "Install dependencies" step, run once at the
  // root for the whole workspace before Playwright itself is touched.
  const bunInstall = await run(["bun", "install", "--frozen-lockfile"], {
    cwd: worktreeRoot,
    logFile: join(evidenceDir, "bun-install.log")
  });
  if (bunInstall.exitCode !== 0) {
    return {
      context,
      ok: false,
      summary: `bun install failed (exit ${bunInstall.exitCode})`,
      durationMs: performance.now() - start,
      evidenceDir
    };
  }

  // Chromium only, matching e2e.yml's own comment: never --with-deps, which
  // needs root this host does not grant.
  const install = await run(["bun", "--bun", "playwright", "install", "chromium"], {
    cwd: storefrontDir,
    logFile: join(evidenceDir, "playwright-install.log")
  });
  if (install.exitCode !== 0) {
    return {
      context,
      ok: false,
      summary: `playwright install chromium failed (exit ${install.exitCode})`,
      durationMs: performance.now() - start,
      evidenceDir
    };
  }

  const test = await run(["bun", "run", "test:e2e"], {
    cwd: storefrontDir,
    env: {
      ...process.env,
      SITE_PROFILE: profile,
      E2E_SCREENSHOT_DIR: "test-results/screenshots"
    },
    logFile: join(evidenceDir, "playwright-test.log")
  });

  for (const [source, destName] of [
    ["playwright-report", "playwright-report"],
    ["test-results/screenshots", "screenshots"]
  ] as const) {
    const sourcePath = join(storefrontDir, source);
    if (existsSync(sourcePath)) {
      cpSync(sourcePath, join(evidenceDir, destName), { recursive: true });
    }
  }

  return {
    context,
    ok: test.exitCode === 0,
    summary:
      test.exitCode === 0
        ? `Playwright e2e green (SITE_PROFILE=${profile})`
        : `Playwright e2e failed (exit ${test.exitCode}) — report in ${evidenceDir}`,
    durationMs: performance.now() - start,
    evidenceDir
  };
}
