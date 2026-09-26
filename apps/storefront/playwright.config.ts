/**
 * Playwright config for the top of this app's own testing pyramid
 * (issue #30) — a REAL browser against a REAL `bun run build` output,
 * served by this app's own preview server, talking to the extended
 * `scripts/stub-awcms.mjs` state machine. Run with `bun run test:e2e`.
 *
 * `globalSetup` (`tests/e2e/global-setup.ts`) does the heavy lifting: start
 * the stub, build the site against it with the right env, start the
 * preview server, and return a teardown that stops both — no `webServer`
 * option here, because this app cannot boot with no CMS to build against
 * (the repo's own `playwright` skill: "`webServer` only when the app can
 * boot itself with no external dependency").
 */
import { defineConfig, devices } from "@playwright/test";
import { PREVIEW_PORT } from "./tests/e2e/ports";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Under CI (`process.env.CI` set): annotations on the run itself
  // ("github" — harmless outside GitHub Actions too, since it only prints
  // a workflow-command-shaped line nothing else reads) PLUS a static HTML
  // report ("html") written to the default `playwright-report/`, which
  // `bun run ci:e2e` (`tools/ci/runners/e2e.ts`) copies into that leg's own
  // evidence directory — there is no GitHub Actions artifact upload any
  // more (issue #225, ADR-0021). `open: "never"`: a CI runner has no
  // browser to open a report in, and `bun run test:e2e` finishing must not
  // block on one either.
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PREVIEW_PORT}`,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Fallback for a host with no root (per this repo's own `playwright`
    // skill): point at the system Chrome instead of a downloaded revision.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
