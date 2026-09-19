import { describe, expect, test } from "bun:test";
import { STUB_START_DEADLINE_MS } from "./stub-deadline";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The read-aloud player's build smoke test (issue #52) — its OWN file, per
 * the convention every prior issue followed (`build-smoke.test.ts` #24,
 * `berita-build-smoke.test.ts` #28, `buletin-build-smoke.test.ts` #50,
 * `bagikan-build-smoke.test.ts` #51). Start the stub CMS, run a REAL
 * `astro build` against it, then inspect the pages that actually landed in
 * `dist/client/` for what `PemutarDengar.astro` promises — and for what it
 * must not do.
 *
 * The two facts worth a real build (rather than a unit test) are exactly
 * the two a mistake would hide:
 *
 * 1. The card ships with the `hidden` attribute IN THE HTML. If a future
 *    edit renders it visible server-side, a browser without
 *    `speechSynthesis` — or a reader with JavaScript off — gets a dead
 *    control that looks clickable. That is the failure this whole
 *    progressive-enhancement design exists to avoid, and only the built
 *    markup can prove it did not happen.
 * 2. A VIDEO post gets no player at all. `ArtikelView.astro` renders both
 *    page families, so the `!post.isVideo` guard is one boolean away from
 *    reading a video post's caption aloud beside the video itself.
 *
 * Never a false pass: if `bun` cannot be spawned at all in this
 * environment, the assertion is SKIPPED with a clear message rather than
 * silently reporting green for a build that never ran.
 */

const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;
const TIMEOUT_MS = 60_000;

const ARTICLE_PAGE = join("berita", "bupati-kobar-resmikan-jembatan-baru.html");
const VIDEO_PAGE = join("video", "detik-detik-kebakaran-pasar.html");

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

describe("build smoke: read-aloud player (issue #52) against the stub CMS", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "ships the player hidden on an article, never on a video post, with no inline <script>/<style>",
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
        await waitForStub(`http://localhost:${stubPort}/api/v1/blog/posts`, Date.now() + STUB_START_DEADLINE_MS);

        const build = Bun.spawnSync(["bun", "--bun", "astro", "build"], {
          cwd: STOREFRONT_ROOT,
          env: {
            ...process.env,
            AWCMS_API_URL: `http://localhost:${stubPort}`,
            AWCMS_API_TOKEN: "stub-token",
            SITE_URL: "http://localhost:4321",
            PUBLIC_AWCMS_ORIGIN: "https://cms.example.com"
          },
          stdout: "pipe",
          stderr: "pipe"
        });

        if (build.exitCode !== 0) {
          throw new Error(
            `astro build exited ${build.exitCode}\n--- stdout ---\n${build.stdout.toString()}\n--- stderr ---\n${build.stderr.toString()}`
          );
        }

        const article = readFileSync(join(distClient, ARTICLE_PAGE), "utf8");

        // 1. Exactly one card, and it ships hidden.
        const card = article.match(/<aside[^>]*data-dengar[^>]*>/)?.[0];
        expect(card).toBeDefined();
        expect(article.match(/data-dengar[\s=>]/g)?.length).toBeGreaterThan(0);
        expect(article.match(/<aside[^>]*data-dengar[\s>]/g)?.length).toBe(1);
        expect(card).toMatch(/\shidden[\s>]/);
        expect(card).toContain('aria-label="Dengarkan berita ini"');

        // The title the script reads first travels as an attribute, not as
        // a second copy of the <h1> the reader can see.
        expect(card).toContain('data-dengar-judul="Bupati Kobar Resmikan Jembatan Baru"');

        // Every control the three-sided contract names is present.
        for (const hook of [
          "data-dengar-putar",
          "data-dengar-ikon",
          "data-dengar-label",
          "data-dengar-sebelum",
          "data-dengar-berikut",
          "data-dengar-henti",
          "data-dengar-panel",
          "data-dengar-rate",
          "data-dengar-suara",
          "data-dengar-progres",
          "data-dengar-catatan"
        ]) {
          expect(article).toContain(hook);
        }

        // The navigation buttons ship disabled — nothing is playing yet.
        expect(article).toMatch(/data-dengar-sebelum[^>]*disabled/);
        expect(article).toMatch(/data-dengar-henti[^>]*disabled/);

        // The voice picker is hidden until a device proves it has a choice.
        expect(article).toMatch(/data-dengar-suara-wadah[^>]*hidden/);

        // 2. A video post never gets the player.
        const video = readFileSync(join(distClient, VIDEO_PAGE), "utf8");
        expect(video).not.toContain("data-dengar");

        // CSP: the player's script is an external module and its
        // stylesheet an external file — the same invariant every sibling
        // smoke test asserts, in the same shape (JSON-LD is the one
        // non-`src` script the layout is allowed to emit).
        for (const html of [article, video]) {
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
        stub.kill();
        await stub.exited;
      }
    },
    TIMEOUT_MS
  );
});
