import { describe, expect, test } from "bun:test";
import { STUB_START_DEADLINE_MS } from "./stub-deadline";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The institution emblem's build smoke test (issue #59 / C1) — its OWN
 * file, per the convention every prior issue followed. Start the stub CMS,
 * run a REAL `astro build`, then inspect what landed in `dist/client/`.
 *
 * The three facts worth a real build are the three a mistake would hide:
 *
 * 1. An article filed under an institution WITH an emblem renders it, as a
 *    `<figure>` inside the body column and before the article's own text,
 *    linking to that institution's landing page.
 * 2. An article filed under an institution with NO emblem (or under none at
 *    all) renders nothing — no empty frame, no broken `<img>`.
 * 3. The institution's own `/mitra/{slug}` page shows the same emblem.
 *
 * The fixture attaches one emblem, to `i-pemkab-kobar` only
 * (`tests/fixtures/awcms/blog-institutions.json` +
 * `media-objects.json`), so one build exercises both the present and the
 * absent case on real pages.
 *
 * Never a false pass: if `bun` cannot be spawned at all in this
 * environment, the assertion is SKIPPED with a clear message rather than
 * silently reporting green for a build that never ran.
 */

const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;
const TIMEOUT_MS = 60_000;

/** Filed under `i-pemkab-kobar` — the one institution the fixture gives an emblem. */
const ARTICLE_WITH_LOGO = join("berita", "bupati-kobar-resmikan-jembatan-baru.html");
const MITRA_WITH_LOGO = join("mitra", "pemkab-kotawaringin-barat.html");
const LOGO_URL = "https://media.example.test/news/lambang-pemkab-kobar.png";

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

describe("build smoke: institution emblem (issue #59) against the stub CMS", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "renders the emblem on an article of that institution and on its landing page, and nothing where there is none",
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

        // 1. The article of the institution that HAS an emblem.
        const article = readFileSync(join(distClient, ARTICLE_WITH_LOGO), "utf8");
        const figure = article.match(/<figure class="logo-instansi">[\s\S]*?<\/figure>/)?.[0];
        expect(figure).toBeDefined();
        expect(figure).toContain(LOGO_URL);
        expect(figure).toContain('alt="Lambang Kabupaten Kotawaringin Barat"');
        expect(figure).toContain('href="/mitra/pemkab-kotawaringin-barat"');
        expect(figure).toContain('aria-label="Berita Pemkab Kotawaringin Barat"');
        // Sized, so the wrapping paragraph does not jump when it loads.
        expect(figure).toMatch(/width="240"/);
        expect(figure).toMatch(/height="240"/);
        // Inside the body column, before the article's own text.
        // `class="article-body"` since issue #49 — that column sits inside
        // `.container > .layout-with-sidebar`, so it carries no `container`
        // of its own any more.
        const bodyStart = article.indexOf('class="article-body"');
        expect(bodyStart).toBeGreaterThan(-1);
        expect(article.indexOf('class="logo-instansi"')).toBeGreaterThan(bodyStart);

        // 2. Every other article page renders no emblem at all — the
        //    fixture gives only `i-pemkab-kobar` one.
        for (const page of [
          join("berita", "dprd-kalteng-gelar-rapat-paripurna.html"),
          join("video", "detik-detik-kebakaran-pasar.html")
        ]) {
          const html = readFileSync(join(distClient, page), "utf8");
          expect(html).not.toContain("logo-instansi");
          expect(html).not.toContain(LOGO_URL);
        }

        // 3. The institution's own landing page shows the same emblem.
        const mitra = readFileSync(join(distClient, MITRA_WITH_LOGO), "utf8");
        expect(mitra).toContain('class="mitra-logo"');
        expect(mitra).toContain(LOGO_URL);

        // An institution without one renders none there either.
        const mitraTanpaLogo = readFileSync(join(distClient, "mitra", "dprd-kalimantan-tengah.html"), "utf8");
        expect(mitraTanpaLogo).not.toContain("mitra-logo");
      } finally {
        stub.kill();
        await stub.exited;
      }
    },
    TIMEOUT_MS
  );
});
