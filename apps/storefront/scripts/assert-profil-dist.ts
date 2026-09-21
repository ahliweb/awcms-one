#!/usr/bin/env bun
/**
 * Deterministic post-build assertion over an ALREADY-BUILT `dist/client` —
 * issue #147.
 *
 * `.github/workflows/template-init-smoke.yml`'s matrix leg already runs a
 * real `SITE_PROFILE=<profile> bun run build` (`astro build`) as its own
 * step; this script re-checks THAT build's output against
 * `src/config/profil.ts`'s promises — the same properties
 * `tests/profil-build-smoke.test.ts` and `tests/profil-routes.test.ts`
 * prove — WITHOUT building a second time. Those two test files each call
 * `buildProfile()` (`tests/profil-uji-bersama.ts`), which starts its own
 * stub CMS and runs its own `astro build`; running them here, on top of the
 * workflow's own build step, would double this job's build load for no
 * reason (the exact kind of contention issue #147 exists to remove) — and
 * `ci.yml`'s own 3-leg `Check` matrix already runs those two test files for
 * real, on every push, as the authoritative proof of the exclusion
 * invariant. This job's OWN scope (issue #138) is narrower: prove a
 * `template:init`-initialised checkout still builds AND ships the right
 * shape per profile — a cheap re-check of the build this job already paid
 * for, not a second independent proof.
 *
 * Usage: `SITE_PROFILE=<toko|berita|landing> bun scripts/assert-profil-dist.ts`
 * (unset `SITE_PROFILE` defaults to `toko`, same as a plain `bun run build`).
 * Exits non-zero with every failing check listed, never a partial silent
 * pass.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isGroupActive, resolveSiteProfile } from "../src/config/profil";
import {
  DIST_CLIENT,
  GROUP_FILES,
  GROUP_SITEMAP_PATHS,
  collectInternalLinks,
  distServes,
  excludedRoutesHit,
  listBuiltHtml,
  readDistText,
  readSitemapPaths
} from "../tests/profil-uji-bersama";

const profile = resolveSiteProfile(process.env.SITE_PROFILE);
const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function exists(relativePath: string): boolean {
  return existsSync(join(DIST_CLIENT, relativePath));
}

if (!existsSync(DIST_CLIENT)) {
  console.error(
    `assert-profil-dist (SITE_PROFILE=${profile}): ${DIST_CLIENT} does not exist — run \`bun run build\` first.`
  );
  process.exit(1);
}

// --- dist/: present groups' representative files exist, excluded groups' do not
for (const group of ["shared", "toko", "berita"] as const) {
  const shouldExist = isGroupActive(group, profile);
  for (const file of GROUP_FILES[group]) {
    check(exists(file) === shouldExist, `${group}:${file} exists=${exists(file)}, expected ${shouldExist}`);
  }
}
// Dynamic routes of an excluded group leave no directory behind either.
if (!isGroupActive("toko", profile)) {
  for (const dir of ["product", "kategori", "akun"]) {
    check(!exists(dir), `toko:${dir}/ should not exist when the toko group is excluded`);
  }
}
if (!isGroupActive("berita", profile)) {
  for (const dir of ["berita", "rubrik", "daerah", "mitra", "tag", "penulis", "arsip", "video", "newsletter"]) {
    check(!exists(dir), `berita:${dir}/ should not exist when the berita group is excluded`);
  }
}

// --- sitemap: no excluded route, every active group's static entries present
const sitemapPaths = readSitemapPaths();
check(sitemapPaths.length > 2, `sitemap-*.xml carried only ${sitemapPaths.length} <loc> entries — expected more than 2`);
const sitemapLeaks = sitemapPaths.filter((path) => excludedRoutesHit(path, profile).length > 0);
check(sitemapLeaks.length === 0, `sitemap-*.xml leaks excluded route(s): ${sitemapLeaks.join(", ")}`);
for (const group of ["shared", "toko", "berita"] as const) {
  for (const path of GROUP_SITEMAP_PATHS[group]) {
    const present = sitemapPaths.includes(path);
    const shouldBePresent = isGroupActive(group, profile);
    check(present === shouldBePresent, `sitemap ${path} present=${present}, expected ${shouldBePresent} (group ${group})`);
  }
}
const sitemapDead = sitemapPaths.filter((path) => !distServes(path));
check(sitemapDead.length === 0, `sitemap-*.xml lists a URL this build did not write: ${sitemapDead.join(", ")}`);

// --- every built page: internal links stay inside the profile and resolve
const excludedHits: string[] = [];
const dead: string[] = [];
for (const page of listBuiltHtml()) {
  const html = readDistText(page);
  for (const link of collectInternalLinks(html)) {
    if (excludedRoutesHit(link, profile).length > 0) excludedHits.push(`${page} → ${link}`);
    if (!distServes(link)) dead.push(`${page} → ${link}`);
  }
}
check(excludedHits.length === 0, `built page(s) link to an excluded route:\n    ${excludedHits.join("\n    ")}`);
check(dead.length === 0, `built page(s) link to a route this build did not write:\n    ${dead.join("\n    ")}`);

if (failures.length > 0) {
  console.error(
    `assert-profil-dist (SITE_PROFILE=${profile}): ${failures.length} check(s) failed:\n` +
      failures.map((message) => `  - ${message}`).join("\n")
  );
  process.exit(1);
}

console.log(`assert-profil-dist (SITE_PROFILE=${profile}): dist/client matches src/config/profil.ts — ${sitemapPaths.length} sitemap entries, ${listBuiltHtml().length} built pages checked.`);
