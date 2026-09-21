import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
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

describe("build smoke: astro build against the stub CMS (issue #109's courier checkout)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "produces /checkout with the shipping aria-live status region, no inline <script>/<style>",
    async () => {
      const distClient = join(STOREFRONT_ROOT, "dist", "client");
      rmSync(join(STOREFRONT_ROOT, "dist"), { recursive: true, force: true });

      const stub = await startStub();
      const stubPort = stub.port;

      try {
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
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );
});
