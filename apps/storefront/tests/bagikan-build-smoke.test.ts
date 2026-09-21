import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The share row's build smoke test (issue #51) — its OWN file, per the
 * convention every prior issue followed (`build-smoke.test.ts` #24,
 * `berita-build-smoke.test.ts` #28, `buletin-build-smoke.test.ts` #50)
 * rather than an edit to any of them. Same structure: start the stub CMS,
 * run a REAL `astro build` against it, then inspect the article page that
 * actually landed in `dist/client/` for what `BarisBagikan.astro` promises
 * in its docblock — and for what it must NOT ship.
 *
 * The stub's `site-profile-composed.json` fixture carries an Instagram link
 * and a `javascript:` link, and NO TikTok/YouTube — so this build is the
 * "follow links hidden when unset" case end to end, on a real page, with a
 * real `identity.socialLinks` round-trip through `parseSocialLinks` and
 * `resolveFollowLinks`. The configured case is covered by
 * `tests/bagikan.test.ts` against the same resolver.
 *
 * Never a false pass: if `bun` cannot be spawned at all in this
 * environment, the assertion below is SKIPPED with a clear message rather
 * than silently reporting green for a build that never ran.
 */

const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;
const TIMEOUT_MS = 120_000;

/** A fixture article (`tests/fixtures/awcms/blog-posts.json`) and the video post — both render through `ArtikelView.astro`. */
const ARTICLE_PAGE = join("berita", "bupati-kobar-resmikan-jembatan-baru.html");
const VIDEO_PAGE = join("video", "detik-detik-kebakaran-pasar.html");

function canSpawnBun(): boolean {
  try {
    const proc = Bun.spawnSync(["bun", "--version"]);
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

describe("build smoke: article share row (issue #51) against the stub CMS", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "renders the seven-control row on every ArtikelView page, with no third-party script and no inline <script>/<style>",
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

        for (const page of [ARTICLE_PAGE, VIDEO_PAGE]) {
          const html = readFileSync(join(distClient, page), "utf8");

          // The row itself, once — a group with an accessible name.
          expect(html.match(/data-bagikan[\s>]/g)?.length).toBe(1);
          expect(html).toContain('aria-label="Bagikan berita ini dan ikuti kami"');

          // The four real share links, each a full-URL intent and `nofollow`.
          const canonical = `http://localhost:4321/${page.replace(/\.html$/, "").replace(/\\/g, "/")}`;
          const encodedUrl = encodeURIComponent(canonical);
          expect(html).toContain(`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`);
          expect(html).toContain(`https://twitter.com/intent/tweet?url=${encodedUrl}&amp;text=`);
          expect(html).toContain(`https://wa.me/?text=`);
          expect(html).toContain(`https://www.threads.net/intent/post?text=`);
          for (const label of ["Bagikan ke Facebook", "Bagikan ke X", "Bagikan ke WhatsApp", "Bagikan ke Threads"]) {
            expect(html).toContain(`aria-label="${label}"`);
          }
          expect(html.match(/rel="noopener nofollow"/g)?.length).toBe(4);

          // Instagram: a real <button>, present regardless of the site
          // profile (the fixture HAS an Instagram link, and the button must
          // not point at it — it is a share control, not a follow link),
          // shipped `hidden` for `bagikan.ts` to reveal.
          const instagramButton = html.match(/<button[^>]*data-bagikan-instagram[^>]*>/)?.[0];
          expect(instagramButton).toBeDefined();
          expect(instagramButton).toContain('aria-label="Bagikan ke Instagram"');
          expect(instagramButton).toContain(` data-url="${canonical}"`);
          expect(instagramButton).toMatch(/\shidden[\s>]/);
          expect(instagramButton).not.toContain("instagram.com/bjekmart");

          // Follow links: the fixture configures no TikTok/YouTube, so none
          // render — and the fixture's `javascript:` link never reaches an href.
          expect(html).not.toContain("Ikuti kami di TikTok");
          expect(html).not.toContain("Ikuti kami di YouTube");
          expect(html).not.toContain('rel="noopener me"');
          expect(html).not.toContain("javascript:");

          // The aria-live status region ships in the static HTML, empty.
          expect(html).toMatch(/<p class="baris-bagikan__status" role="status" aria-live="polite" data-bagikan-status><\/p>/);

          // The pre-#51 two-link block is gone.
          expect(html).not.toContain('class="article-share"');

          // No third-party share SDK/widget anywhere on the page.
          for (const host of ["connect.facebook.net", "platform.twitter.com", "platform.x.com", "instagram.com/embed.js"]) {
            expect(html).not.toContain(host);
          }

          // The CSP invariant: every <script> is external (or JSON-LD), no
          // inline <style>/style="" — the share row's own module included.
          for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
            const attrs = match[1] ?? "";
            const isExternal = /\ssrc=/.test(attrs);
            const isJsonLd = /type=["']application\/ld\+json["']/.test(attrs);
            expect(isExternal || isJsonLd).toBe(true);
          }
          expect(html).not.toMatch(/<style[\s>]/i);
          expect(html).not.toMatch(/\sstyle="/i);
        }
      } finally {
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );
});
