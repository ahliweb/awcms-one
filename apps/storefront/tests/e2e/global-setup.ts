/**
 * Playwright `globalSetup` for issue #30's browser-level flow: build this
 * app against a stub CMS (with the real env this app's own `.env.example`
 * documents) and serve it, via `./build-and-serve.ts`'s shared harness — the
 * same one `scripts/screenshots-readme.mjs` (issue #183) reuses so the two
 * never drift into building the site two different ways. Runs under `bun
 * --bun playwright test` (this workspace's `test:e2e` script), so
 * `Bun.spawn`/`Bun.file` are real globals here, not a polyfill.
 *
 * No `webServer` option in `playwright.config.ts`: this app cannot boot
 * with no CMS to build against at all (ADR-0002 — everything here is baked
 * at build time), so Playwright's own "start my server" feature has
 * nothing it could do here that `build-and-serve.ts` does not already need
 * to do by hand for the STUB anyway.
 *
 * **Profile-aware (issue #183).** `SITE_PROFILE` is resolved the SAME way
 * `src/config/profil.ts`'s own `SITE_PROFILE` export resolves it — unset
 * means `toko` (today's hybrid shape, byte-for-byte what this harness
 * always built), any other recognised name builds THAT profile instead, an
 * unrecognised one fails loudly. The resolved value is passed to `astro
 * build` explicitly (rather than relying on it merely being inherited
 * through `...process.env`) so a CI log line always states which profile a
 * given run actually built, and every spec under `tests/e2e/` (existing and
 * new) reads the same resolution from `./profil-halaman` to decide which
 * pages exist to visit.
 */
import { resolveSiteProfile } from "../../src/config/profil";
import { buildAndServe } from "./build-and-serve";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const profile = resolveSiteProfile(process.env.SITE_PROFILE);
  const site = await buildAndServe(profile);
  return site.stop;
}
