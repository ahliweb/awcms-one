import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #56 (A10)'s own build smoke test — its own new file, never editing
 * a sibling issue's (same rule `tests/checkout-build-smoke.test.ts`'s own
 * docblock names for issue #30). Runs TWO real `astro build`s against the
 * same stub CMS: the default build (no `PUBLIC_GA_ID`) must ship with no
 * Google origin anywhere; a build with `PUBLIC_GA_ID=G-TEST` must load
 * `gtag.js` from `googletagmanager.com` exactly once per page and widen the
 * served CSP for it — the acceptance criterion the issue names verbatim.
 *
 * Never a false pass: SKIPPED with a clear message if `bun` cannot be
 * spawned at all.
 */

const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;
const TIMEOUT_MS = 90_000;

function canSpawnBun(): boolean {
  try {
    return Bun.spawnSync(["bun", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}

async function waitForStub(url: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === 401 || response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`stub-awcms did not answer ${url} in time.`);
}

function runBuild(stubPort: number, extraEnv: Record<string, string | undefined>) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AWCMS_API_URL: `http://localhost:${stubPort}`,
    AWCMS_API_TOKEN: "stub-token",
    SITE_URL: "http://localhost:4321",
    PUBLIC_AWCMS_ORIGIN: "https://cms.example.com",
    ...extraEnv
  };

  return Bun.spawnSync(["bun", "--bun", "astro", "build"], {
    cwd: STOREFRONT_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe"
  });
}

function readIndexHtml(): string {
  return readFileSync(join(STOREFRONT_ROOT, "dist", "client", "index.html"), "utf8");
}

/** Every `.js` file Astro emitted under `dist/client/_astro/`. */
function readAstroBundles(): string[] {
  const dir = join(STOREFRONT_ROOT, "dist", "client", "_astro");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(dir, name), "utf8"));
}

describe("build smoke: the visitor beacon and the optional GA4 switch (issue #56)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "default build: the beacon ships, no Google origin appears anywhere",
    async () => {
      const stubPort = 49000 + Math.floor(Math.random() * 4000);
      rmSync(join(STOREFRONT_ROOT, "dist"), { recursive: true, force: true });

      const stub = Bun.spawn(["bun", "scripts/stub-awcms.mjs"], {
        cwd: STOREFRONT_ROOT,
        env: { ...process.env, STUB_PORT: String(stubPort) },
        stdout: "pipe",
        stderr: "pipe"
      });

      try {
        await waitForStub(`http://localhost:${stubPort}/api/v1/commerce/products`, Date.now() + 5000);

        const env = { ...process.env };
        delete env.PUBLIC_GA_ID;
        const build = runBuild(stubPort, env);

        if (build.exitCode !== 0) {
          throw new Error(
            `astro build exited ${build.exitCode}\n--- stdout ---\n${build.stdout.toString()}\n--- stderr ---\n${build.stderr.toString()}`
          );
        }

        const html = readIndexHtml();
        expect(html).not.toContain("googletagmanager");
        expect(html).not.toContain("google-analytics");

        // The beacon itself is unconditional — its bundled module ships
        // regardless of GA.
        const bundles = readAstroBundles();
        expect(bundles.some((source) => source.includes("/api/v1/analytics/collect"))).toBe(
          true
        );

        const csp = JSON.parse(
          readFileSync(join(STOREFRONT_ROOT, "dist", "client", "csp.json"), "utf8")
        );
        expect(csp.ga).not.toBe(true);
      } finally {
        stub.kill();
        await stub.exited;
      }
    },
    TIMEOUT_MS
  );

  test(
    "PUBLIC_GA_ID=G-TEST: gtag.js loads exactly once per page, and the served CSP is widened for it",
    async () => {
      const stubPort = 49000 + Math.floor(Math.random() * 4000);
      rmSync(join(STOREFRONT_ROOT, "dist"), { recursive: true, force: true });

      const stub = Bun.spawn(["bun", "scripts/stub-awcms.mjs"], {
        cwd: STOREFRONT_ROOT,
        env: { ...process.env, STUB_PORT: String(stubPort) },
        stdout: "pipe",
        stderr: "pipe"
      });

      try {
        await waitForStub(`http://localhost:${stubPort}/api/v1/commerce/products`, Date.now() + 5000);

        const build = runBuild(stubPort, { PUBLIC_GA_ID: "G-TEST" });

        if (build.exitCode !== 0) {
          throw new Error(
            `astro build exited ${build.exitCode}\n--- stdout ---\n${build.stdout.toString()}\n--- stderr ---\n${build.stderr.toString()}`
          );
        }

        const html = readIndexHtml();
        const occurrences = html.match(/googletagmanager/g) ?? [];
        expect(occurrences).toHaveLength(1);

        const gaScriptTag = html.match(/<script\b[^>]*googletagmanager[^>]*>/i)?.[0] ?? "";
        expect(gaScriptTag).toMatch(/\basync\b/);
        expect(gaScriptTag).toContain(
          'src="https://www.googletagmanager.com/gtag/js?id=G-TEST"'
        );
        // No inline script body anywhere this issue adds — the dataLayer
        // bootstrap is `src/scripts/ga-init.ts`, a same-origin bundled
        // module, never inlined (see that file's own docblock for why).
        expect(html).not.toContain("dataLayer");

        const csp = JSON.parse(
          readFileSync(join(STOREFRONT_ROOT, "dist", "client", "csp.json"), "utf8")
        );
        expect(csp.ga).toBe(true);
      } finally {
        stub.kill();
        await stub.exited;
      }
    },
    TIMEOUT_MS
  );
});
