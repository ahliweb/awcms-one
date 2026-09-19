import { describe, expect, test } from "bun:test";
import { STUB_START_DEADLINE_MS } from "./stub-deadline";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The news-surface build smoke test (issue #28) — a NEW file, per this
 * issue's own instruction to extend issue #24's build-smoke pattern rather
 * than edit `tests/build-smoke.test.ts` itself. Same structure as that
 * file: start the stub CMS (now answering the six additional fixtures this
 * issue adds — see `scripts/stub-awcms.mjs`), run a REAL `astro build`
 * against it, and assert every page family this issue adds actually lands
 * in `dist/client/`, plus the same CSP invariant (no inline `<script>`/
 * `<style>` anywhere).
 *
 * Never a false pass: if `bun` cannot be spawned at all in this
 * environment, every assertion below is SKIPPED with a clear message
 * rather than silently reporting green for a build that never ran.
 */

const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;
const TIMEOUT_MS = 60_000;

function canSpawnBun(): boolean {
  try {
    const proc = Bun.spawnSync(["bun", "--version"]);
    return proc.exitCode === 0;
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

describe("build smoke: news surface (issue #28) against the stub CMS", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "produces every news page this issue adds, with no inline <script>/<style> anywhere",
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

        // Fixture data (tests/fixtures/awcms/blog-posts.json): "Bupati Kobar
        // Resmikan Jembatan Baru" (pidana rubrik) / "DPRD Kalteng Gelar Rapat
        // Paripurna" (politik rubrik) / "Detik-Detik Kebakaran di Pasar"
        // (the video post) / "Panduan Pemilu 2024" (the legacy-redirect
        // target). Rubrik slugs from tests/fixtures/awcms/blog-terms.json.
        const expectedFiles = [
          join("berita.html"),
          join("berita", "bupati-kobar-resmikan-jembatan-baru.html"),
          join("berita", "feed.xml"),
          join("rubrik", "peristiwa.html"),
          join("rubrik", "hukum.html"),
          join("rubrik", "pidana.html"),
          join("rubrik", "politik.html"),
          join("rubrik", "peristiwa", "feed.xml"),
          join("daerah", "kotawaringin-barat.html"),
          join("daerah", "kalimantan-tengah.html"),
          join("mitra", "pemkab-kotawaringin-barat.html"),
          join("mitra", "dprd-kalimantan-tengah.html"),
          join("video.html"),
          join("video", "detik-detik-kebakaran-pasar.html"),
          join("tag", "ekonomi.html"),
          join("tag", "pilkada.html"),
          join("cari-berita.html"),
          join("index", "berita.json"),
          join("index", "pengalihan-legacy.json")
        ];

        for (const file of expectedFiles) {
          expect(existsSync(join(distClient, file))).toBe(true);
        }

        // The video post must NOT also get a plain /berita/{slug} page —
        // one canonical URL per post (src/lib/berita.ts's getPosts()
        // docblock).
        expect(existsSync(join(distClient, "berita", "detik-detik-kebakaran-pasar.html"))).toBe(false);

        // The legacy-redirect artifact actually carries the two fixture
        // mappings (tests/fixtures/awcms/seo-redirects-legacy.json).
        const legacyMap = JSON.parse(
          readFileSync(join(distClient, "index", "pengalihan-legacy.json"), "utf8")
        );
        expect(legacyMap["/news/123-panduan-pemilu-2024.html"]).toBe("/berita/panduan-pemilu-2024");
        expect(legacyMap["/2024/01/15/panduan-pemilu-2024"]).toBe("/berita/panduan-pemilu-2024");

        const htmlFiles = [
          "berita.html",
          join("berita", "bupati-kobar-resmikan-jembatan-baru.html"),
          join("video", "detik-detik-kebakaran-pasar.html"),
          join("rubrik", "peristiwa.html"),
          "cari-berita.html"
        ];

        for (const file of htmlFiles) {
          const html = readFileSync(join(distClient, file), "utf8");

          for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
            const attrs = match[1] ?? "";
            const isExternal = /\ssrc=/.test(attrs);
            const isJsonLd = /type=["']application\/ld\+json["']/.test(attrs);
            expect(isExternal || isJsonLd).toBe(true);
          }

          expect(html).not.toMatch(/<style[\s>]/i);
          expect(html).not.toMatch(/\sstyle="/i);
          // Issue #47: real media now resolves — see the per-page assertions
          // below for exactly which `<img>` each page must carry, and never
          // an `<iframe>` anywhere in server-rendered HTML (the facade only
          // ever adds one from `video-facade.ts`, after a real click).
          expect(html).not.toMatch(/<iframe[\s>]/i);
        }

        // `/berita.html`'s card for the hero post carries a real, sized
        // thumbnail (issue #47's card thumbnail — src/components/berita/
        // ArtikelCard.astro).
        const beritaIndexHtml = readFileSync(join(distClient, "berita.html"), "utf8");
        expect(beritaIndexHtml).toContain(
          "https://media.example.test/news/jembatan-kobar-hero.jpg"
        );

        // The article's own hero figure (src/components/berita/ArtikelView
        // .astro) and its body's gallery image (src/lib/portable-text.ts)
        // both resolved — proving the whole media.ts -> berita.ts ->
        // portable-text.ts chain actually ran against the stub.
        const articleHtml = readFileSync(
          join(distClient, "berita", "bupati-kobar-resmikan-jembatan-baru.html"),
          "utf8"
        );
        expect(articleHtml).toContain("https://media.example.test/news/jembatan-kobar-hero.jpg");
        expect(articleHtml).toContain(
          "https://media.example.test/news/jembatan-kobar-galeri-1.jpg"
        );
        expect(articleHtml).toContain("Humas Pemkab Kotawaringin Barat");

        // The video article renders the click-to-load facade: a real poster
        // <img> from the fixed YouTube CDN convention, the watch URL surviving
        // only as the <noscript> fallback, and no <iframe> before a click.
        const videoHtml = readFileSync(
          join(distClient, "video", "detik-detik-kebakaran-pasar.html"),
          "utf8"
        );
        expect(videoHtml).toContain("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
        expect(videoHtml).toContain(
          '<noscript><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"'
        );
        expect(videoHtml).not.toContain("<iframe");

        // A PR #65 review finding: a resolved image can live on a DIFFERENT
        // origin than the CURRENTLY CONFIGURED media-public-origin (a row
        // written before a host migration, say) — tests/fixtures/awcms/
        // media-objects.json gives the DPRD post's hero a
        // "legacy-media.example.test" URL while media-public-origin.json
        // configures "media.example.test". Both the rendered page and the
        // CSP artifact must carry the ACTUAL host, not just the configured
        // one (src/pages/csp.json.ts's own "Review finding" docblock).
        const dprdHtml = readFileSync(
          join(distClient, "berita", "dprd-kalteng-gelar-rapat-paripurna.html"),
          "utf8"
        );
        expect(dprdHtml).toContain("https://legacy-media.example.test/dprd/rapat-paripurna.jpg");

        // `/csp.json` carries the media origin, the ACTUAL resolved-image
        // origins (including the legacy one above), and the two YouTube
        // origins (issue #47) — this build has resolved images on two
        // different hosts and a video post.
        const cspArtifact = JSON.parse(
          readFileSync(join(distClient, "csp.json"), "utf8")
        );
        expect(cspArtifact.imgSrc).toContain("https://media.example.test");
        expect(cspArtifact.imgSrc).toContain("https://legacy-media.example.test");
        expect(cspArtifact.imgSrc).toContain("https://i.ytimg.com");
        expect(cspArtifact.frameSrc).toContain("https://www.youtube-nocookie.com");

        // The rubrik index renders the 3-level hierarchy: Peristiwa's own
        // page must include a post filed under its grandchild rubrik
        // (Pidana) — "the parent index includes children's posts".
        const peristiwaHtml = readFileSync(join(distClient, "rubrik", "peristiwa.html"), "utf8");
        expect(peristiwaHtml).toContain("Bupati Kobar Resmikan Jembatan Baru");

        // Issue #48's news chrome (BilahUtilitas/NavBerita/Ticker/FooterBerita,
        // via BaseLayout.astro's `header`/`footer` named slots): exactly one
        // `<head>`/one `<main id="konten">` per page — the chrome fills
        // BaseLayout.astro's slots rather than nesting a second shell inside
        // it — and no leftover store chrome (Header.astro/Footer.astro's own
        // classes) on a news page.
        const beritaHtml = readFileSync(join(distClient, "berita.html"), "utf8");
        expect(beritaHtml.match(/<head[\s>]/g)?.length).toBe(1);
        expect(beritaHtml.match(/<main id="konten"/g)?.length).toBe(1);
        expect(beritaHtml).not.toMatch(/class="site-header/);
        expect(beritaHtml).not.toMatch(/class="site-footer/);
        expect(beritaHtml).not.toMatch(/cart-link|wishlist-link/);
        expect(beritaHtml).toContain('class="nav-berita"');
        expect(beritaHtml).toContain('class="footer-berita"');

        // The Daerah panel carries all 14 Kalteng regencies-with-an-
        // institution (tests/fixtures/awcms/{blog-institutions,
        // regions-kalteng}.json) — extracted from its own wrapper so this
        // count is not polluted by the footer's OWN Daerah column, which
        // lists the same 14 a second time.
        const daerahPanel = beritaHtml.match(/<div class="nav-berita__rel-tautan">([\s\S]*?)<\/div>/);
        expect(daerahPanel).not.toBeNull();
        expect(daerahPanel![1]!.match(/href="\/daerah\//g)?.length).toBe(14);

        // The footer's Mitra Borneo directory carries all 24 institution
        // fixtures — extracted from its own wrapper so this count is not
        // polluted by `/berita`'s own "Mitra" strip (this month's active
        // institutions, a DIFFERENT, smaller list from `src/lib/berita.ts`'s
        // `getMitraStripBulanIni()`).
        const mitraDirectory = beritaHtml.match(/<div class="footer-berita__mitra">([\s\S]*?)<\/div>/);
        expect(mitraDirectory).not.toBeNull();
        expect(mitraDirectory![1]!.match(/href="\/mitra\//g)?.length).toBe(24);
      } finally {
        stub.kill();
        await stub.exited;
      }
    },
    TIMEOUT_MS
  );
});
