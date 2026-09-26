import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStub } from "./stub-lifecycle";

/**
 * issue #233 — a derived deployment that omits `--kontak-telepon`/`--alamat`
 * gets `contactPhone: null`/`address: null` in `DEFAULT_IDENTITY`
 * (`src/config/site.ts`, rewritten by `tools/template-init/rewriters.mjs`'s
 * `rewriteSiteTs`). This proves the OTHER half of that fix for real: a
 * build against a CMS that ALSO has nothing configured for these two
 * fields must render `/kontak` and the footer with no "Alamat"/phone block
 * at all — not an empty card, not the literal text "null" — rather than
 * relying on a unit test of `mergeSiteIdentity` alone, which cannot see
 * whether `src/pages/kontak.astro`/`src/components/Footer.astro` actually
 * guard the field.
 *
 * This temporarily rewrites `src/config/site.ts` and the stub's
 * `site-profile-composed.json` fixture IN PLACE — the same "build against
 * the real tree" convention every other `*-build-smoke.test.ts` file here
 * already uses (each one `rmSync`s and rebuilds the shared `dist/`
 * directory) — and restores both, byte for byte, in a `finally`, even if
 * the build itself throws.
 *
 * Never a false pass: SKIPPED with a clear message if `bun` cannot be
 * spawned at all in this environment, exactly like `build-smoke.test.ts`.
 */

const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;
const SITE_TS_PATH = join(STOREFRONT_ROOT, "src/config/site.ts");
const FIXTURE_PATH = join(STOREFRONT_ROOT, "tests/fixtures/awcms/site-profile-composed.json");
const TIMEOUT_MS = 120_000;

function canSpawnBun(): boolean {
  try {
    return Bun.spawnSync(["bun", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}

/** Replaces `DEFAULT_IDENTITY.contactPhone`/`.address` with the bare `null` literal — exactly what `rewriteSiteTs` writes when the corresponding flag is omitted. */
function withNullContactFallback(siteTs: string): string {
  let next = siteTs.replace(/contactPhone: "(?:[^"\\]|\\.)*",/, "contactPhone: null,");
  next = next.replace(/address: "(?:[^"\\]|\\.)*"/, "address: null");
  if (!next.includes("contactPhone: null,") || !next.includes("address: null")) {
    throw new Error("withNullContactFallback: expected pattern not found in src/config/site.ts — did DEFAULT_IDENTITY's shape change?");
  }
  return next;
}

describe("kontak/footer: no BjekMart-fallback address/phone block when both the CMS and DEFAULT_IDENTITY have none", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "/kontak and the footer render with no Alamat/tel: block, and no literal \"null\"",
    async () => {
      const originalSiteTs = readFileSync(SITE_TS_PATH, "utf8");
      const originalFixture = readFileSync(FIXTURE_PATH, "utf8");
      const fixture = JSON.parse(originalFixture);

      const distClient = join(STOREFRONT_ROOT, "dist", "client");
      rmSync(join(STOREFRONT_ROOT, "dist"), { recursive: true, force: true });

      let stub: Awaited<ReturnType<typeof startStub>> | undefined;
      try {
        writeFileSync(SITE_TS_PATH, withNullContactFallback(originalSiteTs));
        writeFileSync(
          FIXTURE_PATH,
          JSON.stringify({ ...fixture, editorialAddress: null, contactPhone: null }, null, 2) + "\n"
        );

        stub = await startStub();
        const stubPort = stub.port;

        const build = Bun.spawnSync(["bun", "--bun", "astro", "build"], {
          cwd: STOREFRONT_ROOT,
          env: {
            ...process.env,
            AWCMS_API_URL: `http://localhost:${stubPort}`,
            AWCMS_API_TOKEN: "stub-token",
            SITE_URL: "http://localhost:4321",
            PUBLIC_AWCMS_ORIGIN: "https://cms.example.com",
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

        for (const file of ["index.html", "kontak.html"]) {
          expect(existsSync(join(distClient, file))).toBe(true);
          const html = readFileSync(join(distClient, file), "utf8");

          // No address/phone block at all, in either the footer (every page)
          // or /kontak's own contact-card grid — not an empty card, not the
          // literal string "null" leaking through an unguarded interpolation.
          expect(html).not.toContain("Alamat");
          expect(html).not.toMatch(/href="tel:/);
          expect(html).not.toContain(">null<");

          // The e-mail card/link — always present, since --kontak-email is a
          // required flag — proves this is a targeted omission, not a build
          // that simply failed to render the identity block at all.
          expect(html).toMatch(/mailto:/);
        }
      } finally {
        if (stub) await stub.stop();
        writeFileSync(SITE_TS_PATH, originalSiteTs);
        writeFileSync(FIXTURE_PATH, originalFixture);
      }
    },
    TIMEOUT_MS
  );
});
