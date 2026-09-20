import { describe, expect, test } from "bun:test";
import { STUB_START_DEADLINE_MS } from "./stub-deadline";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #109's own build smoke test — its own new file, never editing #30's
 * `tests/checkout-build-smoke.test.ts` (same rule that file's own docblock
 * follows for its siblings). Runs a REAL `astro build` against the stub CMS
 * (now pricing real courier options per district) and asserts the
 * `/checkout` shipping step's markup carries the shipping-status `aria-live`
 * region and no inline `<script>`/`<style>` — the build-time proof that
 * `checkout.ts`'s new destination/courier wiring did not smuggle in either.
 *
 * Never a false pass: SKIPPED with a clear message if `bun` cannot be
 * spawned at all.
 */

const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;
const TIMEOUT_MS = 120_000;

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

describe("build smoke: astro build against the stub CMS (issue #109's courier checkout)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "produces /checkout with the shipping aria-live status region, no inline <script>/<style>",
    async () => {
      const stubPort = 46000 + Math.floor(Math.random() * 4000);
      const distClient = join(STOREFRONT_ROOT, "dist", "client");
      rmSync(join(STOREFRONT_ROOT, "dist"), { recursive: true, force: true });

      const stub = Bun.spawn(["bun", "scripts/stub-awcms.mjs"], {
        cwd: STOREFRONT_ROOT,
        env: { ...process.env, STUB_PORT: String(stubPort) },
        stdout: "pipe",
        stderr: "pipe"
      });

      try {
        await waitForStub(`http://localhost:${stubPort}/api/v1/commerce/products`, Date.now() + STUB_START_DEADLINE_MS);

        const build = Bun.spawnSync(["bun", "--bun", "astro", "build"], {
          cwd: STOREFRONT_ROOT,
          env: {
            ...process.env,
            AWCMS_API_URL: `http://localhost:${stubPort}`,
            AWCMS_API_TOKEN: "stub-token",
            SITE_URL: "http://localhost:4321",
            PUBLIC_AWCMS_ORIGIN: "https://cms.example.com",
            // Issue #137: this test asserts the hybrid (toko) site; pin the profile so a
            // `SITE_PROFILE` in the caller's shell cannot change what it builds.
            SITE_PROFILE: "toko"
          },
          stdout: "pipe",
          stderr: "pipe"
        });

        if (build.exitCode !== 0) {
          throw new Error(
            `astro build exited ${build.exitCode}\n--- stdout ---\n${build.stdout.toString()}\n--- stderr ---\n${build.stderr.toString()}`
          );
        }

        expect(existsSync(join(distClient, "checkout.html"))).toBe(true);

        const html = readFileSync(join(distClient, "checkout.html"), "utf8");

        // The shipping step's own loading/failure announcement — present in
        // the STATIC markup (script only ever fills its text, never creates
        // the element), matching this app's "the markup works without JS"
        // rule for every runtime page.
        expect(html).toContain("data-shipping-status");
        expect(html).toMatch(/data-shipping-status[^>]*aria-live="polite"/);
        expect(html).toContain("data-shipping-options");
        expect(html).toContain('<meta name="robots" content="noindex, follow">');

        for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
          const attrs = match[1] ?? "";
          const isExternal = /\ssrc=/.test(attrs);
          const isJsonLd = /type=["']application\/ld\+json["']/.test(attrs);
          expect(isExternal || isJsonLd).toBe(true);
        }

        expect(html).not.toMatch(/<style[\s>]/i);
        expect(html).not.toMatch(/\sstyle="/i);
      } finally {
        stub.kill();
        await stub.exited;
      }
    },
    TIMEOUT_MS
  );
});
