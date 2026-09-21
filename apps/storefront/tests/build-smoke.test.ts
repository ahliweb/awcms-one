import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The build smoke test issue #24 asks for: start the stub CMS, run
 * `astro build` against it, assert the pages this issue adds actually land
 * in `dist/client/`, and assert the CSP invariant (`script-src '"self"'`
 * `style-src 'self'`, `server/penyaji.mjs`) holds — no inline `<script>` or
 * `<style>` anywhere in the built HTML.
 *
 * Never a false pass: if `bun` cannot be spawned at all in this
 * environment, every assertion below is SKIPPED with a clear message
 * (`test.skip`) rather than silently reporting green for a build that never
 * ran. A `bun` that spawns but exits non-zero is a real failure and fails
 * this test loudly.
 */

const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;
const TIMEOUT_MS = 120_000;

function canSpawnBun(): boolean {
  try {
    const proc = Bun.spawnSync(["bun", "--version"]);
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

describe("build smoke: astro build against the stub CMS", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "produces every page issue #24 adds, with no inline <script>/<style> anywhere",
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

        const expectedFiles = [
          "index.html",
          "kontak.html",
          "cari.html",
          "404.html",
          "robots.txt",
          "sitemap-index.xml",
          "sitemap-1.xml",
          "feed.xml",
          "manifest.webmanifest",
          "theme-tokens.css",
          join("halaman", "panduan-belanja.html")
        ];

        for (const file of expectedFiles) {
          expect(existsSync(join(distClient, file))).toBe(true);
        }

        const htmlFiles = ["index.html", "kontak.html", "cari.html", "404.html", join("halaman", "panduan-belanja.html")];
        for (const file of htmlFiles) {
          const html = readFileSync(join(distClient, file), "utf8");

          // Every <script ...> opening tag must either point at an external,
          // Astro-bundled file (`src=`) or be a JSON-LD DATA block
          // (`type="application/ld+json"`, BaseLayout.astro) — never
          // executable inline JS, per `script-src 'self'`
          // (`server/penyaji.mjs`).
          for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
            const attrs = match[1] ?? "";
            const isExternal = /\ssrc=/.test(attrs);
            const isJsonLd = /type=["']application\/ld\+json["']/.test(attrs);
            expect(isExternal || isJsonLd).toBe(true);
          }

          expect(html).not.toMatch(/<style[\s>]/i);
          expect(html).not.toMatch(/\sstyle="/i);
        }
      } finally {
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );
});
