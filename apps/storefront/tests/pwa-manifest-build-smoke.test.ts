/**
 * Build smoke for the manifest, icons and iOS install surface (issue #428):
 * a REAL `astro build` per profile against the stub CMS, then assert the
 * OUTPUT. Which profiles: `SITE_PROFILE` set -> that one only (CI matrix);
 * unset -> all three.
 *
 * - the manifest in `dist/` carries id/name/scope/start_url/display and
 *   every icon it names exists as a real PNG of the declared size;
 * - `<head>` carries the manifest link, apple-touch-icon and the iOS meta
 *   tags on every profile;
 * - flag OFF (default): no `/pasang-aplikasi` page, no link to it anywhere,
 *   no extra script, nothing in the sitemap;
 * - flag ON (`PUBLIC_INSTALL_HELP=1`): the page exists, is linked from the
 *   footer, is `noindex`, is not in the sitemap, and CSP is unchanged
 *   (same-origin script only).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_PROFILES, isSiteProfile, type SiteProfile } from "../src/config/profil";
import {
  BUILD_TIMEOUT_MS,
  DIST_CLIENT,
  buildProfile,
  canSpawnBun,
  listBuiltHtml,
  readDistText,
  readSitemapPaths
} from "./profil-uji-bersama";

const PROFILES_UNDER_TEST: readonly SiteProfile[] = isSiteProfile(process.env.SITE_PROFILE)
  ? [process.env.SITE_PROFILE]
  : SITE_PROFILES;

function pngSize(path: string): [number, number] {
  const bytes = readFileSync(path);
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

async function buildWithFlag(profile: SiteProfile, flag: string | undefined): Promise<void> {
  const original = process.env.PUBLIC_INSTALL_HELP;
  if (flag === undefined) delete process.env.PUBLIC_INSTALL_HELP;
  else process.env.PUBLIC_INSTALL_HELP = flag;
  try {
    await buildProfile(profile);
  } finally {
    if (original === undefined) delete process.env.PUBLIC_INSTALL_HELP;
    else process.env.PUBLIC_INSTALL_HELP = original;
  }
}

describe("pwa manifest build smoke", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun`", () => {});
    return;
  }

  for (const profile of PROFILES_UNDER_TEST) {
    test(
      `SITE_PROFILE=${profile}: manifest contract, real icons, iOS head tags, install help OFF adds nothing`,
      async () => {
        await buildWithFlag(profile, undefined);

        const manifest = JSON.parse(readDistText("manifest.webmanifest")) as {
          id: string;
          name: string;
          short_name: string;
          start_url: string;
          scope: string;
          display: string;
          categories: string[];
          icons: { src: string; sizes: string; type: string; purpose: string }[];
        };
        expect(manifest.id).toBe("/");
        expect(manifest.name.length).toBeGreaterThan(0);
        expect(manifest.short_name.length).toBeGreaterThan(0);
        expect(manifest.short_name.length).toBeLessThanOrEqual(12);
        expect(manifest.start_url).toBe("/");
        expect(manifest.scope).toBe("/");
        expect(manifest.display).toBe("standalone");
        expect(manifest.categories).toEqual({ toko: ["shopping"], berita: ["news"], landing: ["business"] }[profile]);

        const png = manifest.icons.filter((icon) => icon.type === "image/png");
        expect(png.map((icon) => icon.sizes).sort()).toEqual(["192x192", "512x512", "512x512"]);
        for (const icon of manifest.icons) {
          const file = join(DIST_CLIENT, icon.src.slice(1));
          expect(`${icon.src}:${existsSync(file)}`).toBe(`${icon.src}:true`);
          if (icon.type === "image/png") {
            const [w, h] = pngSize(file);
            expect(`${w}x${h}`).toBe(icon.sizes);
          }
        }
        expect(pngSize(join(DIST_CLIENT, "apple-touch-icon.png"))).toEqual([180, 180]);

        // Every page carries the manifest link, touch icon and iOS tags.
        const pages = listBuiltHtml();
        expect(pages.length).toBeGreaterThan(0);
        for (const page of pages) {
          const html = readFileSync(join(DIST_CLIENT, page), "utf8");
          if (!html.includes("<head")) continue; // redirect stubs
          expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
          expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
          expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
          expect(html).toContain('name="mobile-web-app-capable" content="yes"');
          expect(html).toContain('name="apple-mobile-web-app-status-bar-style"');
          expect(html).toContain(`name="apple-mobile-web-app-title" content="${manifest.short_name}"`);
        }

        // Flag off: no install help anywhere.
        expect(existsSync(join(DIST_CLIENT, "pasang-aplikasi"))).toBe(false);
        expect(existsSync(join(DIST_CLIENT, "pasang-aplikasi.html"))).toBe(false);
        for (const page of pages) {
          expect(readFileSync(join(DIST_CLIENT, page), "utf8")).not.toContain("pasang-aplikasi");
        }
        expect(readSitemapPaths().filter((p) => p.includes("pasang-aplikasi"))).toEqual([]);
      },
      BUILD_TIMEOUT_MS
    );
  }

  // The footer variants differ (`Footer.astro` for landing/toko chrome,
  // `FooterBerita.astro` for news pages), so the flag-ON build runs on the
  // profiles that exercise each: landing (cheapest) and berita.
  for (const profile of PROFILES_UNDER_TEST.filter((p) => p === "landing" || p === "berita")) {
    test(
      `SITE_PROFILE=${profile} with PUBLIC_INSTALL_HELP=1: page exists, is linked, noindex, off the sitemap, CSP unchanged`,
      async () => {
        await buildWithFlag(profile, "1");

        const pages = listBuiltHtml();
        const help = pages.find((p) => p === "pasang-aplikasi.html" || p === "pasang-aplikasi/index.html");
        expect(help).toBeDefined();
        const html = readFileSync(join(DIST_CLIENT, help!), "utf8");
        expect(html).toContain("<h1");
        expect(html).toContain('name="robots" content="noindex, follow"');
        expect(html).toContain("Tab browser tidak bisa menerima notifikasi");
        expect(html).toContain("Tambahkan ke Layar Utama");
        expect(html).not.toMatch(/Notification\.requestPermission|pushManager|serviceWorker/);
        // No inline script, no third-party origin.
        expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>(?!\s*<\/script>)[^<]+/);

        // Linked from a shared page's footer.
        const contact = readFileSync(join(DIST_CLIENT, pages.find((p) => p.startsWith("kontak"))!), "utf8");
        expect(contact).toContain('href="/pasang-aplikasi"');

        // ...and from the news chrome's footer where that profile has one.
        if (profile === "berita") {
          const news = pages.find((p) => p === "berita.html" || p === "berita/index.html");
          expect(news).toBeDefined();
          expect(readFileSync(join(DIST_CLIENT, news!), "utf8")).toContain('href="/pasang-aplikasi"');
        }

        expect(readSitemapPaths().filter((p) => p.includes("pasang-aplikasi"))).toEqual([]);

        // CSP artifact is exactly what it is without the page.
        const csp = JSON.parse(readDistText("csp.json")) as { connectSrc: string[] };
        expect(csp.connectSrc).toEqual(["https://cms.example.com"]);
      },
      BUILD_TIMEOUT_MS
    );
  }
});
