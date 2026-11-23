import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TIMEOUT_EXIT_CODE,
  TIMEOUT_SCALE_ENV,
  describeFailure,
  run,
  runOrThrow,
  stepBudgetMs,
} from "../tools/ci/lib/exec.ts";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

describe("tools/ci/lib/exec.ts wall-clock timeout (issue #532)", () => {
  test("terminates the whole process group, including a child that ignores SIGTERM", async () => {
    // The shell prints its background child's PID, then itself ignores SIGTERM
    // and sleeps; the child inherits the ignored SIGTERM too.
    const started = Date.now();
    const result = await run(
      ["sh", "-c", "trap '' TERM; sleep 60 & echo $!; wait"],
      {
        timeoutMs: 300,
        killGraceMs: 200,
      },
    );
    const childPid = Number(result.stdout.trim().split("\n")[0]);
    expect(Number.isInteger(childPid)).toBe(true);

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(result.timeoutSeconds).toBe(0); // 300 ms rounds to 0 s; the message test below uses a whole second
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await waitGone(childPid)).toBe(true);
  });

  test("a step that finishes within budget is unaffected", async () => {
    const result = await run(
      ["sh", "-c", "echo hello; echo oops >&2; exit 3"],
      { timeoutMs: 10_000 },
    );
    expect(result.timedOut).toBeUndefined();
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("oops\n");
  });

  test("a step with no budget behaves as before", async () => {
    const result = await run(["sh", "-c", "echo ok"]);
    expect(result).toEqual({ exitCode: 0, stdout: "ok\n", stderr: "" });
  });

  test("the log file records that the step timed out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ci-exec-"));
    try {
      const logFile = join(dir, "step.log");
      await run(["sleep", "60"], { timeoutMs: 200, killGraceMs: 100, logFile });
      expect(existsSync(logFile)).toBe(true);
      expect(readFileSync(logFile, "utf8")).toContain("timed out after");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("describeFailure names the step and the budget for a timeout, the exit code otherwise", () => {
    expect(
      describeFailure("apps/cms bun run check", {
        exitCode: 124,
        stdout: "",
        stderr: "",
        timedOut: true,
        timeoutSeconds: 3600,
      }),
    ).toBe("apps/cms bun run check timed out after 3600 s");
    expect(
      describeFailure("db:migrate", { exitCode: 2, stdout: "", stderr: "" }),
    ).toBe("db:migrate failed (exit 2)");
  });

  test("runOrThrow reports the timeout instead of an exit code", async () => {
    await expect(
      runOrThrow(["sleep", "60"], { timeoutMs: 200, killGraceMs: 100 }),
    ).rejects.toThrow(/timed out after/);
  });
});

describe("stepBudgetMs", () => {
  test("defaults to the given minutes", () => {
    expect(stepBudgetMs(2, {})).toBe(120_000);
  });

  test("LOCAL_CI_TIMEOUT_SCALE multiplies it", () => {
    expect(stepBudgetMs(2, { [TIMEOUT_SCALE_ENV]: "2.5" })).toBe(300_000);
  });

  test("an empty value means the default", () => {
    expect(stepBudgetMs(1, { [TIMEOUT_SCALE_ENV]: "" })).toBe(60_000);
  });

  test("an invalid value throws instead of disabling the limit", () => {
    for (const bad of ["0", "-1", "abc", "NaN", "Infinity"]) {
      expect(() => stepBudgetMs(1, { [TIMEOUT_SCALE_ENV]: bad })).toThrow(
        TIMEOUT_SCALE_ENV,
      );
    }
  });
});
