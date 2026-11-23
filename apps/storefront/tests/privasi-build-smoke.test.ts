import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #529's own build-smoke test (ADR-0055), the same convention
 * `afiliasi-build-smoke.test.ts` (#93) established: a REAL `astro build`
 * against the stub CMS, asserting `/akun/privasi` lands in `dist/client/` with
 * `noindex`, no inline `<script>`/`<style>`, exactly one `<h1>`, both views
 * present and hidden by default (the client script decides which to show), the
 * export and erasure controls, the retention notice, and the side navigation of
 * the other account pages linking to it.
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

describe("build smoke: astro build against the stub CMS (issue #529's own page)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "produces /akun/privasi with noindex, no inline <script>/<style>, hidden views, the export and erasure controls and the retention notice",
    async () => {
      const distClient = join(STOREFRONT_ROOT, "dist", "client");
      rmSync(join(STOREFRONT_ROOT, "dist"), { recursive: true, force: true });

      const stub = await startStub();

      try {
        const build = Bun.spawnSync(["bun", "--bun", "astro", "build"], {
          cwd: STOREFRONT_ROOT,
          env: {
            ...process.env,
            AWCMS_API_URL: `http://localhost:${stub.port}`,
            AWCMS_API_TOKEN: "stub-token",
            SITE_URL: "http://localhost:4321",
            PUBLIC_AWCMS_ORIGIN: "https://cms.example.com",
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

        for (const file of ["akun/privasi.html", "akun.html", "akun/afiliasi.html"]) {
          expect(existsSync(join(distClient, file))).toBe(true);
        }

        const html = readFileSync(join(distClient, "akun/privasi.html"), "utf8");
        expect(html).toContain('<meta name="robots" content="noindex, follow">');
        assertNoInlineScriptOrStyle(html);
        expect(html.match(/<h1[^>]*>/g)?.length).toBe(1);

        expect(html).toContain("data-akun-privasi-root");
        expect(html).toMatch(/data-guest-view[^>]*\bhidden\b/);
        expect(html).toMatch(/data-member-view[^>]*\bhidden\b/);
        expect(html).toMatch(/data-done-view[^>]*\bhidden\b/);
        for (const hook of [
          "data-privasi-ekspor-kirim",
          "data-privasi-ekspor-unduh",
          "data-privasi-hapus-kirim",
          "data-privasi-hapus-jalankan",
          "data-privasi-hapus-paham"
        ]) {
          expect(html).toContain(hook);
        }
        // The page says what an erasure keeps; it never claims everything is deleted.
        expect(html).toContain("tetap disimpan");

        // The other account pages link to it from their side navigation.
        const dashboard = readFileSync(join(distClient, "akun.html"), "utf8");
        expect(dashboard).toContain('href="/akun/privasi"');
      } finally {
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );
});
