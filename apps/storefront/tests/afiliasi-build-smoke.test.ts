import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #93's own build-smoke test (S3 of #32), the same convention
 * `akun-dashboard-build-smoke.test.ts` (#90) established: a REAL
 * `astro build` against the stub CMS (whose `store-settings-public.json`
 * fixture sets `affiliateProgramEnabled: true`), asserting `/akun/afiliasi`
 * lands in `dist/client/` with `noindex`, no inline `<script>`/`<style>`,
 * exactly one `<h1>`, the enrol/link markup present (hidden by default —
 * client script decides which view to show), `BaseLayout` mounts the
 * referral-capture script on every page, and `/checkout` still builds.
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

function assertNoInlineScriptOrStyle(html: string): void {
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const isExternal = /\ssrc=/.test(attrs);
    const isJsonLd = /type=["']application\/ld\+json["']/.test(attrs);
    expect(isExternal || isJsonLd).toBe(true);
  }
  expect(html).not.toMatch(/<style[\s>]/i);
  expect(html).not.toMatch(/\sstyle="/i);
}

describe("build smoke: astro build against the stub CMS (issue #93's own page)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "produces /akun/afiliasi with noindex, no inline <script>/<style>, hidden enrol/link markup, BaseLayout mounts afiliasi-tangkap on every page, and checkout still builds",
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

        for (const file of ["akun/afiliasi.html", "checkout.html", "index.html"]) {
          expect(existsSync(join(distClient, file))).toBe(true);
        }

        const afiliasiHtml = readFileSync(join(distClient, "akun/afiliasi.html"), "utf8");
        expect(afiliasiHtml).toContain('<meta name="robots" content="noindex, follow">');
        assertNoInlineScriptOrStyle(afiliasiHtml);
        expect(afiliasiHtml.match(/<h1[^>]*>/g)?.length).toBe(1);

        // The program is ENABLED in the stub's own fixture
        // (`store-settings-public.json`'s `affiliateProgramEnabled: true`),
        // so the enrol/link markup must be present — hidden by default,
        // the client script decides which of guest/enrol/enrolled to show.
        expect(afiliasiHtml).toContain("data-akun-afiliasi-root");
        expect(afiliasiHtml).toMatch(/data-enrol-view[^>]*\bhidden\b/);
        expect(afiliasiHtml).toMatch(/data-enrolled-view[^>]*\bhidden\b/);
        expect(afiliasiHtml).toContain("data-afiliasi-gabung");
        expect(afiliasiHtml).toContain("data-afiliasi-link");
        expect(afiliasiHtml).toContain("data-afiliasi-copy");

        // BaseLayout mounts the referral-capture script on EVERY page —
        // checked on a page this issue does not otherwise touch (`/`), so
        // the assertion is about the LAYOUT, not this page specifically.
        // Astro hashes/renames every bundled script file (it does not keep
        // `afiliasi-tangkap.ts`'s own name), so this looks for the BUILT
        // chunk that carries the module's own distinctive storage-key
        // literal instead of guessing a filename.
        const homeHtml = readFileSync(join(distClient, "index.html"), "utf8");
        const baseLayoutScriptCount = (
          homeHtml.match(/BaseLayout\.astro_astro_type_script_index_\d+_lang/g) ?? []
        ).length;
        // Three: `afiliasi-tangkap` (issue #93, new), `analitik`, `ga-init`
        // — the same three `<script>` blocks `BaseLayout.astro`'s own body
        // declares.
        expect(baseLayoutScriptCount).toBe(3);

        const assetDir = join(distClient, "_astro");
        const bundledScripts = readdirSync(assetDir).filter((name) => name.endsWith(".js"));
        const carriesAfiliasiTangkap = bundledScripts.some((name) =>
          readFileSync(join(assetDir, name), "utf8").includes("awcms-one:afiliasi:v1")
        );
        expect(carriesAfiliasiTangkap).toBe(true);

        const checkoutHtml = readFileSync(join(distClient, "checkout.html"), "utf8");
        assertNoInlineScriptOrStyle(checkoutHtml);
      } finally {
        await stub.stop();
      }
    },
    TIMEOUT_MS
  );
});
