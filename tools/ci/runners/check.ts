/**
 * runners/check.ts — the `check-<profile>` legs, reproducing
 * `.github/workflows/ci.yml`'s `check` job's steps exactly (see that file's
 * own comments for why each step exists).
 *
 * `check-toko` additionally runs the steps that job scopes to
 * `matrix.profile == 'toko'`: the bare root `bun test`, the four `audit:*`
 * gates, and `bun audit --audit-level=low`.
 */
import { join } from "node:path";
import { run } from "../lib/exec.ts";
import type { LegContext, LegOutcome } from "../lib/types.ts";

export type Profile = "toko" | "berita" | "landing";

export async function runCheckLeg(
  context: string,
  profile: Profile,
  ctx: LegContext
): Promise<LegOutcome> {
  const start = performance.now();
  const { worktreeRoot, evidenceDir } = ctx;
  const log = (name: string) => join(evidenceDir, `${name}.log`);

  const steps: Array<{ name: string; argv: string[]; env?: Record<string, string> }> = [
    { name: "check-lockfile", argv: ["bun", "run", "check:lockfile"] },
    { name: "install", argv: ["bun", "install", "--frozen-lockfile"] },
    {
      name: "typecheck",
      argv: ["bun", "run", "check"],
      env: { SITE_PROFILE: profile }
    },
    {
      name: "profile-build-smoke",
      argv: ["bun", "test", "tests/profil-build-smoke.test.ts", "tests/profil-routes.test.ts"],
      env: { SITE_PROFILE: profile }
    }
  ];

  if (profile === "toko") {
    steps.push(
      { name: "root-bun-test", argv: ["bun", "test"] },
      { name: "audit-dokumen", argv: ["bun", "run", "audit:dokumen"] },
      { name: "audit-translation", argv: ["bun", "run", "audit:translation"] },
      { name: "audit-graf", argv: ["bun", "run", "audit:graf"] },
      { name: "audit-rilis", argv: ["bun", "run", "audit:rilis"] },
      { name: "dependency-audit", argv: ["bun", "audit", "--audit-level=low"] }
    );
  }

  for (const step of steps) {
    // Steps 3+ (typecheck, profile-build-smoke) run inside apps/storefront,
    // matching ci.yml's own `cd apps/storefront` for the smoke-test step and
    // its bare `bun run check` (a root script that itself `cd`s there).
    const cwd = step.name === "profile-build-smoke" ? join(worktreeRoot, "apps", "storefront") : worktreeRoot;
    const result = await run(step.argv, {
      cwd,
      env: { ...process.env, ...step.env },
      logFile: log(step.name)
    });
    if (result.exitCode !== 0) {
      return {
        context,
        ok: false,
        summary: `${step.name} failed (exit ${result.exitCode})`,
        durationMs: performance.now() - start,
        evidenceDir
      };
    }
  }

  return {
    context,
    ok: true,
    summary: `${steps.length} step(s) green (SITE_PROFILE=${profile})`,
    durationMs: performance.now() - start,
    evidenceDir
  };
}
