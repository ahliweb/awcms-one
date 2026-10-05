import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #290 (ADR-0036 D7): a bundle product page lists "Isi paket" - its
 * components, from the CMS's public product read (no cost price, no stock
 * count) - and a standard product page does not. Built against the stub CMS
 * like every other build smoke; the page stays a static file with no inline
 * script or style.
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

describe("build smoke: the bundle product page (issue #290)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED - this environment cannot spawn `bun`", () => {});
    return;
  }

  test(
    "lists the bundle's contents; a standard product page does not",
    async () => {
      const distClient = join(STOREFRONT_ROOT, "dist", "client");
      rmSync(join(STOREFRONT_ROOT, "dist"), { recursive: true, force: true });
      const stub = await startStub();

      try {
        const build = Bun.spawnSync(["bun", "--bun", "astro", "build"], {
          cwd: STOREFRONT_ROOT,
          env: {
            ...process.env,
            AWCMS_API_URL: `http://localhost:${stub.port}`,
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
            `astro build exited ${build.exitCode}\n${build.stderr.toString()}`
          );
        }

        const bundlePage = join(distClient, "product", "paket-hemat-kopi-dan-gula.html");
        expect(existsSync(bundlePage)).toBe(true);
        const html = readFileSync(bundlePage, "utf8");
        expect(html).toContain("Isi paket");
        expect(html).toContain("2 × Kopi Arabika Kalteng 250g");
        expect(html).toContain("1 × Gula Aren Cair 500ml");
        // Contents only: never a component's stock or cost.
        expect(html).not.toContain("costPrice");

        const plain = readFileSync(join(distClient, "product", "mie-gacoan.html"), "utf8");
        expect(plain).not.toContain("Isi paket");
      } finally {
        await stub.stop();
        rmSync(join(STOREFRONT_ROOT, "dist"), { recursive: true, force: true });
      }
    },
    TIMEOUT_MS
  );
});
