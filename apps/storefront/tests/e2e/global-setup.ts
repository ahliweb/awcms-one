/**
 * Playwright `globalSetup` for issue #30's browser-level flow: start the
 * stub CMS, build this app against it (with the real env this app's own
 * `.env.example` documents), start the built site's own preview server,
 * and return a teardown that stops both. Runs under `bun --bun playwright
 * test` (this workspace's `test:e2e` script), so `Bun.spawn`/`Bun.file` are
 * real globals here, not a polyfill.
 *
 * No `webServer` option in `playwright.config.ts`: this app cannot boot
 * with no CMS to build against at all (ADR-0002 — everything here is baked
 * at build time), so Playwright's own "start my server" feature has
 * nothing it could do here that this file does not already need to do by
 * hand for the STUB anyway.
 */
import { PREVIEW_PORT, STUB_PORT } from "./ports";

const STOREFRONT_ROOT = new URL("../../", import.meta.url).pathname;

async function waitForHttp(url: string, deadlineMs: number, description: string): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${description} did not answer ${url} within ${deadlineMs}ms.`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const previewOrigin = `http://localhost:${PREVIEW_PORT}`;
  const stubOrigin = `http://localhost:${STUB_PORT}`;

  const stub = Bun.spawn(["bun", "scripts/stub-awcms.mjs"], {
    cwd: STOREFRONT_ROOT,
    env: {
      ...process.env,
      STUB_PORT: String(STUB_PORT),
      // The one Origin the anonymous storefront commerce routes answer —
      // must equal wherever the BUILT site is about to be served from
      // (below), matching the real cross-origin contract those routes
      // implement.
      STUB_ALLOWED_ORIGIN: previewOrigin
    },
    stdout: "ignore",
    stderr: "inherit"
  });

  await waitForHttp(`${stubOrigin}/api/v1/commerce/products`, 5_000, "stub-awcms");

  const buildEnv = {
    ...process.env,
    AWCMS_API_URL: stubOrigin,
    AWCMS_API_TOKEN: "e2e-stub-token",
    SITE_URL: previewOrigin,
    // The browser calls the CMS directly (ADR-0007 revised) — pointed at
    // the SAME stub the build itself just read the catalog from, so
    // "add to cart" and "check out" act on the identical product data the
    // built pages actually rendered.
    PUBLIC_AWCMS_ORIGIN: stubOrigin
  };

  const build = Bun.spawnSync(["bun", "--bun", "astro", "build"], {
    cwd: STOREFRONT_ROOT,
    env: buildEnv,
    stdout: "pipe",
    stderr: "pipe"
  });

  if (build.exitCode !== 0) {
    stub.kill();
    throw new Error(
      `astro build exited ${build.exitCode}\n--- stdout ---\n${build.stdout.toString()}\n--- stderr ---\n${build.stderr.toString()}`
    );
  }

  const buildId = Bun.spawnSync(["bun", "scripts/write-build-id.mjs"], { cwd: STOREFRONT_ROOT, env: buildEnv });
  if (buildId.exitCode !== 0) {
    stub.kill();
    throw new Error("scripts/write-build-id.mjs failed.");
  }

  const bundlePenyaji = Bun.spawnSync(
    ["bun", "build", "server/penyaji.mjs", "--target=bun", "--outfile", "dist/server/penyaji.mjs"],
    { cwd: STOREFRONT_ROOT, env: buildEnv }
  );
  if (bundlePenyaji.exitCode !== 0) {
    stub.kill();
    throw new Error("Bundling server/penyaji.mjs failed.");
  }

  const preview = Bun.spawn(["bun", "dist/server/penyaji.mjs"], {
    cwd: STOREFRONT_ROOT,
    env: { ...process.env, PORT: String(PREVIEW_PORT), HOST: "127.0.0.1" },
    stdout: "ignore",
    stderr: "inherit"
  });

  try {
    await waitForHttp(`${previewOrigin}/healthz`, 5_000, "preview server");
  } catch (error) {
    stub.kill();
    preview.kill();
    throw error;
  }

  return async () => {
    preview.kill();
    stub.kill();
    await Promise.all([preview.exited, stub.exited]);
  };
}
