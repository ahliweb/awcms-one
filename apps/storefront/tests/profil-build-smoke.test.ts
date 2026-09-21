/**
 * Build smoke for the build profiles (issue #137, ADR-0018 D2/D3/D7):
 * `astro build` against the stub CMS for each profile, then assert the
 * OUTPUT — not the config — matches what `src/config/profil.ts` promises:
 *
 * - excluded groups' routes are absent from `dist/` (a `berita` build has
 *   no `produk.html`, a `landing` build has neither that nor `berita.html`)
 *   and present groups' routes are there;
 * - `sitemap-*.xml` lists no excluded route and does list the profile's
 *   own front pages;
 * - `robots.txt` carries exactly the profile's `Disallow` list;
 * - the feed documents the profile declares exist, and no other;
 * - `csp.json` widens `connect-src` to the CMS origin on every profile
 *   (the visitor beacon runs everywhere) and `frame-src` only where the
 *   news video facade can appear;
 * - the header nav and `<head>` links of a shared page (`/kontak`) belong
 *   to the profile, and every internal link on every page resolves;
 * - no inline `<script>`/`<style>` anywhere (`script-src 'self'`).
 *
 * Which profiles: `SITE_PROFILE` set → that one only (CI's matrix, D7:
 * each leg proves its own build); unset → all three in turn, so a bare
 * local `bun test` covers the whole matrix. `toko` is additionally
 * checked to be the hybrid site exactly as before this issue — every
 * page-group file appears in its `dist/`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SITE_PROFILES,
  describeProfile,
  isGroupActive,
  isSiteProfile,
  type SiteProfile
} from "../src/config/profil";
import {
  BUILD_TIMEOUT_MS,
  DIST_CLIENT,
  GROUP_FILES,
  GROUP_SITEMAP_PATHS,
  buildProfile,
  canSpawnBun,
  collectInternalLinks,
  distServes,
  excludedRoutesHit,
  listBuiltHtml,
  readDistText,
  readSitemapPaths
} from "./profil-uji-bersama";

const PROFILES_UNDER_TEST: readonly SiteProfile[] = isSiteProfile(process.env.SITE_PROFILE)
  ? [process.env.SITE_PROFILE]
  : SITE_PROFILES;

function exists(relativePath: string): boolean {
  return existsSync(join(DIST_CLIENT, relativePath));
}

describe("profil build smoke: every profile builds against the stub CMS and ships only its own groups", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  for (const profile of PROFILES_UNDER_TEST) {
    const d = describeProfile(profile);

    test(
      `SITE_PROFILE=${profile}: dist/, sitemap, robots, feeds, CSP and chrome match src/config/profil.ts`,
      async () => {
        await buildProfile(profile);

        // --- dist/: present groups' files exist, excluded groups' files do not
        for (const group of ["shared", "toko", "berita"] as const) {
          const shouldExist = isGroupActive(group, profile);
          for (const file of GROUP_FILES[group]) {
            expect(`${group}:${file}:${exists(file)}`).toBe(`${group}:${file}:${shouldExist}`);
          }
        }
        // Dynamic routes of an excluded group leave no directory behind either.
        if (!isGroupActive("toko", profile)) {
          for (const dir of ["product", "kategori", "akun"]) expect(exists(dir)).toBe(false);
        }
        if (!isGroupActive("berita", profile)) {
          for (const dir of ["berita", "rubrik", "daerah", "mitra", "tag", "penulis", "arsip", "video", "newsletter"]) {
            expect(exists(dir)).toBe(false);
          }
        }

        // --- sitemap: no excluded route, every active group's static entries present
        const sitemapPaths = readSitemapPaths();
        expect(sitemapPaths.length).toBeGreaterThan(2);
        const sitemapLeaks = sitemapPaths.filter((path) => excludedRoutesHit(path, profile).length > 0);
        expect(sitemapLeaks).toEqual([]);
        for (const group of ["shared", "toko", "berita"] as const) {
          for (const path of GROUP_SITEMAP_PATHS[group]) {
            expect(`${path}:${sitemapPaths.includes(path)}`).toBe(`${path}:${isGroupActive(group, profile)}`);
          }
        }
        // Every sitemap URL is a file this build wrote.
        expect(sitemapPaths.filter((path) => !distServes(path))).toEqual([]);

        // --- robots.txt: exactly the profile's Disallow list, in order
        const robots = readDistText("robots.txt");
        const disallowed = [...robots.matchAll(/^Disallow: (.+)$/gm)].map((m) => m[1]);
        expect(disallowed).toEqual([...d.robotsDisallow]);
        expect(robots).toContain("Sitemap: http://localhost:4321/sitemap-index.xml");

        // --- feeds: declared ones exist and are RSS; the undeclared product/posts feed does not
        for (const feed of d.feeds) {
          const xml = readDistText(feed.href.slice(1));
          expect(xml).toContain("<rss");
        }
        expect(exists("feed.xml")).toBe(d.feeds.some((feed) => feed.href === "/feed.xml"));
        expect(exists("berita/feed.xml")).toBe(d.feeds.some((feed) => feed.href === "/berita/feed.xml"));

        // --- csp.json: connect-src always carries the CMS origin; frame-src only with the news video facade
        const csp = JSON.parse(readDistText("csp.json")) as { connectSrc: string[]; frameSrc: string[]; imgSrc: string[] };
        expect(csp.connectSrc).toEqual(["https://cms.example.com"]);
        expect(csp.frameSrc.length > 0).toBe(d.csp.mediaFromBerita);
        expect(csp.imgSrc.includes("https://i.ytimg.com")).toBe(d.csp.mediaFromBerita);

        // --- chrome on a shared page: the nav, the search form, the feed link, the group stylesheet
        const kontak = readDistText("kontak.html");
        const navMatch = kontak.match(/<nav aria-label="Navigasi utama">([\s\S]*?)<\/nav>/);
        expect(navMatch).not.toBeNull();
        const navHrefs = [...(navMatch?.[1] ?? "").matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
        for (const item of d.nav) expect(navHrefs).toContain(item.href);
        for (const href of navHrefs) expect(excludedRoutesHit(href ?? "", profile)).toEqual([]);
        expect(/<form class="search-form"/.test(kontak)).toBe(d.search !== null);
        if (d.search) expect(kontak).toContain(`action="${d.search.action}"`);
        expect(/rel="alternate" type="application\/rss\+xml"/.test(kontak)).toBe(d.feeds.length > 0);
        if (d.feeds[0]) expect(kontak).toContain(`href="${d.feeds[0].href}"`);
        expect(kontak.includes('href="/product-labels.css"')).toBe(d.groupStylesheets.includes("/product-labels.css"));
        expect(kontak.includes('href="/theme-tokens.css"')).toBe(true);
        expect(/class="cart-link"/.test(kontak)).toBe(isGroupActive("toko", profile));

        // --- the home page is the profile's own variant, with exactly one <h1>
        const home = readDistText("index.html");
        expect((home.match(/<h1[\s>]/g) ?? []).length).toBe(profile === "toko" ? 0 : 1);
        if (profile === "berita") expect(home).toContain('class="nav-berita');
        if (profile === "landing") expect(home).toContain('id="landing-heading"');
        expect(home).toContain('href="#konten"');
        expect(home).toContain('<main id="konten">');

        // --- every page: internal links stay inside the profile and resolve; no inline script/style
        const excludedHits: string[] = [];
        const dead: string[] = [];
        for (const page of listBuiltHtml()) {
          const html = readDistText(page);
          for (const link of collectInternalLinks(html)) {
            if (excludedRoutesHit(link, profile).length > 0) excludedHits.push(`${page} → ${link}`);
            if (!distServes(link)) dead.push(`${page} → ${link}`);
          }
          // Attribute VALUES are blanked first: the stub's XSS fixture product
          // carries a literal `<script>` in its name, which reaches the page
          // only as escaped text inside `content="…"`/`data-*="…"` — not a
          // tag. Only real tags are judged.
          const markupOnly = html.replace(/="[^"]*"/g, '=""');
          for (const match of markupOnly.matchAll(/<script\b([^>]*)>/gi)) {
            const attrs = match[1] ?? "";
            expect(/\ssrc=/.test(attrs) || /\stype=/.test(attrs)).toBe(true);
          }
          expect(markupOnly).not.toMatch(/<style[\s>]/i);
          expect(html).not.toMatch(/\sstyle="/i);
        }
        expect(excludedHits).toEqual([]);
        expect(dead).toEqual([]);
      },
      BUILD_TIMEOUT_MS
    );
  }
});
