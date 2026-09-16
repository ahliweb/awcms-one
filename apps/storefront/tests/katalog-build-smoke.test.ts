import { describe, expect, test } from "bun:test";
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
const TIMEOUT_MS = 55_000;

function canSpawnBun(): boolean {
  try {
    const proc = Bun.spawnSync(["bun", "--version"]);
    return proc.exitCode === 0;
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

describe("build smoke: astro build against the stub CMS (issue #27's own pages)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "produces every page issue #27 adds, with no inline <script>/<style> anywhere",
    async () => {
      const stubPort = 45000 + Math.floor(Math.random() * 4000);
      const distClient = join(STOREFRONT_ROOT, "dist", "client");
      rmSync(join(STOREFRONT_ROOT, "dist"), { recursive: true, force: true });

      const stub = Bun.spawn(["bun", "scripts/stub-awcms.mjs"], {
        cwd: STOREFRONT_ROOT,
        env: { ...process.env, STUB_PORT: String(stubPort) },
        stdout: "pipe",
        stderr: "pipe"
      });

      try {
        await waitForStub(`http://localhost:${stubPort}/api/v1/commerce/products`, Date.now() + 5000);

        const build = Bun.spawnSync(["bun", "--bun", "astro", "build"], {
          cwd: STOREFRONT_ROOT,
          env: {
            ...process.env,
            AWCMS_API_URL: `http://localhost:${stubPort}`,
            AWCMS_API_TOKEN: "stub-token",
            SITE_URL: "http://localhost:4321"
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
        stub.kill();
        await stub.exited;
      }
    },
    TIMEOUT_MS
  );
});
