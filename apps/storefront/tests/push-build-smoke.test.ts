/**
 * Build smoke for customer Web Push (issue #431, ADR-0048 section 7): a REAL
 * `astro build` per profile against the stub CMS, then assert the OUTPUT.
 * Which profiles: `SITE_PROFILE` set -> that one only (the CI matrix); unset ->
 * all three.
 *
 * - flag OFF (default) on `toko`: no worker file, no `/akun/notifikasi`, no
 *   account card, no reference in any page, and no Push API in any script an
 *   ordinary page loads (the dormant `push-alur` chunk is only fetched by a
 *   browser that already carries an enrolment marker);
 * - flag ON on `toko`: the worker is emitted VERBATIM at the fixed URL, the
 *   settings page exists (`noindex`, no inline script/style, off the sitemap),
 *   `/akun` carries a hidden card, and the CSP artifact is unchanged
 *   (first-party only: `worker-src` falls back to `'self'`);
 * - flag ON on `berita` / `landing` (no customer accounts): nothing is emitted -
 *   the flag is ignored there, with a warning.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SITE_PROFILES, isSiteProfile, type SiteProfile } from "../src/config/profil";
import {
  BUILD_TIMEOUT_MS,
  DIST_CLIENT,
  STOREFRONT_ROOT,
  buildProfile,
  canSpawnBun,
  listBuiltHtml,
  listFiles,
  readDistText,
  readSitemapPaths
} from "./profil-uji-bersama";

const PROFILES_UNDER_TEST: readonly SiteProfile[] = isSiteProfile(process.env.SITE_PROFILE)
  ? [process.env.SITE_PROFILE]
  : SITE_PROFILES;

const WORKER_SOURCE = join(STOREFRONT_ROOT, "src/push/pekerja/sw-notifikasi.js");

async function buildWithFlag(profile: SiteProfile, flag: string | undefined): Promise<void> {
  const original = process.env.PUBLIC_CUSTOMER_PUSH;
  if (flag === undefined) delete process.env.PUBLIC_CUSTOMER_PUSH;
  else process.env.PUBLIC_CUSTOMER_PUSH = flag;
  try {
    await buildProfile(profile);
  } finally {
    if (original === undefined) delete process.env.PUBLIC_CUSTOMER_PUSH;
    else process.env.PUBLIC_CUSTOMER_PUSH = original;
  }
}

function pageExists(name: string): boolean {
  return existsSync(join(DIST_CLIENT, `${name}.html`)) || existsSync(join(DIST_CLIENT, name, "index.html"));
}

/**
 * The lazily loaded chunk of the push flows (`push-alur`, imported with a
 * dynamic `import()` by the header's safety net and the sign-out path). It exists
 * in EVERY build - it is what cleans up a browser that enabled notifications on a
 * build that later switched the feature off - but it is only ever fetched when
 * the enrolment marker exists, so "flag off" is judged on everything else.
 */
const DORMANT_CHUNK = /^_astro\/push-alur\.[A-Za-z0-9_-]+\.js$/;

/** Every file in `dist/client` that is text we can search. */
function builtText(): Array<[string, string]> {
  return listFiles(DIST_CLIENT)
    .filter((f) => /\.(html|js|css|json|xml|txt|webmanifest)$/.test(f))
    .map((f): [string, string] => [f, readFileSync(join(DIST_CLIENT, f), "utf8")]);
}

function assertNoInlineScriptOrStyle(html: string): void {
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    expect(/\ssrc=/.test(attrs) || /type=["']application\/ld\+json["']/.test(attrs)).toBe(true);
  }
  expect(html).not.toMatch(/<style[\s>]/i);
  expect(html).not.toMatch(/\sstyle="/i);
}

describe("customer push build smoke", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED - this environment cannot spawn `bun`", () => {});
    return;
  }

  if (PROFILES_UNDER_TEST.includes("toko")) {
    test(
      "SITE_PROFILE=toko, flag OFF (the default): no worker, no page, no card, no reference, no Push API on ordinary pages",
      async () => {
        await buildWithFlag("toko", undefined);

        expect(existsSync(join(DIST_CLIENT, "sw-notifikasi.js"))).toBe(false);
        expect(pageExists("akun/notifikasi")).toBe(false);

        // The account page is the same as before, apart from the (always present, hidden) sign-out recovery block.
        const akun = readDistText("akun.html");
        expect(akun).not.toContain("data-notif-kartu");
        expect(akun).not.toContain("/akun/notifikasi");
        expect(akun).toContain("data-keluar-gagal");

        for (const [file, text] of builtText()) {
          if (DORMANT_CHUNK.test(file)) continue;
          expect(`${file}:${/sw-notifikasi|akun\/notifikasi/.test(text)}`).toBe(`${file}:false`);
        }
        expect(readSitemapPaths().filter((p) => p.includes("notifikasi"))).toEqual([]);

        // An ordinary page loads no script that can use the Push API or ask for a permission.
        const home = readDistText("index.html");
        for (const match of home.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
          const script = readDistText(match[1]!.slice(1));
          expect(`${match[1]}:${/pushManager|requestPermission|serviceWorker/.test(script)}`).toBe(`${match[1]}:false`);
        }
      },
      BUILD_TIMEOUT_MS
    );

    test(
      "SITE_PROFILE=toko, PUBLIC_CUSTOMER_PUSH=1: the worker verbatim at its fixed URL, the settings page, a hidden card, CSP unchanged",
      async () => {
        await buildWithFlag("toko", "1");

        // The worker: byte-identical to the reviewed source, nothing interpolated.
        const worker = readFileSync(join(DIST_CLIENT, "sw-notifikasi.js"), "utf8");
        expect(worker).toBe(readFileSync(WORKER_SOURCE, "utf8"));
        expect(worker).not.toMatch(/addEventListener\(\s*["']fetch["']/);

        // It is served from the site root, not from a hashed asset path.
        expect(listFiles(join(DIST_CLIENT, "_astro")).filter((f) => f.includes("sw-notifikasi"))).toEqual([]);

        // The settings page.
        expect(pageExists("akun/notifikasi")).toBe(true);
        const page = readDistText(existsSync(join(DIST_CLIENT, "akun/notifikasi.html")) ? "akun/notifikasi.html" : "akun/notifikasi/index.html");
        expect(page).toContain("<h1");
        expect(page).toContain('name="robots" content="noindex, follow"');
        expect(page).toContain("data-notif-root");
        for (const panel of [
          "memuat", "tamu", "disembunyikan", "diblokir", "belum_verifikasi", "server_nonaktif", "tidak_didukung",
          "ios_pasang", "ios_lama", "izin_ditolak", "aktifkan", "aktif", "perangkat"
        ]) {
          expect(page).toContain(`data-panel="${panel}"`);
        }
        // Every panel but the loading one starts hidden: the control is not there until the CMS says so.
        for (const match of page.matchAll(/<section[^>]*data-panel="([a-z_]+)"[^>]*>/g)) {
          if (match[1] !== "memuat") expect(`${match[1]}:${/\shidden[\s>=]/.test(match[0])}`).toBe(`${match[1]}:true`);
        }
        // iOS guidance names the 16.4 requirement and the Add to Home Screen step.
        expect(page).toContain("16.4");
        expect(page).toContain("Tambahkan ke Layar Utama");
        // The opt-in is a submit button inside a form: no auto-start, no inline handler.
        expect(page).toContain("data-notif-aktifkan");
        expect(page).not.toMatch(/\sonclick=|\sonload=|javascript:/i);
        expect(page).not.toMatch(/requestPermission|pushManager/);
        assertNoInlineScriptOrStyle(page);

        // `/akun` carries the card, hidden until the CMS reports the capability.
        const akun = readDistText("akun.html");
        expect(akun).toMatch(/<div[^>]*data-notif-kartu[^>]*\shidden/);
        expect(akun).toContain('href="/akun/notifikasi"');
        assertNoInlineScriptOrStyle(akun);

        // Not in the sitemap, not in the navigation, not linked from anywhere else.
        expect(readSitemapPaths().filter((p) => p.includes("notifikasi"))).toEqual([]);
        for (const file of listBuiltHtml()) {
          if (file === "akun.html" || file.startsWith("akun/notifikasi")) continue;
          expect(`${file}:${readDistText(file).includes("/akun/notifikasi")}`).toBe(`${file}:false`);
        }

        // CSP artifact is exactly what it is without the feature: first-party plus the CMS origin.
        const csp = JSON.parse(readDistText("csp.json")) as { connectSrc: string[]; imgSrc?: string[] };
        expect(csp.connectSrc).toEqual(["https://cms.example.com"]);

        // The Push API appears only in the one chunk the settings page and the sign-out path load on demand.
        const withApi = builtText()
          .filter(([f]) => f.startsWith("_astro/") && f.endsWith(".js"))
          .filter(([, text]) => /pushManager/.test(text))
          .map(([f]) => f);
        expect(withApi.length).toBeGreaterThan(0);
        const home = readDistText("index.html");
        for (const file of withApi) {
          expect(`${file}:${home.includes(file.slice("_astro/".length))}`).toBe(`${file}:false`);
        }
      },
      BUILD_TIMEOUT_MS
    );
  }

  for (const profile of PROFILES_UNDER_TEST.filter((p) => p !== "toko")) {
    test(
      `SITE_PROFILE=${profile}, PUBLIC_CUSTOMER_PUSH=1: no customer accounts, so no worker, no page, no card`,
      async () => {
        await buildWithFlag(profile, "1");

        expect(existsSync(join(DIST_CLIENT, "sw-notifikasi.js"))).toBe(false);
        expect(pageExists("akun/notifikasi")).toBe(false);
        expect(pageExists("akun")).toBe(false);
        for (const [file, text] of builtText()) {
          if (DORMANT_CHUNK.test(file)) continue;
          expect(`${file}:${/sw-notifikasi|akun\/notifikasi/.test(text)}`).toBe(`${file}:false`);
        }
        expect(readdirSync(DIST_CLIENT).includes("sw-notifikasi.js")).toBe(false);
      },
      BUILD_TIMEOUT_MS
    );
  }
});
