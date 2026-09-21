import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #30's own build smoke test — its own new file, never editing
 * #27's `tests/katalog-build-smoke.test.ts` (same rule that file's own
 * docblock names for #28's sibling). Runs a REAL `astro build` against the
 * stub CMS (now extended with the storefront commerce state machine) and
 * asserts: every page this issue adds lands in `dist/client/`, none of them
 * has an inline `<script>`/`<style>`, all four carry `noindex`, the
 * region-index build artifacts exist and are shaped correctly, and the CSP
 * artifact's `connect-src` carries the configured CMS origin.
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

describe("build smoke: astro build against the stub CMS (issue #30's own pages)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "produces /keranjang, /checkout, /pesanan, /wishlist and the wilayah index, with no inline <script>/<style> and noindex on all four",
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

        for (const file of [
          "keranjang.html",
          "checkout.html",
          "pesanan.html",
          "wishlist.html",
          join("index", "wilayah-provinsi.json"),
          join("index", "wilayah-kabupaten-62.json"),
          join("index", "wilayah-kecamatan-62.02.json"),
          "csp.json"
        ]) {
          expect(existsSync(join(distClient, file))).toBe(true);
        }

        for (const page of ["keranjang.html", "checkout.html", "pesanan.html", "wishlist.html"]) {
          const html = readFileSync(join(distClient, page), "utf8");

          expect(html).toContain('<meta name="robots" content="noindex, follow">');

          for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
            const attrs = match[1] ?? "";
            const isExternal = /\ssrc=/.test(attrs);
            const isJsonLd = /type=["']application\/ld\+json["']/.test(attrs);
            expect(isExternal || isJsonLd).toBe(true);
          }

          expect(html).not.toMatch(/<style[\s>]/i);
          expect(html).not.toMatch(/\sstyle="/i);
        }

        const provinces = JSON.parse(readFileSync(join(distClient, "index", "wilayah-provinsi.json"), "utf8"));
        expect(Array.isArray(provinces)).toBe(true);
        expect(provinces.length).toBeGreaterThan(0);
        expect(provinces[0]).toHaveProperty("code");
        expect(provinces[0]).toHaveProperty("name");

        const csp = JSON.parse(readFileSync(join(distClient, "csp.json"), "utf8"));
        expect(csp.connectSrc).toContain("https://cms.example.com");
      } finally {
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );

  test(
    "fails the build, naming the variable, when PUBLIC_AWCMS_ORIGIN is unset",
    async () => {
      const stub = await startStub();
      const stubPort = stub.port;

      try {
        const env = { ...process.env };
        delete env.PUBLIC_AWCMS_ORIGIN;

        const build = Bun.spawnSync(["bun", "--bun", "astro", "build"], {
          cwd: STOREFRONT_ROOT,
          env: {
            ...env,
            AWCMS_API_URL: `http://localhost:${stubPort}`,
            AWCMS_API_TOKEN: "stub-token",
            SITE_URL: "http://localhost:4321"
          },
          stdout: "pipe",
          stderr: "pipe"
        });

        expect(build.exitCode).not.toBe(0);
        expect(build.stderr.toString()).toContain("PUBLIC_AWCMS_ORIGIN");
      } finally {
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );
});
