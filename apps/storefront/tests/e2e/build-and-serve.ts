/**
 * Shared "build a real site against the stub CMS, then serve it" plumbing —
 * factored out of `global-setup.ts` (issue #183) so `scripts/screenshots-readme.mjs`
 * can reuse the exact same harness rather than re-implementing it: start the
 * stub, run a real `astro build` for the requested `SITE_PROFILE`, bundle and
 * start the preview server, and hand back a `stop()` that tears both down.
 * `global-setup.ts` is now a thin Playwright adapter over this function — see
 * its own docblock for why this app needs no `webServer` option at all.
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

export type BuiltSite = {
  previewOrigin: string;
  stop: () => Promise<void>;
};

/** Ports a caller may override — `screenshots-readme.mjs` uses the same defaults as the e2e suite so nothing else needs to change, but a caller running alongside a live `bun run test:e2e` needs its own free ports. */
export type BuildAndServeOptions = {
  previewPort?: number;
  stubPort?: number;
};

export async function buildAndServe(profile: string, options: BuildAndServeOptions = {}): Promise<BuiltSite> {
  const previewPort = options.previewPort ?? PREVIEW_PORT;
  const stubPort = options.stubPort ?? STUB_PORT;

  console.log(`[build-and-serve] building SITE_PROFILE=${profile}`);

  const previewOrigin = `http://localhost:${previewPort}`;
  const stubOrigin = `http://localhost:${stubPort}`;

  const stub = Bun.spawn(["bun", "scripts/stub-awcms.mjs"], {
    cwd: STOREFRONT_ROOT,
    env: {
      ...process.env,
      STUB_PORT: String(stubPort),
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
    // client-side runtime behaviour acts on the identical product data the
    // built pages actually rendered.
    PUBLIC_AWCMS_ORIGIN: stubOrigin,
    SITE_PROFILE: profile
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
    env: { ...process.env, PORT: String(previewPort), HOST: "127.0.0.1" },
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

  return {
    previewOrigin,
    stop: async () => {
      preview.kill();
      stub.kill();
      await Promise.all([preview.exited, stub.exited]);
    }
  };
}
