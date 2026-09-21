import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #112's own build smoke test — its own new file, never editing
 * #30's `checkout-build-smoke.test.ts` or #90's `akun-build-smoke.test.ts`
 * (same convention every earlier issue's own build-smoke file already
 * follows). Runs a REAL `astro build` against the stub CMS (now extended
 * with `payment.gatewayEnabled`/the payment-gateway session route) and
 * asserts: `/checkout`, `/pesanan`, and `/akun/pesanan` all still build with
 * no inline `<script>`/`<style>`; `/pesanan` and `/akun/pesanan` both ship
 * the "Bayar sekarang" button markup HIDDEN by default (issue #112's own
 * "hidden by default" requirement — a build never knows an order's live
 * state, so a page with no order loaded yet must never show this control).
 * The label text itself (`PAYMENT_LABELS.gateway`) and the payment option
 * list are rendered by `checkout.ts` from a LIVE `quoteCart` response, not
 * present in the static HTML at all — that behaviour is covered by
 * `tests/e2e/checkout.e2e.ts`'s gateway scenario, a real browser, not this
 * build-smoke file.
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

describe("build smoke: astro build against the stub CMS (issue #112's gateway payment)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "checkout/pesanan/akun-pesanan ship the gateway option and the hidden 'Bayar sekarang' control, no inline script/style",
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

        for (const file of ["checkout.html", "pesanan.html", "akun/pesanan.html"]) {
          expect(existsSync(join(distClient, file))).toBe(true);
        }

        for (const page of ["checkout.html", "pesanan.html", "akun/pesanan.html"]) {
          assertNoInlineScriptOrStyle(readFileSync(join(distClient, page), "utf8"));
        }

        // `/pesanan` and `/akun/pesanan` both ship the button, hidden — a
        // static build never knows any order's live state, so this control
        // must never render visible at build time.
        for (const page of ["pesanan.html", "akun/pesanan.html"]) {
          const html = readFileSync(join(distClient, page), "utf8");
          expect(html).toMatch(/<button[^>]*\bdata-gateway-pay\b[^>]*\bhidden\b[^>]*>Bayar sekarang<\/button>/);
          expect(html).toContain("data-gateway-status");
        }
      } finally {
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );
});
