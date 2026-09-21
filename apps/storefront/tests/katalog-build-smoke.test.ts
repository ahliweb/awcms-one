import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The build smoke test issue #27 asks for, as its OWN new file (never
 * editing #24's `tests/build-smoke.test.ts` — same rule #28's
 * `tests/berita-build-smoke.test.ts` already follows): start the stub CMS,
 * run `astro build` against it, assert every page this issue adds actually
 * lands in `dist/client/`, and assert the CSP invariant holds on them too —
 * no inline `<script>`/`<style>` anywhere, and the detail page's JSON-LD
 * block is present.
 *
 * Never a false pass: if `bun` cannot be spawned at all, every assertion is
 * SKIPPED with a clear message rather than silently reporting green.
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

describe("build smoke: astro build against the stub CMS (issue #27's own pages)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "produces every page issue #27 adds, with no inline <script>/<style> anywhere",
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
          "produk.html",
          join("kategori", "kebutuhan-pokok.html"),
          "flash-sale.html",
          join("product", "mie-gacoan.html"),
          join("index", "produk.json")
        ];

        for (const file of expectedFiles) {
          expect(existsSync(join(distClient, file))).toBe(true);
        }

        const index = JSON.parse(readFileSync(join(distClient, "index", "produk.json"), "utf8"));
        expect(Array.isArray(index)).toBe(true);
        expect(index.length).toBeGreaterThan(0);

        const htmlFiles = [
          "index.html",
          "produk.html",
          "cari.html",
          "flash-sale.html",
          "kontak.html",
          join("kategori", "kebutuhan-pokok.html"),
          join("product", "mie-gacoan.html")
        ];

        for (const file of htmlFiles) {
          const html = readFileSync(join(distClient, file), "utf8");

          for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
            const attrs = match[1] ?? "";
            const isExternal = /\ssrc=/.test(attrs);
            const isJsonLd = /type=["']application\/ld\+json["']/.test(attrs);
            expect(isExternal || isJsonLd).toBe(true);
          }

          expect(html).not.toMatch(/<style[\s>]/i);
          expect(html).not.toMatch(/\sstyle="/i);
        }

        const productHtml = readFileSync(join(distClient, "product", "mie-gacoan.html"), "utf8");
        expect(productHtml).toContain('"@type":"Product"');
        expect(productHtml).toContain('"@type":"BreadcrumbList"');

        const categoryHtml = readFileSync(join(distClient, "kategori", "kebutuhan-pokok.html"), "utf8");
        expect(categoryHtml).toContain('"@type":"CollectionPage"');
      } finally {
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );
});
