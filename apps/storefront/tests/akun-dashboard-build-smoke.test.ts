import { describe, expect, test } from "bun:test";
import { STUB_START_DEADLINE_MS } from "./stub-deadline";
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
const TIMEOUT_MS = 60_000;

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
      const stubPort = 47500 + Math.floor(Math.random() * 4000);
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
        stub.kill();
        await stub.exited;
      }
    },
    TIMEOUT_MS
  );
});
