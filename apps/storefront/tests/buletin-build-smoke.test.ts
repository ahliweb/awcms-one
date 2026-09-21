import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #50's own build smoke test — its own new file, following the same
 * pattern `checkout-build-smoke.test.ts` (#30) established: a REAL
 * `astro build` against the stub CMS, asserting every page this issue adds
 * lands in `dist/client/`, carries no inline `<script>`/`<style>`, and that
 * the two token pages carry `noindex`. No newsletter endpoint needs stubbing
 * — unlike cart/checkout, nothing on `/buletin`, `/newsletter/confirm`, or
 * `/newsletter/unsubscribe` is fetched at BUILD time; the form/token pages
 * only ever call the CMS from the BROWSER (`src/scripts/buletin.ts`). The
 * stub is still required because `BaseLayout.astro` itself fetches site
 * identity and static pages for every page in this app, this issue's three
 * included.
 *
 * `/newsletter/confirm` and `/newsletter/unsubscribe` are a CMS-imposed path
 * contract (`NEWSLETTER_CONFIRM_PATH`/`NEWSLETTER_UNSUBSCRIBE_PATH`,
 * `apps/cms/src/modules/newsletter/domain/newsletter-mail.ts`), not this
 * app's own `/buletin/*` naming — see `tests/newsletter-path-contract.test.ts`
 * for the string-literal guard and `apps/storefront/README.md`'s
 * "Newsletter" section for the rest of the story.
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

describe("build smoke: astro build against the stub CMS (issue #50's own pages)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "produces /buletin, /newsletter/confirm, /newsletter/unsubscribe, with no inline <script>/<style> and noindex on the two token pages",
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

        for (const file of [
          "buletin.html",
          join("newsletter", "confirm.html"),
          join("newsletter", "unsubscribe.html")
        ]) {
          expect(existsSync(join(distClient, file))).toBe(true);
        }

        const buletinHtml = readFileSync(join(distClient, "buletin.html"), "utf8");
        expect(buletinHtml).not.toContain('name="robots"');

        for (const page of [join("newsletter", "confirm.html"), join("newsletter", "unsubscribe.html")]) {
          const html = readFileSync(join(distClient, page), "utf8");
          expect(html).toContain('<meta name="robots" content="noindex, follow">');

          // The state-changing action must NOT fire on page load (a mail
          // gateway's link-scanner fetches and often fully renders/executes
          // JS on every e-mail link before the reader sees it — an eager
          // POST would let the SCANNER confirm/unsubscribe, not the reader;
          // see buletin.ts's own `wireTokenPage` docblock). The static HTML
          // must therefore ship the action as an inert, `hidden` button —
          // `buletin.ts` only unhides and wires it once a well-formed token
          // is found client-side, and only a real click sends the request.
          expect(html).toContain('data-buletin-action hidden');
        }

        for (const page of [
          "buletin.html",
          join("newsletter", "confirm.html"),
          join("newsletter", "unsubscribe.html")
        ]) {
          const html = readFileSync(join(distClient, page), "utf8");

          for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
            const attrs = match[1] ?? "";
            const isExternal = /\ssrc=/.test(attrs);
            const isJsonLd = /type=["']application\/ld\+json["']/.test(attrs);
            expect(isExternal || isJsonLd).toBe(true);
          }

          expect(html).not.toMatch(/<style[\s>]/i);
          expect(html).not.toMatch(/\sstyle="/i);
        }

        const robotsTxt = readFileSync(join(distClient, "robots.txt"), "utf8");
        expect(robotsTxt).toContain("Disallow: /newsletter/confirm");
        expect(robotsTxt).toContain("Disallow: /newsletter/unsubscribe");
        expect(robotsTxt).not.toContain("Disallow: /buletin\n");
      } finally {
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );
});
