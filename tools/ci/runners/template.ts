/**
 * runners/template.ts — the `template-<profile>` and `template-root` legs,
 * reproducing `.github/workflows/template-init-smoke.yml` exactly: run
 * `bun run template:init` for real against a disposable checkout, start the
 * storefront's own stub CMS, build that profile against it, then assert the
 * built `dist/` matches `src/config/profil.ts` — and, for `template-root`
 * only, the full root `bun test` (issue #147's `root-suite` split).
 *
 * Each leg gets its OWN `STUB_PORT` (a free host port, not the workflow's
 * fixed `4310`) so that concurrent legs — this runner does not itself force
 * concurrency 1 at this layer, the CLI's scheduler does — never collide on
 * the same port the way a fixed one would.
 */
import { join } from "node:path";
import { run } from "../lib/exec.ts";
import { freePort } from "../lib/net.ts";
import type { LegContext, LegOutcome } from "../lib/types.ts";
import type { Profile } from "./check.ts";

async function templateInit(worktreeRoot: string, profile: Profile, label: string, logFile: string) {
  return run(
    [
      "bun",
      "run",
      "template:init",
      "--nama",
      `Toko Contoh ${label}`,
      "--slug",
      `toko-contoh-${label.toLowerCase().replace(/\s+/g, "-")}`,
      "--domain",
      `toko-contoh-${label.toLowerCase().replace(/\s+/g, "-")}.id`,
      "--profil",
      profile,
      "--warna-primer",
      "#0ea5e9",
      "--kontak-email",
      "owner@toko-contoh.id",
      "--yes"
    ],
    { cwd: worktreeRoot, env: { ...process.env, TEMPLATE_INIT_TEST_SCOPE: "root" }, logFile }
  );
}

async function startStub(storefrontDir: string, port: number, logFile: string): Promise<{ proc: ReturnType<typeof Bun.spawn>; ok: boolean }> {
  const proc = Bun.spawn(["bun", "scripts/stub-awcms.mjs"], {
    cwd: storefrontDir,
    env: { ...process.env, STUB_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe"
  });

  let output = "";
  (async () => {
    for await (const chunk of proc.stdout) output += new TextDecoder().decode(chunk);
  })();
  (async () => {
    for await (const chunk of proc.stderr) output += new TextDecoder().decode(chunk);
  })();

  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/commerce/products`, {
        headers: { Authorization: "Bearer stub" }
      });
      if (response.ok || response.status < 500) {
        await Bun.write(logFile, output);
        return { proc, ok: true };
      }
    } catch {
      // Not up yet.
    }
    if (proc.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await Bun.write(logFile, output);
  return { proc, ok: false };
}

export async function runTemplateLeg(context: string, profile: Profile, ctx: LegContext): Promise<LegOutcome> {
  const start = performance.now();
  const { worktreeRoot, evidenceDir } = ctx;
  const log = (name: string) => join(evidenceDir, `${name}.log`);
  const storefrontDir = join(worktreeRoot, "apps", "storefront");

  const init = await templateInit(worktreeRoot, profile, profile, log("template-init"));
  if (init.exitCode !== 0) return fail(`template:init --profil ${profile} failed`);

  const port = await freePort();
  const { proc: stubProc, ok: stubOk } = await startStub(storefrontDir, port, log("stub"));
  if (!stubOk) {
    stubProc.kill();
    return fail("stub CMS did not answer in time");
  }

  try {
    const build = await run(["bun", "run", "build"], {
      cwd: storefrontDir,
      env: {
        ...process.env,
        SITE_PROFILE: profile,
        AWCMS_API_URL: `http://127.0.0.1:${port}`,
        AWCMS_API_TOKEN: "stub-token",
        SITE_URL: "http://localhost:4321",
        PUBLIC_AWCMS_ORIGIN: "https://cms.example.com"
      },
      logFile: log("build")
    });
    if (build.exitCode !== 0) return fail(`build failed (exit ${build.exitCode})`);

    const assertDist = await run(["bun", "scripts/assert-profil-dist.ts"], {
      cwd: storefrontDir,
      env: { ...process.env, SITE_PROFILE: profile },
      logFile: log("assert-profil-dist")
    });
    if (assertDist.exitCode !== 0) return fail(`assert-profil-dist failed (exit ${assertDist.exitCode})`);

    return {
      context,
      ok: true,
      summary: `template:init + build + dist assertions green (${profile})`,
      durationMs: performance.now() - start,
      evidenceDir
    };
  } finally {
    stubProc.kill();
  }

  function fail(summary: string): LegOutcome {
    stubProc.kill();
    return { context, ok: false, summary, durationMs: performance.now() - start, evidenceDir };
  }
}

/** `template-root`: `bun run template:init --profil toko`, then the full root `bun test`, exactly once (issue #147's `root-suite`). */
export async function runTemplateRootLeg(context: string, ctx: LegContext): Promise<LegOutcome> {
  const start = performance.now();
  const { worktreeRoot, evidenceDir } = ctx;
  const log = (name: string) => join(evidenceDir, `${name}.log`);

  const init = await templateInit(worktreeRoot, "toko", "Root Suite", log("template-init"));
  if (init.exitCode !== 0) {
    return { context, ok: false, summary: "template:init --profil toko failed", durationMs: performance.now() - start, evidenceDir };
  }

  const test = await run(["bun", "test"], { cwd: worktreeRoot, logFile: log("root-bun-test") });
  if (test.exitCode !== 0) {
    return { context, ok: false, summary: `root bun test failed (exit ${test.exitCode})`, durationMs: performance.now() - start, evidenceDir };
  }

  return { context, ok: true, summary: "template:init + full root bun test green", durationMs: performance.now() - start, evidenceDir };
}
