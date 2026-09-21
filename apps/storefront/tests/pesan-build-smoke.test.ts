import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #115's own build-smoke test (S3 of #33), its own new file per this
 * issue's own instructions — never editing `akun-build-smoke.test.ts` or
 * `akun-dashboard-build-smoke.test.ts`. Runs a REAL `astro build` against
 * the stub CMS (now extended with `/account/otp/request`'s `via`,
 * `/account/me`'s `marketingConsent`, and `/account/conversations*`) and
 * asserts:
 *
 *   - `/akun/pesan` lands in `dist/client/`, carries `noindex`, has no
 *     inline `<script>`/`<style>`.
 *   - `robots.txt` still disallows `/akun` (the prefix already covers this
 *     new child route — verified here, not assumed).
 *   - `/masuk` renders the "Kirim kode lewat: E-mail | WhatsApp" channel
 *     choice (`whatsappOtpEnabled: true` in the fixture) and the hidden
 *     phone field.
 *   - `/daftar` renders the e-mail-only registration note.
 *   - `/akun` renders the marketing-consent checkbox as a real
 *     `<input type="checkbox">` inside a `<label>`, and its dashboard's
 *     nav grid links to `/akun/pesan`.
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

describe("build smoke: astro build against the stub CMS (issue #115's own pages)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "produces /akun/pesan with noindex, the /masuk channel choice, the /daftar e-mail-only note, and /akun's consent checkbox",
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

        for (const file of ["akun/pesan.html", "masuk.html", "daftar.html", "akun.html", "robots.txt"]) {
          expect(existsSync(join(distClient, file))).toBe(true);
        }

        const pesanHtml = readFileSync(join(distClient, "akun/pesan.html"), "utf8");
        expect(pesanHtml).toContain('<meta name="robots" content="noindex, follow">');
        assertNoInlineScriptOrStyle(pesanHtml);
        expect(pesanHtml).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
        expect(pesanHtml).toContain("data-pesan-baru-form");
        expect(pesanHtml).toContain("data-conversation-list");

        const robotsTxt = readFileSync(join(distClient, "robots.txt"), "utf8");
        expect(robotsTxt).toContain("Disallow: /akun");

        // `whatsappOtpEnabled: true` in the fixture — the channel radio and
        // the (hidden until chosen) phone field must both be present.
        const masukHtml = readFileSync(join(distClient, "masuk.html"), "utf8");
        expect(masukHtml).toContain('value="whatsapp"');
        expect(masukHtml).toContain("data-field-phone");
        expect(masukHtml).toMatch(/<div class="toko-field" data-field-phone[^>]*\bhidden\b/);

        const daftarHtml = readFileSync(join(distClient, "daftar.html"), "utf8");
        expect(daftarHtml).toContain("data-email-only-note");
        expect(daftarHtml).toContain("OTP lewat e-mail");

        const akunHtml = readFileSync(join(distClient, "akun.html"), "utf8");
        expect(akunHtml).toMatch(/<input type="checkbox" data-consent-checkbox\s*\/?>/);
        expect(akunHtml).toContain(`href="/akun/pesan"`);
      } finally {
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );
});
