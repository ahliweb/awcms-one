import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #90's own build-smoke test (S2 of #32), the same convention
 * `akun-build-smoke.test.ts` (#88) established: a REAL `astro build` against
 * the stub CMS, asserting the three new pages land in `dist/client/`, carry
 * `noindex`, have no inline `<script>`/`<style>`, and that the built
 * checkout page's HTML contains the hidden saved-address `<select>`.
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

function assertNoInlineScriptOrStyle(html: string): void {
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const isExternal = /\ssrc=/.test(attrs);
    const isJsonLd = /type=["']application\/ld\+json["']/.test(attrs);
    expect(isExternal || isJsonLd).toBe(true);
  }
  expect(html).not.toMatch(/<style[\s>]/i);
  expect(html).not.toMatch(/\sstyle="/i);
}

describe("build smoke: astro build against the stub CMS (issue #90's own pages)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "produces /akun/alamat, /akun/pesanan, /akun/ulasan with noindex, no inline <script>/<style>, and checkout carries the hidden saved-address select",
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

        for (const file of ["akun/alamat.html", "akun/pesanan.html", "akun/ulasan.html", "checkout.html"]) {
          expect(existsSync(join(distClient, file))).toBe(true);
        }

        for (const page of ["akun/alamat.html", "akun/pesanan.html", "akun/ulasan.html"]) {
          const html = readFileSync(join(distClient, page), "utf8");
          expect(html).toContain('<meta name="robots" content="noindex, follow">');
          assertNoInlineScriptOrStyle(html);
          expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
        }

        const checkoutHtml = readFileSync(join(distClient, "checkout.html"), "utf8");
        expect(checkoutHtml).toMatch(/data-alamat-tersimpan-wrap[^>]*\bhidden\b/);
        expect(checkoutHtml).toContain("data-alamat-tersimpan");
      } finally {
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );
});
