/**
 * Issue #137 (ADR-0018 D3): "a test asserts every route a built page links
 * to belongs to the active profile."
 *
 * Builds the ACTIVE profile (`SITE_PROFILE` from the environment, default
 * `toko` — exactly what `bun run build` would do in the same shell) against
 * the stub CMS, then reads every `href`/`src`/`action` in every built
 * `.html` file and asserts:
 *
 * 1. no same-origin link falls under a route `src/config/routes.ts`
 *    assigns to a group this profile does NOT compose
 *    (`excludedRoutesHit`) — a `berita` build never links `/produk`, a
 *    `landing` build never links `/berita`;
 * 2. every same-origin link resolves to a file this build actually wrote
 *    (`distServes`) — the stronger, registry-independent form of the same
 *    property, which also catches a group-owned artifact (`/feed.xml`,
 *    `/product-labels.css`, `/index/*.json`) linked from a profile that
 *    does not build it.
 *
 * CI's storefront matrix (D7) runs this once per leg with that leg's
 * `SITE_PROFILE`; `profil-build-smoke.test.ts` runs the same scan for
 * every profile in one go when no `SITE_PROFILE` is set, so a bare local
 * `bun test` covers all three as well.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveSiteProfile } from "../src/config/profil";
import {
  BUILD_TIMEOUT_MS,
  DIST_CLIENT,
  buildProfile,
  canSpawnBun,
  collectInternalLinks,
  distServes,
  excludedRoutesHit,
  listBuiltHtml,
  readDistText
} from "./profil-uji-bersama";

const PROFILE = resolveSiteProfile(process.env.SITE_PROFILE);

describe(`profil-routes: built pages of SITE_PROFILE=${PROFILE} link only inside the profile`, () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "no built page links to an excluded route, and every internal link resolves in dist/",
    async () => {
      await buildProfile(PROFILE);

      const pages = listBuiltHtml();
      expect(pages.length).toBeGreaterThan(5);

      const excludedHits: string[] = [];
      const dead: string[] = [];
      let linksChecked = 0;

      for (const page of pages) {
        const html = readDistText(page);
        for (const link of collectInternalLinks(html)) {
          linksChecked += 1;
          const hit = excludedRoutesHit(link, PROFILE);
          if (hit.length > 0) excludedHits.push(`${page} → ${link} (${hit.join(", ")})`);
          if (!distServes(link)) dead.push(`${page} → ${link}`);
        }
      }

      // Non-vacuity: a scan that found no links at all proves nothing.
      expect(linksChecked).toBeGreaterThan(20);
      expect(excludedHits).toEqual([]);
      expect(dead).toEqual([]);
      expect(join(DIST_CLIENT, "index.html")).toBeTruthy();
    },
    BUILD_TIMEOUT_MS
  );
});
