import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #49's own build smoke test — its own new file, per the pattern
 * every prior issue followed (`berita-build-smoke.test.ts` #28,
 * `buletin-build-smoke.test.ts` #50, …): a REAL `astro build` against the
 * stub CMS, then assertions on the actual `dist/client/*` HTML for every
 * Acceptance bullet of the issue:
 *
 * - the sidebar is IDENTICAL on the article, video, rubrik, tag and search
 *   pages (byte-for-byte — same component, same data, no per-page drift);
 * - the tabbed list ships BOTH panels in the HTML, the first shown and the
 *   second `hidden`, with the real `role="tab"`/`tabpanel` contract;
 * - the three sidebar slots and the three homepage slots render when the
 *   fixture has a placement (`tests/fixtures/awcms/ad-placements-active
 *   .json` has one for each), in seputarborneo's order on `/berita`, and a
 *   slot with nothing booked (`article_bottom`) renders NO box at all;
 * - "Terpopuler" is ranked by `tests/fixtures/awcms/analytics-pages.json`,
 *   query-string variants folded, an unknown slug ignored, topped up with
 *   the newest posts;
 * - the newsletter form renders in BOTH the sidebar's box and the footer's
 *   on a sidebar page (as seputarborneo does), with distinct `id`s, and in
 *   the footer alone on a page with no sidebar — `buletin.ts`'s
 *   `wireBuletinForms` wires every one of them (`tests/buletin-forms.test.ts`);
 * - the CSP invariant every page family in this app keeps: no inline
 *   `<script>`/`<style>` (the sidebar's component-scoped styles are written
 *   out as an external file by `inlineStylesheets: "never"`).
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

/** The `<aside>` this issue's `Sidebar.astro` renders, extracted whole — `null` if the page has none. */
function extractSidebar(html: string): string | null {
  const match = /<aside class="sidebar sisi"[\s\S]*?<\/aside>/.exec(html);
  return match ? match[0] : null;
}

/** Every `data-placement` value in document order. */
function placements(html: string): string[] {
  return [...html.matchAll(/data-placement="([a-z_]+)"/g)].map((m) => m[1]!);
}

/** The `href`s inside the first element carrying `id="<id>"`, up to its closing `</ol>`/`</div>`. */
function hrefsInside(html: string, id: string, closing: string): string[] {
  const start = html.indexOf(`id="${id}"`);
  if (start === -1) return [];
  const end = html.indexOf(closing, start);
  const slice = html.slice(start, end === -1 ? undefined : end);
  return [...slice.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
}

describe("build smoke: shared news sidebar, homepage ad slots, real Terpopuler (issue #49)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "renders one identical sidebar per news page, every booked slot and no empty box, a ranked Terpopuler, and the newsletter form in sidebar and footer",
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

        const read = (file: string): string => readFileSync(join(distClient, file), "utf8");

        const sidebarPages = [
          join("berita", "bupati-kobar-resmikan-jembatan-baru.html"),
          join("video", "detik-detik-kebakaran-pasar.html"),
          join("rubrik", "peristiwa.html"),
          join("rubrik", "politik.html"),
          "video.html",
          join("tag", "ekonomi.html"),
          "cari-berita.html"
        ];

        // --- Identical on every page (byte-for-byte) -----------------------
        const sidebars = sidebarPages.map((page) => extractSidebar(read(page)));
        for (const sidebar of sidebars) expect(sidebar).not.toBeNull();
        for (const sidebar of sidebars.slice(1)) expect(sidebar).toBe(sidebars[0]!);

        // `/berita` passes `terbaruOffset={1}` (its headline is the newest
        // post), so ITS sidebar differs from the others in exactly the
        // Terbaru panel — and nowhere else.
        const beritaHtml = read("berita.html");
        const beritaSidebar = extractSidebar(beritaHtml)!;
        const newestSlug = "/berita/pengumuman-libur-nasional";
        expect(hrefsInside(sidebars[0]!, "sisi-panel-terbaru", "</ol>")[0]).toBe(newestSlug);
        expect(hrefsInside(beritaSidebar, "sisi-panel-terbaru", "</ol>")).not.toContain(newestSlug);

        // --- Tabs: both panels in the HTML, first shown, second hidden -----
        const sidebar = sidebars[0]!;
        expect(sidebar).toContain('role="tablist"');
        expect(sidebar.match(/role="tab"/g)?.length).toBe(2);
        expect(sidebar.match(/role="tabpanel"/g)?.length).toBe(2);
        expect(sidebar).toMatch(/id="sisi-tab-terbaru"[^>]*aria-selected="true"[^>]*tabindex="0"/);
        expect(sidebar).toMatch(/id="sisi-tab-mitra"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
        expect(sidebar).toMatch(/id="sisi-panel-terbaru"[^>]*aria-labelledby="sisi-tab-terbaru"(?![^>]*\shidden)/);
        expect(sidebar).toMatch(/id="sisi-panel-mitra"[^>]*aria-labelledby="sisi-tab-mitra"[^>]*\shidden/);
        // The Mitra Borneo panel is real content, not an empty shell: the two
        // fixture posts with an institution, newest first.
        expect(hrefsInside(sidebar, "sisi-panel-mitra", "</ol>")).toEqual([
          "/berita/dprd-kalteng-gelar-rapat-paripurna",
          "/berita/bupati-kobar-resmikan-jembatan-baru"
        ]);

        // --- Three sidebar slots, in seputarborneo's order, nothing empty --
        const sidebarSlots = placements(sidebar);
        expect(sidebarSlots).toEqual(["sidebar_top", "sidebar_middle", "sidebar_bottom"]);
        expect(sidebar).toContain("https://media.example.test/ads/umkm-kalteng.jpg");
        expect(sidebar).toContain("https://media.example.test/ads/rsud-doris.jpg");
        expect(sidebar).toContain("https://media.example.test/ads/tanjung-puting.jpg");
        // The Mitra Borneo directory box carries all 24 institution fixtures
        // (`getMitraList()`, the same list the footer renders).
        const mitraBox = /<section class="[^"]*sisi-mitra[^"]*"[\s\S]*?<\/section>/.exec(sidebar);
        expect(mitraBox).not.toBeNull();
        expect(mitraBox![0].match(/href="\/mitra\//g)?.length).toBe(24);

        // --- Three homepage slots, seputarborneo's order, on /berita -------
        // header_banner (issue #28) → below_headline → homepage_middle →
        // homepage_bottom → [sidebar] → homepage_bottom again above the
        // footer (FooterBerita.astro's reuse of that key, issue #48).
        expect(placements(beritaHtml)).toEqual([
          "header_banner",
          "below_headline",
          "homepage_middle",
          "homepage_bottom",
          "sidebar_top",
          "sidebar_middle",
          "sidebar_bottom",
          "homepage_bottom"
        ]);
        // `homepage_bottom` lands BEFORE the video strip.
        expect(beritaHtml.indexOf('data-placement="homepage_bottom"')).toBeLessThan(
          beritaHtml.indexOf('id="rubrik-video"')
        );

        // --- No empty box: a slot with nothing booked renders nothing ------
        const articleHtml = read(join("berita", "bupati-kobar-resmikan-jembatan-baru.html"));
        // `article_top`, `category_archive_top` and `search_result_top` are
        // the fixture's deliberately UNBOOKED slots, so an article page
        // renders neither their markup nor an empty placeholder box.
        // (`article_bottom` books one creative — issue #53's own unlinked
        // ad, added to this same fixture so its popup has a no-target case
        // to exercise — so it is a booked slot here, not an empty one.)
        expect(articleHtml).toContain('data-placement="article_middle"');
        expect(articleHtml).toContain('data-placement="article_bottom"');
        expect(articleHtml).not.toContain('data-placement="article_top"');
        expect(articleHtml).not.toContain('data-placement="category_archive_top"');
        expect(articleHtml).not.toContain('data-placement="search_result_top"');

        // --- Terpopuler: ranked by the analytics fixture -------------------
        // dprd = 73 + 22 (a `?utm_source=` variant folded in) beats bupati
        // (58) beats the video post (41, via its own /video/ URL); the
        // 180-view "/berita/tidak-pernah-terbit" names no post and is
        // ignored; the list is topped up with the two newest remaining
        // posts. The heading carries no "sorted by date" caveat either way.
        expect(hrefsInside(sidebar, "sisi-terpopuler-judul", "</ol>")).toEqual([
          "/berita/dprd-kalteng-gelar-rapat-paripurna",
          "/berita/bupati-kobar-resmikan-jembatan-baru",
          "/video/detik-detik-kebakaran-pasar",
          "/berita/pengumuman-libur-nasional",
          "/berita/kasus-pencurian-pangkalan-bun-terungkap"
        ]);
        expect(sidebar).not.toContain("tidak-pernah-terbit");

        // --- Newsletter form: sidebar AND footer on a sidebar page ---------
        // Two forms, two distinct `id` prefixes (FormBuletin's own
        // `idPrefix`), the sidebar's first in DOM order — and the one
        // BeritaLayout-mounted script that wires both of them.
        for (const page of [...sidebarPages, "berita.html"]) {
          const html = read(page);
          expect(html.match(/data-buletin-form/g)?.length).toBe(2);
          expect(html).toContain('class="buletin-form buletin-form--sidebar"');
          expect(html).toContain('class="buletin-form buletin-form--footer"');
          expect(html).toContain('id="buletin-sidebar-email"');
          expect(html).toContain('id="buletin-footer-email"');
          expect(html.indexOf("buletin-form--sidebar")).toBeLessThan(html.indexOf("buletin-form--footer"));
          // The buletin script is mounted ONCE for the whole page, however
          // many forms it carries — `BeritaLayout.astro`'s first `<script>`
          // block (`index_0`). Its second block (`index_1`) is issue #53's
          // ad-popup mount, which is why this counts that one bundle rather
          // than every script the layout emits.
          expect(
            html.match(/<script[^>]*src="\/_astro\/BeritaLayout\.astro_astro_type_script_index_0[^"]*"/g)?.length
          ).toBe(1);
        }
        for (const page of [join("daerah", "kotawaringin-barat.html"), join("mitra", "dprd-kalimantan-tengah.html")]) {
          const html = read(page);
          expect(extractSidebar(html)).toBeNull();
          expect(html.match(/data-buletin-form/g)?.length).toBe(1);
          expect(html).toContain('class="buletin-form buletin-form--footer"');
        }

        // --- CSP invariant, including the sidebar's own scoped styles -----
        for (const page of [...sidebarPages, "berita.html", join("daerah", "kotawaringin-barat.html")]) {
          const html = read(page);
          for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
            const attrs = match[1] ?? "";
            const isExternal = /\ssrc=/.test(attrs);
            const isJsonLd = /type=["']application\/ld\+json["']/.test(attrs);
            expect(isExternal || isJsonLd).toBe(true);
          }
          expect(html).not.toMatch(/<style[\s>]/i);
          expect(html).not.toMatch(/\sstyle="/i);
        }
        // The tab script and the newsletter script are both real, external
        // modules on a sidebar page — the tabs' from Sidebar.astro, the
        // form's mounted once from BeritaLayout.astro.
        expect(articleHtml).toMatch(/<script[^>]*src="\/_astro\/Sidebar\.astro[^"]*"/);
        expect(articleHtml).toMatch(/<script[^>]*src="\/_astro\/BeritaLayout\.astro[^"]*"/);
      } finally {
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );
});
