import { describe, expect, test } from "bun:test";
import { startStub } from "./stub-lifecycle";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The served-site proof for issue #75: `GET /berita`, `/video` and
 * `/rubrik/<slug>` answer 200 through the REAL bundled server
 * (`dist/server/penyaji.mjs`, the exact process `bun run serve` starts) —
 * not through `createServer` with a stub app handler, which is what every
 * other `penyaji*` test uses and which cannot see the adapter's own
 * directory-before-file decision this issue is about.
 *
 * Same shape as the other `*-build-smoke.test.ts` files: start the stub
 * CMS, run a REAL `astro build` against it; then, the part only this file
 * does, mirror `tests/e2e/global-setup.ts`'s remaining steps — write the
 * build id, bundle the server, spawn it on a free port — and make plain
 * HTTP requests. Ownership per the issue: the served pipeline, not the
 * e2e spec.
 *
 * Never a false pass: if `bun` cannot be spawned at all in this
 * environment, the assertions are SKIPPED with a clear message rather than
 * silently reporting green for a server that never ran.
 */

const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;
const TIMEOUT_MS = 120_000;

function canSpawnBun(): boolean {
  try {
    const proc = Bun.spawnSync(["bun", "--version"]);
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function waitForHttp(url: string, deadline: number, description: string): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description} did not answer ${url} in time.`);
}

describe("build smoke: the bundled server serves directory-shadowed pages (issue #75)", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "/berita, /video and /rubrik/<slug> answer 200; their children still 200; the trailing-slash form still 301s",
    async () => {
      const servePort = 49000 + Math.floor(Math.random() * 4000);
      rmSync(join(STOREFRONT_ROOT, "dist"), { recursive: true, force: true });

      const stub = await startStub();
      const stubPort = stub.port;

      let served: ReturnType<typeof Bun.spawn> | undefined;

      try {
        const buildEnv = {
          ...process.env,
          AWCMS_API_URL: `http://localhost:${stubPort}`,
          AWCMS_API_TOKEN: "stub-token",
          SITE_URL: "http://localhost:4321",
          PUBLIC_AWCMS_ORIGIN: "https://cms.example.com",
          // Issue #137: this test asserts the hybrid (toko) site; pin the profile so a
          // `SITE_PROFILE` in the caller's shell cannot change what it builds.
          SITE_PROFILE: "toko"
        };

        const build = Bun.spawnSync(["bun", "--bun", "astro", "build"], {
          cwd: STOREFRONT_ROOT,
          env: buildEnv,
          stdout: "pipe",
          stderr: "pipe"
        });
        if (build.exitCode !== 0) {
          throw new Error(
            `astro build exited ${build.exitCode}\n--- stdout ---\n${build.stdout.toString()}\n--- stderr ---\n${build.stderr.toString()}`
          );
        }

        // The rest of `bun run build`, exactly as `package.json` chains it —
        // the bundled file is what `bun run serve` runs, and what production
        // runs, so it is the file under test.
        const buildId = Bun.spawnSync(["bun", "scripts/write-build-id.mjs"], { cwd: STOREFRONT_ROOT, env: buildEnv });
        expect(buildId.exitCode).toBe(0);
        const bundle = Bun.spawnSync(
          ["bun", "build", "server/penyaji.mjs", "--target=bun", "--outfile", "dist/server/penyaji.mjs"],
          { cwd: STOREFRONT_ROOT, env: buildEnv, stdout: "pipe", stderr: "pipe" }
        );
        if (bundle.exitCode !== 0) {
          throw new Error(`bundling server/penyaji.mjs exited ${bundle.exitCode}\n${bundle.stderr.toString()}`);
        }

        served = Bun.spawn(["bun", "dist/server/penyaji.mjs"], {
          cwd: STOREFRONT_ROOT,
          env: { ...process.env, PORT: String(servePort), HOST: "127.0.0.1" },
          stdout: "pipe",
          stderr: "pipe"
        });
        const origin = `http://127.0.0.1:${servePort}`;
        await waitForHttp(`${origin}/healthz`, Date.now() + 5000, "dist/server/penyaji.mjs");

        // The precondition this whole issue rests on: the build really does
        // emit the page as a file WITH a same-named directory beside it. If
        // a future Astro/adapter change stops doing that, this fails here,
        // naming the reason, rather than the assertions below passing for a
        // reason that no longer exists.
        const clientDir = join(STOREFRONT_ROOT, "dist", "client");
        for (const shape of ["berita", "video", join("rubrik", "peristiwa")]) {
          expect(existsSync(join(clientDir, `${shape}.html`))).toBe(true);
          expect(statSync(join(clientDir, shape)).isDirectory()).toBe(true);
        }

        // The defect: 404 before this issue, on every one of these.
        for (const path of ["/berita", "/video", "/rubrik/peristiwa"]) {
          const response = await fetch(`${origin}${path}`, { redirect: "manual" });
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toContain("text/html");
          expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
          const html = await response.text();
          expect(html).toContain("<!DOCTYPE html>");
        }

        // The rewrite is internal — a reader's URL never changes, and the
        // served document is the landing page, not a child.
        const berita = await (await fetch(`${origin}/berita`)).text();
        expect(berita).toContain('rel="canonical" href="http://localhost:4321/berita"');

        // Children are untouched (they were never broken).
        for (const path of ["/berita/bupati-kobar-resmikan-jembatan-baru", "/video/detik-detik-kebakaran-pasar"]) {
          const response = await fetch(`${origin}${path}`, { redirect: "manual" });
          expect(response.status).toBe(200);
        }

        // The trailing-slash form keeps the adapter's own 301 to the bare
        // path — the acceptance criterion the issue names verbatim.
        for (const path of ["/berita/", "/video/", "/rubrik/peristiwa/"]) {
          const response = await fetch(`${origin}${path}`, { redirect: "manual" });
          expect(response.status).toBe(301);
          expect(response.headers.get("location")).toBe(path.slice(0, -1));
        }

        // And a plain miss is still a 404 — the rewrite fires only on the
        // discovered set, never as a blanket `.html` fallback of its own.
        expect((await fetch(`${origin}/halaman-yang-tidak-ada`)).status).toBe(404);
      } finally {
        served?.kill();
        await Promise.all([served?.exited, stub.stop()]);
      }
    },
    TIMEOUT_MS
  );
});
