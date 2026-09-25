/**
 * runners/check-cms.ts — the `local-ci/check-cms` leg, reproducing
 * `.github/workflows/ci.yml`'s `check-cms` job: `apps/cms`'s own full
 * `bun run check` chain with `DATABASE_URL=""` (every DB-gated suite
 * skips), then a real migrate and `tests/integration/` against a real,
 * ephemeral `postgres:18.4` — and the same before/after skip-count
 * assertion that job's own summary step makes, turned into a leg failure
 * instead of a job-summary note (a local run has no GitHub Step Summary to
 * write into).
 *
 * The container gets a unique name (a random suffix — this leg may run
 * concurrently with an unrelated one, or a previous run's container may not
 * have been removed cleanly) and a free host port (never the fixed 5432
 * ci.yml's own GitHub-hosted service container could claim exclusively,
 * since this leg may share a host with a developer's own `bun run db:up`
 * database on the usual 5433). It is removed on exit even on failure or
 * SIGINT via a `finally`/signal-handler pair — never left running.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { run, runOrThrow } from "../lib/exec.ts";
import { freePort } from "../lib/net.ts";
import type { LegContext, LegOutcome } from "../lib/types.ts";

const POSTGRES_USER = "awcms";
const POSTGRES_PASSWORD = "awcms_local_ci_password";
const POSTGRES_DB = "awcms";

function skipCount(text: string): number {
  const match = /(\d+)\s+skip\s*$/m.exec(text.trim());
  return match ? Number.parseInt(match[1], 10) : 0;
}

export async function runCheckCmsLeg(context: string, ctx: LegContext): Promise<LegOutcome> {
  const start = performance.now();
  const { worktreeRoot, evidenceDir } = ctx;
  const log = (name: string) => join(evidenceDir, `${name}.log`);
  const containerName = `awcms-one-ci-check-cms-${randomBytes(4).toString("hex")}`;
  const port = await freePort();
  const cmsDir = join(worktreeRoot, "apps", "cms");

  let containerStarted = false;
  const removeContainer = () => {
    if (!containerStarted) return;
    Bun.spawnSync(["docker", "rm", "-f", containerName], { stdout: "ignore", stderr: "ignore" });
  };
  const onSignal = () => {
    removeContainer();
    process.exit(1);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await runOrThrow(
      [
        "docker",
        "run",
        "-d",
        "--name",
        containerName,
        "-e",
        `POSTGRES_USER=${POSTGRES_USER}`,
        "-e",
        `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
        "-e",
        `POSTGRES_DB=${POSTGRES_DB}`,
        "-p",
        `127.0.0.1:${port}:5432`,
        "postgres:18.4"
      ],
      { logFile: log("docker-run") }
    );
    containerStarted = true;

    const ready = await waitForPostgres(containerName);
    if (!ready) {
      return fail("postgres:18.4 did not become ready within the health-check budget");
    }

    const install = await run(["bun", "install", "--frozen-lockfile"], {
      cwd: worktreeRoot,
      logFile: log("install")
    });
    if (install.exitCode !== 0) return fail(`bun install failed (exit ${install.exitCode})`);

    const quality = await run(["bun", "run", "check"], {
      cwd: cmsDir,
      env: { ...process.env, DATABASE_URL: "" },
      logFile: log("quality")
    });
    if (quality.exitCode !== 0) return fail(`apps/cms bun run check failed (exit ${quality.exitCode})`);
    const before = skipCount(quality.stdout + quality.stderr);

    const databaseUrl = `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}`;

    const migrate = await run(["bun", "run", "db:migrate"], {
      cwd: cmsDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      logFile: log("migrate")
    });
    if (migrate.exitCode !== 0) return fail(`db:migrate failed (exit ${migrate.exitCode})`);

    const integration = await run(["bun", "test", "tests/integration/", "--timeout", "60000"], {
      cwd: cmsDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      logFile: log("integration")
    });
    if (integration.exitCode !== 0) return fail(`tests/integration/ failed (exit ${integration.exitCode})`);
    const after = skipCount(integration.stdout + integration.stderr);

    if (!(after < before)) {
      return fail(
        `DB-gated skip count did not drop (${before} -> ${after}) — this leg is not exercising the database it provisions`
      );
    }

    return {
      context,
      ok: true,
      summary: `quality + integration green; DB-gated skips dropped ${before} -> ${after}`,
      durationMs: performance.now() - start,
      evidenceDir
    };
  } catch (error) {
    return fail((error as Error).message);
  } finally {
    removeContainer();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  function fail(summary: string): LegOutcome {
    return { context, ok: false, summary, durationMs: performance.now() - start, evidenceDir };
  }
}

async function waitForPostgres(containerName: string, attempts = 60): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const result = Bun.spawnSync(["docker", "exec", containerName, "pg_isready", "-U", POSTGRES_USER, "-d", POSTGRES_DB], {
      stdout: "ignore",
      stderr: "ignore"
    });
    if (result.exitCode === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}
