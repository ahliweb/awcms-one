import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #386's own build-smoke test: a REAL `astro build` of the `toko`
 * profile against the stub CMS, then the built HTML of the three booking pages.
 *
 *   - `/booking`, `/booking/pesan` and `/akun/reservasi` are written, carry
 *     `noindex`, have no inline `<script>`/`<style>`, and render their
 *     `<noscript>` fallback;
 *   - every dynamic region ships hidden or empty (the browser fills them): no
 *     price, night count or reservation is baked into the static shell;
 *   - the countdown digits are NOT in a live region, and the two announcement
 *     regions exist in the DOM before their content changes;
 *   - `robots.txt` disallows `/booking` (covering `/booking/pesan`);
 *   - the derived CSP is unchanged: `connect-src` is still exactly the CMS
 *     origin, so booking adds no origin;
 *   - none of the three pages sets `prerender = false` (the build stays static).
 *
 * The other two profiles are covered by `profil-build-smoke` / `profil-routes`:
 * a `berita` or `landing` build writes no booking file and links to none.
 *
 * Never a false pass: SKIPPED with a clear message if `bun` cannot be spawned.
 */

const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;
const TIMEOUT_MS = 120_000;
const PAGES = ["booking.html", "booking/pesan.html", "akun/reservasi.html"] as const;
const PAGE_SOURCES = [
  "src/profil/toko/pages/booking/index.astro",
  "src/profil/toko/pages/booking/pesan.astro",
  "src/profil/toko/pages/akun/reservasi.astro"
] as const;

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

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
}

describe("build smoke: the toko booking pages (issue #386)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "three static pages: noindex, no inline script or style, a no-script fallback, hidden dynamic regions, no baked-in figure, CSP unchanged",
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

        for (const file of PAGES) {
          expect(existsSync(join(distClient, file))).toBe(true);
          const html = readFileSync(join(distClient, file), "utf8");
          expect(html).toContain('<meta name="robots" content="noindex, follow">');
          expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
          expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
          expect(html).toMatch(/<noscript>/);
          assertNoInlineScriptOrStyle(html);
          // The shell bakes in no figure: nothing here is a price, a night or a reservation.
          expect(html).not.toMatch(/Rp\s?\d/);
          expect(html).not.toMatch(/\d+ malam/);
        }

        const search = readFileSync(join(distClient, "booking.html"), "utf8");
        expect(search).toMatch(/<form[^>]*data-booking-form[^>]*\bhidden\b/);
        expect(search).toContain('type="date"');
        expect(search).toContain("data-quote-panel");
        expect(search).toContain('aria-live="polite"');

        const hold = readFileSync(join(distClient, "booking/pesan.html"), "utf8");
        // Both announcement regions exist before their content changes (WCAG 4.1.3) ...
        expect(hold).toMatch(/role="status"[^>]*aria-live="polite"[^>]*data-announce/);
        expect(hold).toMatch(/role="alert"[^>]*data-announce-urgent/);
        // ... and the ticking digits are in neither of them.
        const countdown = hold.match(/<p[^>]*data-countdown[^>]*>/)?.[0] ?? "";
        expect(countdown).not.toBe("");
        expect(countdown).not.toMatch(/aria-live|role=/);
        for (const view of ["memuat", "kosong", "tidak-tersedia", "masuk", "menahan", "tahan", "berhasil", "habis"]) {
          expect(hold).toContain(`data-view="${view}"`);
        }

        const list = readFileSync(join(distClient, "akun/reservasi.html"), "utf8");
        expect(list).toContain("data-reservasi-root");
        expect(list).toMatch(/data-guest-view[^>]*\bhidden\b/);
        expect(list).toContain('href="/akun/reservasi"');

        // `/booking` also covers `/booking/pesan`; `/akun` already covers the third.
        const robots = readFileSync(join(distClient, "robots.txt"), "utf8");
        expect(robots).toContain("Disallow: /booking");
        expect(robots).toContain("Disallow: /akun");

        // The derived CSP gained no origin for booking.
        const csp = JSON.parse(readFileSync(join(distClient, "csp.json"), "utf8")) as { connectSrc: string[] };
        expect(csp.connectSrc).toEqual(["https://cms.example.com"]);

        // Client scripts are external files; the booking ones are among them.
        const scripts = walk(join(distClient, "_astro")).filter((file) => file.endsWith(".js"));
        expect(scripts.length).toBeGreaterThan(0);
      } finally {
        await stub.stop();
      }

      // The build stays static: no booking page opts out of prerendering.
      for (const source of PAGE_SOURCES) {
        expect(readFileSync(join(STOREFRONT_ROOT, source), "utf8")).not.toMatch(/prerender\s*=\s*false/);
      }
    },
    TIMEOUT_MS
  );
});
