import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #88's own build-smoke test, its own new file (never editing #30's
 * `checkout-build-smoke.test.ts`, the same convention that file's own
 * docblock names). Runs a REAL `astro build` against the stub CMS (now
 * extended with `/api/v1/commerce/storefront/account/*`) and asserts every
 * page this issue adds lands in `dist/client/`, carries `noindex`, has no
 * inline `<script>`/`<style>`, ships the OTP code step `hidden`, that the
 * header contains `data-akun-tautan`, and that `robots.txt` disallows the
 * three new paths.
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

describe("build smoke: astro build against the stub CMS (issue #88's own pages)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "produces /masuk, /daftar, /akun with noindex, no inline <script>/<style>, the code step hidden, and the header account link",
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

        for (const file of ["masuk.html", "daftar.html", "akun.html", "index.html", "robots.txt"]) {
          expect(existsSync(join(distClient, file))).toBe(true);
        }

        for (const page of ["masuk.html", "daftar.html", "akun.html"]) {
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

        // The OTP code step starts hidden on both /masuk and /daftar — a
        // shopper sees only the e-mail (or name/phone/e-mail) step until a
        // code has actually been sent.
        const masukHtml = readFileSync(join(distClient, "masuk.html"), "utf8");
        expect(masukHtml).toMatch(/<section data-step="code"[^>]*\bhidden\b/);

        const daftarHtml = readFileSync(join(distClient, "daftar.html"), "utf8");
        expect(daftarHtml).toMatch(/<section data-step="code"[^>]*\bhidden\b/);

        // Every page's header carries the account link — the same shared
        // `Header.astro` every page in this app renders through.
        const homeHtml = readFileSync(join(distClient, "index.html"), "utf8");
        expect(homeHtml).toContain("data-akun-tautan");

        const robotsTxt = readFileSync(join(distClient, "robots.txt"), "utf8");
        expect(robotsTxt).toContain("Disallow: /masuk");
        expect(robotsTxt).toContain("Disallow: /daftar");
        expect(robotsTxt).toContain("Disallow: /akun");
      } finally {
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );
});
